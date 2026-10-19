"""G38 On-call scheduling — named rotations with time-bounded shifts."""

from __future__ import annotations

import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/oncall", tags=["oncall"])

_TIMEZONES = {
    "UTC", "America/Sao_Paulo", "America/New_York", "America/Chicago",
    "America/Denver", "America/Los_Angeles", "Europe/London",
    "Europe/Paris", "Europe/Berlin", "Asia/Tokyo", "Asia/Shanghai",
    "Australia/Sydney",
}


class ScheduleCreate(BaseModel):
    name: str
    description: str | None = None
    timezone: str = "America/Sao_Paulo"
    enabled: bool = True


class ShiftCreate(BaseModel):
    principal_id: str
    display_name: str | None = None
    starts_at: str  # ISO8601
    ends_at: str    # ISO8601


def _parse_iso(s: str, field: str) -> datetime:
    try:
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt
    except ValueError:
        raise HTTPException(status_code=422,
                            detail=f"{field} must be ISO8601 datetime")


# ---------------------------------------------------------------------------
# Schedules
# ---------------------------------------------------------------------------

@router.get("/schedules")
async def list_schedules(request: Request,
                         tenant_id: str | None = None) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT s.schedule_id, s.name, s.description, s.timezone,
                   s.enabled, s.created_at,
                   (SELECT principal_id
                      FROM g1.oncall_shift sh
                     WHERE sh.schedule_id = s.schedule_id
                       AND sh.starts_at <= now() AND sh.ends_at > now()
                     ORDER BY sh.starts_at DESC LIMIT 1) AS current_principal,
                   (SELECT display_name
                      FROM g1.oncall_shift sh
                     WHERE sh.schedule_id = s.schedule_id
                       AND sh.starts_at <= now() AND sh.ends_at > now()
                     ORDER BY sh.starts_at DESC LIMIT 1) AS current_display_name
              FROM g1.oncall_schedule s
             WHERE s.tenant_id = %s
             ORDER BY s.created_at DESC
            """, (tenant,))
        cols = [d.name for d in cur.description]
        rows = []
        for r in await cur.fetchall():
            row = dict(zip(cols, r))
            row["created_at"] = row["created_at"].isoformat()
            rows.append(row)
        return rows


@router.post("/schedules", status_code=status.HTTP_201_CREATED)
async def create_schedule(request: Request, body: ScheduleCreate,
                          tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    if not body.name.strip():
        raise HTTPException(status_code=422, detail="name required")
    schedule_id = f"oncall_{secrets.token_urlsafe(10)}"
    async with db_tenant_connection(tenant) as conn:
        try:
            cur = await conn.execute(
                """
                INSERT INTO g1.oncall_schedule
                    (schedule_id, tenant_id, name, description, timezone, enabled)
                VALUES (%s,%s,%s,%s,%s,%s)
                RETURNING schedule_id, name, timezone, enabled, created_at
                """,
                (schedule_id, tenant, body.name.strip(),
                 body.description, body.timezone, body.enabled))
            row = await cur.fetchone()
            await conn.commit()
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(status_code=409,
                                    detail="schedule name already exists")
            raise
    return {"schedule_id": row[0], "name": row[1], "timezone": row[2],
            "enabled": row[3], "created_at": row[4].isoformat()}


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_200_OK)
async def delete_schedule(schedule_id: str, request: Request,
                          tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "DELETE FROM g1.oncall_schedule "
            "WHERE tenant_id=%s AND schedule_id=%s RETURNING schedule_id",
            (tenant, schedule_id))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        await conn.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Shifts
# ---------------------------------------------------------------------------

@router.get("/schedules/{schedule_id}/shifts")
async def list_shifts(schedule_id: str, request: Request,
                      from_ts: str | None = None,
                      till_ts: str | None = None,
                      tenant_id: str | None = None) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    # Default window: ±4 weeks around now
    if from_ts:
        from_dt = _parse_iso(from_ts, "from_ts")
    else:
        from datetime import timedelta
        from_dt = datetime.now(timezone.utc) - timedelta(weeks=4)
    if till_ts:
        till_dt = _parse_iso(till_ts, "till_ts")
    else:
        from datetime import timedelta
        till_dt = datetime.now(timezone.utc) + timedelta(weeks=4)

    async with db_tenant_connection(tenant) as conn:
        # Verify schedule belongs to tenant
        cur = await conn.execute(
            "SELECT 1 FROM g1.oncall_schedule "
            "WHERE tenant_id=%s AND schedule_id=%s",
            (tenant, schedule_id))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="schedule not found")

        cur = await conn.execute(
            """
            SELECT shift_id, principal_id, display_name,
                   starts_at, ends_at, created_at
              FROM g1.oncall_shift
             WHERE schedule_id = %s
               AND starts_at < %s
               AND ends_at   > %s
             ORDER BY starts_at
            """, (schedule_id, till_dt, from_dt))
        cols = [d.name for d in cur.description]
        rows = []
        for r in await cur.fetchall():
            row = dict(zip(cols, r))
            row["starts_at"] = row["starts_at"].isoformat()
            row["ends_at"] = row["ends_at"].isoformat()
            row["created_at"] = row["created_at"].isoformat()
            rows.append(row)
        return rows


@router.post("/schedules/{schedule_id}/shifts",
             status_code=status.HTTP_201_CREATED)
async def add_shift(schedule_id: str, request: Request, body: ShiftCreate,
                    tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    starts = _parse_iso(body.starts_at, "starts_at")
    ends = _parse_iso(body.ends_at, "ends_at")
    if ends <= starts:
        raise HTTPException(status_code=422,
                            detail="ends_at must be after starts_at")
    if not body.principal_id.strip():
        raise HTTPException(status_code=422, detail="principal_id required")

    shift_id = f"shift_{secrets.token_urlsafe(10)}"
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.oncall_schedule "
            "WHERE tenant_id=%s AND schedule_id=%s",
            (tenant, schedule_id))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="schedule not found")

        cur = await conn.execute(
            """
            INSERT INTO g1.oncall_shift
                (shift_id, schedule_id, tenant_id, principal_id,
                 display_name, starts_at, ends_at)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            RETURNING shift_id, principal_id, display_name, starts_at, ends_at
            """,
            (shift_id, schedule_id, tenant, body.principal_id.strip(),
             body.display_name, starts, ends))
        row = await cur.fetchone()
        await conn.commit()
    return {"shift_id": row[0], "principal_id": row[1],
            "display_name": row[2],
            "starts_at": row[3].isoformat(),
            "ends_at": row[4].isoformat()}


@router.delete("/schedules/{schedule_id}/shifts/{shift_id}",
               status_code=status.HTTP_200_OK)
async def delete_shift(schedule_id: str, shift_id: str, request: Request,
                       tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            DELETE FROM g1.oncall_shift
             WHERE shift_id = %s AND schedule_id = %s AND tenant_id = %s
            RETURNING shift_id
            """, (shift_id, schedule_id, tenant))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="shift not found")
        await conn.commit()
    return {"ok": True}


@router.get("/current")
async def current_oncall(request: Request,
                         tenant_id: str | None = None) -> list[dict]:
    """Returns who is on-call right now across all enabled schedules."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT DISTINCT ON (sh.schedule_id)
                   s.schedule_id, s.name AS schedule_name,
                   sh.principal_id, sh.display_name,
                   sh.starts_at, sh.ends_at
              FROM g1.oncall_shift sh
              JOIN g1.oncall_schedule s
                ON s.schedule_id = sh.schedule_id
             WHERE s.tenant_id = %s AND s.enabled = true
               AND sh.starts_at <= now() AND sh.ends_at > now()
             ORDER BY sh.schedule_id, sh.starts_at DESC
            """, (tenant,))
        cols = [d.name for d in cur.description]
        rows = []
        for r in await cur.fetchall():
            row = dict(zip(cols, r))
            row["starts_at"] = row["starts_at"].isoformat()
            row["ends_at"] = row["ends_at"].isoformat()
            rows.append(row)
        return rows
