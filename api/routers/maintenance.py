"""G20 Maintenance Window router.

Tenant-scoped CRUD for planned maintenance windows.  During an active window,
notification dispatch (G9 worker) suppresses WhatsApp/ITSM notifications for
sources covered by the window — alerts still fire, only delivery is muted.

Endpoints:
  GET  /api/v1/maintenance/windows          list active + upcoming windows
  POST /api/v1/maintenance/windows          create a window
  DELETE /api/v1/maintenance/windows/{id}   cancel a window
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/maintenance", tags=["maintenance"])

_WORKER_ROLE = "jlmirror_g20_mw_app_invoker"


def _actor(request: Request,
           x_principal_id: str | None) -> str:
    ctx = getattr(request.state, "jlmirror_context", {}) or {}
    return ctx.get("principal_id") or x_principal_id or "anonymous"


# ─── Models ──────────────────────────────────────────────────────────────────

class CreateWindowBody(BaseModel):
    tenant_id: str | None = None
    label: str
    source_ids: list[str] | None = None  # None = all sources
    starts_at: datetime
    ends_at: datetime


# ─── Endpoints ───────────────────────────────────────────────────────────────

@router.get("/windows")
async def list_windows(
    request: Request,
    tenant_id: str | None = None,
    x_principal_id: Annotated[str | None, Header()] = None,
):
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        async with conn.transaction():
            await conn.execute(f"SET LOCAL ROLE {_WORKER_ROLE}")
            cur = await conn.execute(
                "SELECT monitoring.g20_list_windows(%s)", (tenant,))
            row = await cur.fetchone()
    return row[0] if row else []


@router.post("/windows", status_code=status.HTTP_201_CREATED)
async def create_window(
    request: Request,
    body: CreateWindowBody,
    x_principal_id: Annotated[str | None, Header()] = None,
):
    tenant = _authoritative_tenant(request, body.tenant_id)
    actor = _actor(request, x_principal_id)

    starts = body.starts_at.astimezone(timezone.utc) if body.starts_at.tzinfo else \
        body.starts_at.replace(tzinfo=timezone.utc)
    ends = body.ends_at.astimezone(timezone.utc) if body.ends_at.tzinfo else \
        body.ends_at.replace(tzinfo=timezone.utc)

    if ends <= starts:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="ends_at must be after starts_at",
        )

    async with db_tenant_connection(tenant) as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_WORKER_ROLE}")
                cur = await conn.execute(
                    "SELECT monitoring.g20_create_window(%s,%s,%s,%s,%s,%s)",
                    (tenant, body.label, body.source_ids, starts, ends, actor))
                row = await cur.fetchone()
        except Exception as exc:
            msg = str(exc)
            if "g20.end_before_start" in msg:
                raise HTTPException(status_code=422, detail="ends_at must be after starts_at")
            if "g20.label_required" in msg:
                raise HTTPException(status_code=422, detail="label is required")
            raise
    return row[0] if row else {}


@router.delete("/windows/{window_id}", status_code=status.HTTP_200_OK)
async def cancel_window(
    window_id: str,
    request: Request,
    tenant_id: str | None = None,
    x_principal_id: Annotated[str | None, Header()] = None,
):
    tenant = _authoritative_tenant(request, tenant_id)
    actor = _actor(request, x_principal_id)

    async with db_tenant_connection(tenant) as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_WORKER_ROLE}")
                cur = await conn.execute(
                    "SELECT monitoring.g20_cancel_window(%s,%s,%s)",
                    (tenant, window_id, actor))
                row = await cur.fetchone()
        except Exception as exc:
            if "g20.window_not_found" in str(exc):
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"window {window_id!r} not found or already cancelled",
                )
            raise
    return row[0] if row else {}
