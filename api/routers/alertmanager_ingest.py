"""G34 Alertmanager Source — config management + ingest webhook."""

from __future__ import annotations

import hashlib
import secrets
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/sources/alertmanager", tags=["alertmanager"])

_SEVERITY_MAP = {
    "critical": "critical",
    "error": "critical",
    "warning": "warning",
    "warn": "warning",
    "info": "info",
    "none": "ok",
    "ok": "ok",
}


def _require_tenant(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="unauthenticated")
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


def _token_hash(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


# ── Config endpoints (require tenant auth) ─────────────────────────────────


class CreateSource(BaseModel):
    display_name: str


@router.get("")
async def list_sources(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT source_id, display_name, enabled, created_at, updated_at
              FROM g1.alertmanager_source_config
             WHERE tenant_id = %s
             ORDER BY created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_source(request: Request, body: CreateSource) -> dict:
    tenant_id = _require_tenant(request)
    name = body.display_name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="display_name is required")
    if len(name) > 120:
        raise HTTPException(status_code=422, detail="display_name max 120 chars")

    source_id = f"amgr:{uuid.uuid4()}"
    raw_token = secrets.token_hex(32)
    token_hash = _token_hash(raw_token)

    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.alertmanager_source_config
                (source_id, tenant_id, display_name, token_hash)
            VALUES (%s, %s, %s, %s)
            """,
            (source_id, tenant_id, name, token_hash),
        )
        await conn.commit()

    return {
        "source_id": source_id,
        "display_name": name,
        "token": raw_token,  # returned ONCE; caller must store it
        "enabled": True,
    }


@router.post("/{source_id}/rotate-token", status_code=status.HTTP_200_OK)
async def rotate_token(request: Request, source_id: str) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT source_id FROM g1.alertmanager_source_config "
            "WHERE tenant_id=%s AND source_id=%s",
            (tenant_id, source_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="source not found")

        raw_token = secrets.token_hex(32)
        token_hash = _token_hash(raw_token)
        await conn.execute(
            "UPDATE g1.alertmanager_source_config "
            "SET token_hash=%s, updated_at=now() "
            "WHERE tenant_id=%s AND source_id=%s",
            (token_hash, tenant_id, source_id),
        )
        await conn.commit()

    return {"source_id": source_id, "token": raw_token}


@router.delete("/{source_id}", status_code=status.HTTP_204_NO_CONTENT)
async def disable_source(request: Request, source_id: str) -> Response:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT source_id FROM g1.alertmanager_source_config "
            "WHERE tenant_id=%s AND source_id=%s",
            (tenant_id, source_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="source not found")
        await conn.execute(
            "UPDATE g1.alertmanager_source_config "
            "SET enabled=false, updated_at=now() "
            "WHERE tenant_id=%s AND source_id=%s",
            (tenant_id, source_id),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("/{source_id}/events")
async def list_events(request: Request, source_id: str) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT source_id FROM g1.alertmanager_source_config "
            "WHERE tenant_id=%s AND source_id=%s",
            (tenant_id, source_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="source not found")
        rows = await conn.execute(
            """
            SELECT event_id, fingerprint, alert_name, severity, status,
                   labels, annotations, starts_at, ends_at, received_at
              FROM g1.alertmanager_event
             WHERE source_id = %s AND tenant_id = %s
             ORDER BY received_at DESC
             LIMIT 200
            """,
            (source_id, tenant_id),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


# ── Public ingest endpoint (token auth, no BFF/session) ───────────────────


@router.post("/{source_id}/ingest", status_code=status.HTTP_200_OK)
async def alertmanager_ingest(source_id: str, request: Request) -> dict:
    """Alertmanager webhook receiver.

    Authentication: X-JLM-Webhook-Secret header must match the stored
    SHA-256 token hash for this source.  No BFF session is required.
    """
    provided = request.headers.get("X-JLM-Webhook-Secret", "")
    if not provided:
        return JSONResponse({"state": "unauthorized"},
                            status_code=status.HTTP_401_UNAUTHORIZED)

    provided_hash = _token_hash(provided)

    async with db_connection() as conn:
        row = await conn.execute(
            """
            SELECT source_id, tenant_id, token_hash, enabled
              FROM g1.alertmanager_source_config
             WHERE source_id = %s
            """,
            (source_id,),
        )
        config = await row.fetchone()

    if config is None or not config[3]:  # not found or disabled
        return JSONResponse({"state": "unauthorized"},
                            status_code=status.HTTP_401_UNAUTHORIZED)

    stored_hash = config[2]
    if not secrets.compare_digest(provided_hash, stored_hash):
        return JSONResponse({"state": "unauthorized"},
                            status_code=status.HTTP_401_UNAUTHORIZED)

    tenant_id: str = config[1]

    body = await request.body()
    if len(body) > 1_048_576:  # 1 MB
        raise HTTPException(status_code=413, detail="payload too large")
    try:
        import json as _json
        payload: dict[str, Any] = _json.loads(body)
    except Exception:
        raise HTTPException(status_code=400, detail="invalid JSON")

    alerts: list[dict] = payload.get("alerts", [])
    if len(alerts) > 500:
        raise HTTPException(status_code=400,
                            detail="too many alerts in a single batch (max 500)")
    upserted = 0

    async with db_tenant_connection(tenant_id) as conn:
        for alert in alerts:
            fingerprint: str = alert.get("fingerprint", "")
            if not fingerprint:
                continue

            labels: dict = alert.get("labels", {})
            annotations: dict = alert.get("annotations", {})
            alert_name: str = labels.get("alertname", fingerprint)
            raw_severity: str = labels.get("severity", "warning").lower()
            severity: str = _SEVERITY_MAP.get(raw_severity, "warning")
            alert_status: str = alert.get("status", "firing")
            if alert_status not in ("firing", "resolved"):
                alert_status = "firing"

            starts_at_raw = alert.get("startsAt")
            ends_at_raw = alert.get("endsAt")

            import json as _json
            event_id = f"amev:{uuid.uuid4()}"
            await conn.execute(
                """
                INSERT INTO g1.alertmanager_event
                    (event_id, source_id, tenant_id, fingerprint,
                     alert_name, severity, status, labels, annotations,
                     starts_at, ends_at)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s::jsonb,
                        %s::timestamptz, %s::timestamptz)
                ON CONFLICT (source_id, fingerprint) DO UPDATE SET
                    event_id    = EXCLUDED.event_id,
                    alert_name  = EXCLUDED.alert_name,
                    severity    = EXCLUDED.severity,
                    status      = EXCLUDED.status,
                    labels      = EXCLUDED.labels,
                    annotations = EXCLUDED.annotations,
                    starts_at   = EXCLUDED.starts_at,
                    ends_at     = EXCLUDED.ends_at,
                    received_at = now()
                """,
                (
                    event_id, source_id, tenant_id, fingerprint,
                    alert_name, severity, alert_status,
                    _json.dumps(labels), _json.dumps(annotations),
                    starts_at_raw, ends_at_raw,
                ),
            )
            upserted += 1
        await conn.commit()

    return {"accepted": upserted, "source_id": source_id}
