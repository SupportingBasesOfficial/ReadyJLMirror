"""Webhooks de saída — CRUD de endpoints, dispatch com HMAC-SHA256, delivery history."""
from __future__ import annotations

import hashlib
import hmac
import json
import time
import uuid
from typing import Optional

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator

from shared import access
from shared.audit import record_audit_event
from shared.db import db_connection
from shared.ssrf import validate_outbound_url

router = APIRouter(prefix="/api/v1/webhooks", tags=["webhooks"])

VALID_EVENT_TYPES = {
    "alert.triggered",
    "alert.resolved",
    "incident.opened",
    "incident.closed",
    "automation.run.succeeded",
    "automation.run.failed",
}
DISPATCH_TIMEOUT = 10.0
MAX_RESPONSE_BODY = 2048


def _require_ctx(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    pid = ctx.get("principal_id")
    if not tid or not pid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid, pid


async def _require_operate(request: Request) -> tuple[str, str]:
    tid, pid = _require_ctx(request)
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, pid, tid)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")
    return tid, pid


def _sign_payload(secret: str, body: bytes) -> str:
    """HMAC-SHA256 signature — header format: sha256=<hex>"""
    return "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()


async def _dispatch(conn, endpoint_id: str, tenant_id: str, event_type: str, payload: dict) -> dict:
    """Send payload to webhook URL and record delivery. Returns delivery record."""
    cur = await conn.execute(
        "SELECT url, secret, enabled FROM g1.webhook_endpoint WHERE endpoint_id = %s AND tenant_id = %s",
        (endpoint_id, tenant_id),
    )
    row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="endpoint not found")
    url, secret, enabled = row

    ssrf_err = validate_outbound_url(url)
    if ssrf_err:
        raise HTTPException(status_code=422, detail=f"webhook URL rejected: {ssrf_err}")

    body = json.dumps({
        "event_type": event_type,
        "tenant_id": tenant_id,
        "timestamp": int(time.time()),
        "delivery_id": str(uuid.uuid4()),
        "data": payload,
    }, ensure_ascii=False).encode()

    signature = _sign_payload(secret, body)
    status = "failed"
    response_code = None
    response_body = None

    try:
        async with httpx.AsyncClient(timeout=DISPATCH_TIMEOUT, follow_redirects=False) as client:
            resp = await client.post(
                url,
                content=body,
                headers={
                    "Content-Type": "application/json",
                    "X-JLMirror-Signature": signature,
                    "X-JLMirror-Event": event_type,
                    "User-Agent": "JLMirror-Webhook/1.0",
                },
            )
        response_code = resp.status_code
        response_body = resp.text[:MAX_RESPONSE_BODY]
        if 200 <= resp.status_code < 300:
            status = "success"
    except httpx.TimeoutException:
        response_body = "timeout"
    except Exception as exc:  # noqa: BLE001
        response_body = str(exc)[:MAX_RESPONSE_BODY]

    cur2 = await conn.execute(
        """
        INSERT INTO g1.webhook_delivery
            (endpoint_id, tenant_id, event_type, payload, status, response_code, response_body,
             attempt_count, delivered_at)
        VALUES (%s, %s, %s, %s::jsonb, %s, %s, %s, 1, CASE WHEN %s = 'success' THEN now() ELSE NULL END)
        RETURNING delivery_id, created_at
        """,
        (
            endpoint_id, tenant_id, event_type, json.dumps(payload),
            status, response_code, response_body, status,
        ),
    )
    row2 = await cur2.fetchone()
    return {
        "delivery_id": str(row2[0]),
        "status": status,
        "response_code": response_code,
        "response_body": response_body,
        "created_at": row2[1].isoformat(),
    }


# ---------------------------------------------------------------------------
# Models

class WebhookEndpointCreate(BaseModel):
    name: str
    url: str
    secret: str
    event_types: list[str] = list(VALID_EVENT_TYPES)
    enabled: bool = True

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: str) -> str:
        err = validate_outbound_url(v)
        if err:
            raise ValueError(err)
        return v

    @field_validator("event_types")
    @classmethod
    def validate_events(cls, v: list[str]) -> list[str]:
        invalid = set(v) - VALID_EVENT_TYPES
        if invalid:
            raise ValueError(f"unknown event types: {sorted(invalid)}")
        if not v:
            raise ValueError("at least one event type required")
        return v

    @field_validator("secret")
    @classmethod
    def validate_secret(cls, v: str) -> str:
        if len(v) < 16:
            raise ValueError("secret must be at least 16 characters")
        return v

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be empty")
        return v.strip()


