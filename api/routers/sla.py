"""G31 SLA Management API."""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/sla", tags=["sla"])


class CreateSLA(BaseModel):
    name: str
    severity_match: Optional[str] = None
    response_secs: int
    resolve_secs: int


class UpdateSLA(BaseModel):
    name: Optional[str] = None
    severity_match: Optional[str] = None
    response_secs: Optional[int] = None
    resolve_secs: Optional[int] = None
    enabled: Optional[bool] = None


def _require_tenant(request: Request) -> str:
    tid = request.state.jlmirror_context.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


# ── SLA policies ──────────────────────────────────────────────────────────────

@router.get("/policies")
async def list_policies(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT sla_id, name, severity_match, response_secs,
                   resolve_secs, enabled, created_at, updated_at
              FROM g1.sla_policy
             WHERE tenant_id = %s
             ORDER BY created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/policies", status_code=status.HTTP_201_CREATED)
async def create_policy(request: Request, body: CreateSLA) -> dict:
    tenant_id = _require_tenant(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if len(name) > 120:
        raise HTTPException(status_code=422, detail="name max 120 chars")
    if body.response_secs <= 0 or body.resolve_secs <= 0:
        raise HTTPException(status_code=422, detail="SLA times must be positive")

    sla_id = f"sla:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.sla_policy
                (sla_id, tenant_id, name, severity_match,
                 response_secs, resolve_secs)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (sla_id, tenant_id, name, body.severity_match,
             body.response_secs, body.resolve_secs),
        )
        await conn.commit()
    return {"sla_id": sla_id, "name": name}


@router.put("/policies/{sla_id}")
async def update_policy(request: Request, sla_id: str, body: UpdateSLA) -> dict:
    tenant_id = _require_tenant(request)
    if body.response_secs is not None and body.response_secs <= 0:
        raise HTTPException(status_code=422, detail="response_secs must be positive")
    if body.resolve_secs is not None and body.resolve_secs <= 0:
        raise HTTPException(status_code=422, detail="resolve_secs must be positive")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT sla_id FROM g1.sla_policy WHERE tenant_id=%s AND sla_id=%s",
            (tenant_id, sla_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="SLA policy not found")

        sets, vals = [], []
        for field in ("name", "severity_match", "response_secs",
                      "resolve_secs", "enabled"):
            v = getattr(body, field)
            if v is not None:
                sets.append(f"{field} = %s")
                vals.append(v)
        if not sets:
            return {"sla_id": sla_id, "updated": False}
        sets.append("updated_at = now()")
        vals.extend([tenant_id, sla_id])
        await conn.execute(
            f"UPDATE g1.sla_policy SET {', '.join(sets)} "
            f"WHERE tenant_id=%s AND sla_id=%s",
            vals,
        )
        await conn.commit()
    return {"sla_id": sla_id, "updated": True}


@router.delete("/policies/{sla_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_policy(request: Request, sla_id: str) -> Response:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT sla_id FROM g1.sla_policy WHERE tenant_id=%s AND sla_id=%s",
            (tenant_id, sla_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="SLA policy not found")
        await conn.execute(
            "UPDATE g1.sla_policy SET enabled=false, updated_at=now() "
            "WHERE tenant_id=%s AND sla_id=%s",
            (tenant_id, sla_id),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── SLA tracker / breach query ─────────────────────────────────────────────────

@router.get("/trackers")
async def list_trackers(request: Request) -> list:
    """Active SLA trackers (unresolved alerts with SLA attached)."""
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT t.tracker_id, t.alert_id, t.sla_id, p.name AS sla_name,
                   t.alert_fired_at, t.response_deadline, t.resolve_deadline,
                   t.acknowledged_at, t.resolved_at,
                   t.response_breached, t.resolve_breached
              FROM g1.sla_alert_tracker t
              JOIN g1.sla_policy p ON p.sla_id = t.sla_id
             WHERE t.tenant_id = %s
               AND t.resolved_at IS NULL
             ORDER BY t.alert_fired_at DESC
             LIMIT 200
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.get("/breaches")
async def list_breaches(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT b.breach_id, b.alert_id, b.sla_id, p.name AS sla_name,
                   b.breach_type, b.breached_at, b.deadline_was
              FROM g1.sla_breach b
              JOIN g1.sla_policy p ON p.sla_id = b.sla_id
             WHERE b.tenant_id = %s
             ORDER BY b.breached_at DESC
             LIMIT 200
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]
