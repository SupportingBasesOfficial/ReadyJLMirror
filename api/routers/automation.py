"""G32 Automation Runtime API."""

from __future__ import annotations

import json
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/automation", tags=["automation"])

_VALID_TYPES = {"webhook", "noop"}


class CreateScript(BaseModel):
    name: str
    description: str = ""
    script_type: str = "noop"
    config: dict = {}


class UpdateScript(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    script_type: Optional[str] = None
    config: Optional[dict] = None
    enabled: Optional[bool] = None


class CreateSchedule(BaseModel):
    script_id: str
    interval_secs: int


def _require_tenant(request: Request) -> str:
    tid = request.state.jlmirror_context.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


# ── Scripts ───────────────────────────────────────────────────────────────────

@router.get("/scripts")
async def list_scripts(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT script_id, name, description, script_type, enabled,
                   created_at, updated_at
              FROM g1.automation_script
             WHERE tenant_id = %s
             ORDER BY created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/scripts", status_code=status.HTTP_201_CREATED)
async def create_script(request: Request, body: CreateScript) -> dict:
    tenant_id = _require_tenant(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if len(name) > 120:
        raise HTTPException(status_code=422, detail="name max 120 chars")
    if body.script_type not in _VALID_TYPES:
        raise HTTPException(status_code=422,
                            detail=f"script_type must be one of {sorted(_VALID_TYPES)}")
    if body.script_type == "webhook":
        url = body.config.get("url", "").strip()
        if not url.startswith("https://"):
            raise HTTPException(status_code=422,
                                detail="webhook config.url must be an https:// URL")

    script_id = f"auto:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.automation_script
                (script_id, tenant_id, name, description, script_type, config)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (script_id, tenant_id, name, body.description,
             body.script_type, json.dumps(body.config)),
        )
        await conn.commit()
    return {"script_id": script_id, "name": name, "script_type": body.script_type}


@router.put("/scripts/{script_id}")
async def update_script(request: Request, script_id: str,
                        body: UpdateScript) -> dict:
    tenant_id = _require_tenant(request)
    if body.script_type and body.script_type not in _VALID_TYPES:
        raise HTTPException(status_code=422,
                            detail=f"script_type must be one of {sorted(_VALID_TYPES)}")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT script_id FROM g1.automation_script "
            "WHERE tenant_id=%s AND script_id=%s",
            (tenant_id, script_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="script not found")

        sets, vals = [], []
        for field in ("name", "description", "script_type", "enabled"):
            v = getattr(body, field)
            if v is not None:
                sets.append(f"{field} = %s")
                vals.append(v)
        if body.config is not None:
            sets.append("config = %s")
            vals.append(json.dumps(body.config))
        if not sets:
            return {"script_id": script_id, "updated": False}
        sets.append("updated_at = now()")
        vals.extend([tenant_id, script_id])
        await conn.execute(
            f"UPDATE g1.automation_script SET {', '.join(sets)} "
            f"WHERE tenant_id=%s AND script_id=%s",
            vals,
        )
        await conn.commit()
    return {"script_id": script_id, "updated": True}


# ── Manual trigger ─────────────────────────────────────────────────────────────

@router.post("/scripts/{script_id}/trigger", status_code=status.HTTP_202_ACCEPTED)
async def trigger_script(request: Request, script_id: str) -> dict:
    """Queue a manual run. Actual execution is on the next worker tick."""
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT script_id, enabled FROM g1.automation_script "
            "WHERE tenant_id=%s AND script_id=%s",
            (tenant_id, script_id),
        )
        r = await row.fetchone()
        if r is None:
            raise HTTPException(status_code=404, detail="script not found")
        if not r[1]:
            raise HTTPException(status_code=409, detail="script is disabled")

        run_id = f"arun:{secrets.token_urlsafe(16)}"
        now = datetime.now(timezone.utc)
        await conn.execute(
            """
            INSERT INTO g1.automation_run
                (run_id, tenant_id, script_id, trigger_type, outcome, started_at)
            VALUES (%s, %s, %s, 'manual', 'pending', %s)
            """,
            (run_id, tenant_id, script_id, now),
        )
        await conn.commit()
    return {"run_id": run_id, "queued": True}


# ── Schedules ─────────────────────────────────────────────────────────────────

@router.get("/schedules")
async def list_schedules(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT sc.schedule_id, sc.script_id, s.name AS script_name,
                   sc.interval_secs, sc.last_run_at, sc.next_run_at,
                   sc.enabled, sc.created_at
              FROM g1.automation_schedule sc
              JOIN g1.automation_script s ON s.script_id = sc.script_id
             WHERE sc.tenant_id = %s
             ORDER BY sc.created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/schedules", status_code=status.HTTP_201_CREATED)
async def create_schedule(request: Request, body: CreateSchedule) -> dict:
    tenant_id = _require_tenant(request)
    if body.interval_secs < 60:
        raise HTTPException(status_code=422,
                            detail="interval_secs must be at least 60")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT script_id FROM g1.automation_script "
            "WHERE tenant_id=%s AND script_id=%s AND enabled=true",
            (tenant_id, body.script_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404,
                                detail="script not found or disabled")

        schedule_id = f"asched:{uuid.uuid4()}"
        await conn.execute(
            """
            INSERT INTO g1.automation_schedule
                (schedule_id, tenant_id, script_id, interval_secs)
            VALUES (%s, %s, %s, %s)
            """,
            (schedule_id, tenant_id, body.script_id, body.interval_secs),
        )
        await conn.commit()
    return {"schedule_id": schedule_id, "script_id": body.script_id}


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(request: Request, schedule_id: str) -> Response:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT schedule_id FROM g1.automation_schedule "
            "WHERE tenant_id=%s AND schedule_id=%s",
            (tenant_id, schedule_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        await conn.execute(
            "UPDATE g1.automation_schedule SET enabled=false "
            "WHERE schedule_id=%s",
            (schedule_id,),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Run history ───────────────────────────────────────────────────────────────

@router.get("/runs")
async def list_runs(request: Request, script_id: Optional[str] = None) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        if script_id:
            rows = await conn.execute(
                """
                SELECT run_id, script_id, trigger_type, outcome,
                       http_status, error_detail, started_at, finished_at
                  FROM g1.automation_run
                 WHERE tenant_id=%s AND script_id=%s
                 ORDER BY created_at DESC LIMIT 100
                """,
                (tenant_id, script_id),
            )
        else:
            rows = await conn.execute(
                """
                SELECT run_id, script_id, trigger_type, outcome,
                       http_status, error_detail, started_at, finished_at
                  FROM g1.automation_run
                 WHERE tenant_id=%s
                 ORDER BY created_at DESC LIMIT 100
                """,
                (tenant_id,),
            )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]
