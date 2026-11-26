"""Logs — ingestão individual e batch, busca e estatísticas por tenant."""
from __future__ import annotations

import re
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Query
from pydantic import BaseModel, field_validator

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/logs", tags=["logs"])

VALID_LEVELS = {"ERROR", "WARN", "INFO", "DEBUG", "TRACE"}
MAX_BATCH = 1_000
MAX_RESULTS = 500


def _require_tenant(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


def _require_admin_ctx(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    pid = ctx.get("principal_id")
    if not tid or not pid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid, pid


class LogEntry(BaseModel):
    resource_id: Optional[str] = None
    level: str = "INFO"
    message: str
    source: Optional[str] = None
    metadata: Optional[dict] = None

    @field_validator("level")
    @classmethod
    def validate_level(cls, v: str) -> str:
        up = v.upper()
        if up not in VALID_LEVELS:
            raise ValueError(f"level must be one of {sorted(VALID_LEVELS)}")
        return up

    @field_validator("message")
    @classmethod
    def validate_message(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("message must not be empty")
        return v[:8192]


class LogBatch(BaseModel):
    entries: list[LogEntry]

    @field_validator("entries")
    @classmethod
    def validate_entries(cls, v: list) -> list:
        if len(v) > MAX_BATCH:
            raise ValueError(f"batch limited to {MAX_BATCH} entries")
        if not v:
            raise ValueError("entries must not be empty")
        return v


@router.post("", status_code=201)
async def ingest_log(request: Request, body: LogEntry) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.log_entry
                (tenant_id, resource_id, level, message, source, metadata)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING entry_id, logged_at
            """,
            (
                tenant_id,
                body.resource_id,
                body.level,
                body.message,
                body.source,
                body.metadata,
            ),
        )
        row = await cur.fetchone()
    return {"entry_id": str(row[0]), "logged_at": row[1].isoformat()}


@router.post("/batch", status_code=201)
async def ingest_batch(request: Request, body: LogBatch) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        await conn.executemany(
            """
            INSERT INTO g1.log_entry
                (tenant_id, resource_id, level, message, source, metadata)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            [
                (
                    tenant_id,
                    e.resource_id,
                    e.level,
                    e.message,
                    e.source,
                    e.metadata,
                )
                for e in body.entries
            ],
        )
    return {"inserted": len(body.entries)}


@router.get("")
async def search_logs(
    request: Request,
    level: Optional[str] = Query(None),
    resource_id: Optional[str] = Query(None),
    pattern: Optional[str] = Query(None, description="Substring or regex pattern"),
    hours: int = Query(24, ge=1, le=720),
    limit: int = Query(100, ge=1, le=MAX_RESULTS),
    offset: int = Query(0, ge=0),
) -> dict:
    tenant_id = _require_tenant(request)

    if level and level.upper() not in VALID_LEVELS:
        raise HTTPException(status_code=422, detail=f"invalid level: {level}")

    # Validate regex early to avoid DB error
    if pattern:
        try:
            re.compile(pattern)
        except re.error as exc:
            raise HTTPException(status_code=422, detail=f"invalid pattern: {exc}") from exc

    filters = ["logged_at > now() - (%s::text || ' hours')::interval"]
    params: list = [str(hours)]

    if level:
        filters.append("level = %s")
        params.append(level.upper())
    if resource_id:
        filters.append("resource_id = %s")
        params.append(resource_id)
    if pattern:
        filters.append("message ~* %s")
        params.append(pattern)

    where = " AND ".join(filters)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            f"""
            SELECT entry_id, resource_id, level, message, source, metadata, logged_at
            FROM g1.log_entry
            WHERE {where}
            ORDER BY logged_at DESC
            LIMIT %s OFFSET %s
            """,
            [*params, limit, offset],
        )
        rows = await cur.fetchall()
        count_cur = await conn.execute(
            f"SELECT count(*) FROM g1.log_entry WHERE {where}",
            params,
        )
        total_row = await count_cur.fetchone()

    return {
        "total": total_row[0] if total_row else 0,
        "limit": limit,
        "offset": offset,
        "entries": [
            {
                "entry_id": str(r[0]),
                "resource_id": r[1],
                "level": r[2],
                "message": r[3],
                "source": r[4],
                "metadata": r[5],
                "logged_at": r[6].isoformat(),
            }
            for r in rows
        ],
    }


@router.get("/stats")
async def log_stats(
    request: Request,
    hours: int = Query(24, ge=1, le=720),
) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        # counts by level
        cur = await conn.execute(
            """
            SELECT level, count(*) AS cnt
            FROM g1.log_entry
            WHERE logged_at > now() - (%s::text || ' hours')::interval
            GROUP BY level
            ORDER BY cnt DESC
            """,
            (str(hours),),
        )
        by_level = {r[0]: r[1] for r in await cur.fetchall()}

        # top resources
        cur2 = await conn.execute(
            """
            SELECT resource_id, count(*) AS cnt
            FROM g1.log_entry
            WHERE logged_at > now() - (%s::text || ' hours')::interval
              AND resource_id IS NOT NULL
            GROUP BY resource_id
            ORDER BY cnt DESC
            LIMIT 10
            """,
            (str(hours),),
        )
        top_resources = [{"resource_id": r[0], "count": r[1]} for r in await cur2.fetchall()]

        # hourly trend (last 24h only, regardless of hours param)
        cur3 = await conn.execute(
            """
            SELECT date_trunc('hour', logged_at) AS hour, count(*) AS cnt
            FROM g1.log_entry
            WHERE logged_at > now() - '24 hours'::interval
            GROUP BY hour
            ORDER BY hour
            """,
        )
        hourly = [{"hour": r[0].isoformat(), "count": r[1]} for r in await cur3.fetchall()]

    return {
        "hours": hours,
        "by_level": by_level,
        "top_resources": top_resources,
        "hourly_trend": hourly,
    }


@router.delete("", status_code=204)
async def clear_old_logs(
    request: Request,
    days: int = Query(30, ge=1, le=365, description="Delete logs older than N days"),
) -> None:
    """Requires tenant:admin. Purges logs older than `days` days."""
    from shared import access
    from shared.db import db_connection

    ctx = getattr(request.state, "jlmirror_context", None) or {}
    principal_id = ctx.get("principal_id")
    tenant_id = ctx.get("tenant_id")
    if not principal_id or not tenant_id:
        raise HTTPException(status_code=403)
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="tenant:admin required")

    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            "DELETE FROM g1.log_entry WHERE logged_at < now() - (%s::text || ' days')::interval",
            (str(days),),
        )