class WebhookEndpointUpdate(BaseModel):
    name: Optional[str] = None
    url: Optional[str] = None
    secret: Optional[str] = None
    event_types: Optional[list[str]] = None
    enabled: Optional[bool] = None

    @field_validator("url")
    @classmethod
    def validate_url(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            err = validate_outbound_url(v)
            if err:
                raise ValueError(err)
        return v

    @field_validator("event_types")
    @classmethod
    def validate_events(cls, v: Optional[list[str]]) -> Optional[list[str]]:
        if v is not None:
            invalid = set(v) - VALID_EVENT_TYPES
            if invalid:
                raise ValueError(f"unknown event types: {sorted(invalid)}")
            if not v:
                raise ValueError("at least one event type required")
        return v


# ---------------------------------------------------------------------------
# Endpoints

@router.get("")
async def list_endpoints(request: Request) -> list[dict]:
    tid, pid = _require_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT e.endpoint_id, e.name, e.url, e.event_types, e.enabled, e.created_at,
                   d.status AS last_status, d.created_at AS last_delivery_at
            FROM g1.webhook_endpoint e
            LEFT JOIN LATERAL (
                SELECT status, created_at FROM g1.webhook_delivery
                WHERE endpoint_id = e.endpoint_id
                ORDER BY created_at DESC LIMIT 1
            ) d ON TRUE
            WHERE e.tenant_id = %s
            ORDER BY e.created_at DESC
            """,
            (tid,),
        )
        rows = await cur.fetchall()
    return [
        {
            "endpoint_id": str(r[0]),
            "name": r[1],
            "url": r[2],
            "event_types": list(r[3]),
            "enabled": r[4],
            "created_at": r[5].isoformat(),
            "last_status": r[6],
            "last_delivery_at": r[7].isoformat() if r[7] else None,
        }
        for r in rows
    ]


@router.post("", status_code=201)
async def create_endpoint(request: Request, body: WebhookEndpointCreate) -> dict:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.webhook_endpoint
                (tenant_id, name, url, secret, event_types, enabled, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            RETURNING endpoint_id, created_at
            """,
            (tid, body.name, body.url, body.secret, body.event_types, body.enabled, pid),
        )
        row = await cur.fetchone()
        await record_audit_event(conn, pid, tid, "webhook_endpoint.created",
                                 {"endpoint_id": str(row[0]), "name": body.name, "url": body.url})
    return {"endpoint_id": str(row[0]), "created_at": row[1].isoformat()}


@router.get("/{endpoint_id}")
async def get_endpoint(request: Request, endpoint_id: str) -> dict:
    tid, _ = _require_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT endpoint_id, name, url, event_types, enabled, created_at, created_by "
            "FROM g1.webhook_endpoint WHERE endpoint_id = %s AND tenant_id = %s",
            (endpoint_id, tid),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    return {
        "endpoint_id": str(row[0]),
        "name": row[1],
        "url": row[2],
        "event_types": list(row[3]),
        "enabled": row[4],
        "created_at": row[5].isoformat(),
        "created_by": row[6],
    }


@router.put("/{endpoint_id}")
async def update_endpoint(request: Request, endpoint_id: str, body: WebhookEndpointUpdate) -> dict:
    tid, pid = await _require_operate(request)
    updates: list[str] = []
    params: list = []

    if body.name is not None:
        updates.append("name = %s"); params.append(body.name)
    if body.url is not None:
        updates.append("url = %s"); params.append(body.url)
    if body.secret is not None:
        updates.append("secret = %s"); params.append(body.secret)
    if body.event_types is not None:
        updates.append("event_types = %s"); params.append(body.event_types)
    if body.enabled is not None:
        updates.append("enabled = %s"); params.append(body.enabled)

    if not updates:
        raise HTTPException(status_code=422, detail="nothing to update")

    params.extend([endpoint_id, tid])
    async with db_connection() as conn:
        cur = await conn.execute(
            f"UPDATE g1.webhook_endpoint SET {', '.join(updates)} "
            "WHERE endpoint_id = %s AND tenant_id = %s RETURNING endpoint_id",
            params,
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="not found")
        await record_audit_event(conn, pid, tid, "webhook_endpoint.updated",
                                 {"endpoint_id": endpoint_id, **body.model_dump(exclude_none=True)})
    return {"endpoint_id": str(row[0])}


@router.delete("/{endpoint_id}", status_code=204)
async def delete_endpoint(request: Request, endpoint_id: str) -> None:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM g1.webhook_endpoint WHERE endpoint_id = %s AND tenant_id = %s RETURNING endpoint_id",
            (endpoint_id, tid),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="not found")
        await record_audit_event(conn, pid, tid, "webhook_endpoint.deleted", {"endpoint_id": endpoint_id})


@router.post("/{endpoint_id}/test")
async def test_endpoint(request: Request, endpoint_id: str) -> dict:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        result = await _dispatch(conn, endpoint_id, tid, "test.ping", {
            "message": "Test dispatch from JLMirror",
            "triggered_by": pid,
        })
        await record_audit_event(conn, pid, tid, "webhook_endpoint.tested",
                                 {"endpoint_id": endpoint_id, "status": result["status"]})
    return result


@router.get("/{endpoint_id}/deliveries")
async def list_deliveries(request: Request, endpoint_id: str) -> list[dict]:
    tid, _ = _require_ctx(request)
    async with db_connection() as conn:
        # verify ownership
        cur = await conn.execute(
            "SELECT 1 FROM g1.webhook_endpoint WHERE endpoint_id = %s AND tenant_id = %s",
            (endpoint_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="not found")

        cur2 = await conn.execute(
            """
            SELECT delivery_id, event_type, status, response_code, response_body,
                   attempt_count, delivered_at, created_at
            FROM g1.webhook_delivery
            WHERE endpoint_id = %s
            ORDER BY created_at DESC
            LIMIT 50
            """,
            (endpoint_id,),
        )
        rows = await cur2.fetchall()
    return [
        {
            "delivery_id": str(r[0]),
            "event_type": r[1],
            "status": r[2],
            "response_code": r[3],
            "response_body": r[4],
            "attempt_count": r[5],
            "delivered_at": r[6].isoformat() if r[6] else None,
            "created_at": r[7].isoformat(),
        }
        for r in rows
    ]
