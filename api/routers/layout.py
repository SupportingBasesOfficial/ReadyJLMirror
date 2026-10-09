"""User layout persistence — dashboard, TV mode, device panels, etc."""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/layout", tags=["layout"])

_VALID_VIEW_TYPES = {
    "dashboard", "tv_mode", "device_panel", "incident_board",
}
_MAX_LAYOUT_BYTES = 64 * 1024  # 64 KB per layout blob


def _require_context(request: Request) -> dict:
    ctx = getattr(request.state, "jlmirror_context", None)
    if not ctx or not ctx.get("tenant_id") or not ctx.get("principal_id"):
        raise HTTPException(status_code=401, detail="authentication required")
    return ctx


class LayoutBody(BaseModel):
    layout: dict


@router.get("")
async def get_layout(
    request: Request,
    view_type: str,
    view_key: Optional[str] = "",
) -> dict:
    """Return the saved layout for the calling principal, or {} if none."""
    if view_type not in _VALID_VIEW_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"view_type must be one of {sorted(_VALID_VIEW_TYPES)}")
    ctx = _require_context(request)
    tenant_id = ctx["tenant_id"]
    principal_id = ctx["principal_id"]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT layout, updated_at
              FROM g1.user_layout
             WHERE tenant_id = %s
               AND principal_id = %s
               AND view_type = %s
               AND view_key = %s
            """,
            (tenant_id, principal_id, view_type, view_key or ""),
        )
        row = await cur.fetchone()

    if row is None:
        return {"view_type": view_type, "view_key": view_key or "",
                "layout": {}, "updated_at": None}

    return {
        "view_type": view_type,
        "view_key": view_key or "",
        "layout": row[0],
        "updated_at": row[1].isoformat(),
    }


@router.put("")
async def save_layout(
    request: Request,
    view_type: str,
    body: LayoutBody,
    view_key: Optional[str] = "",
) -> dict:
    """Upsert the layout for the calling principal."""
    if view_type not in _VALID_VIEW_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"view_type must be one of {sorted(_VALID_VIEW_TYPES)}")

    raw = json.dumps(body.layout)
    if len(raw) > _MAX_LAYOUT_BYTES:
        raise HTTPException(
            status_code=422,
            detail=f"layout exceeds {_MAX_LAYOUT_BYTES // 1024} KB limit")

    ctx = _require_context(request)
    tenant_id = ctx["tenant_id"]
    principal_id = ctx["principal_id"]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.user_layout
                (tenant_id, principal_id, view_type, view_key, layout, updated_at)
            VALUES (%s, %s, %s, %s, %s::jsonb, NOW())
            ON CONFLICT (tenant_id, principal_id, view_type, view_key)
            DO UPDATE SET layout = EXCLUDED.layout,
                          updated_at = NOW()
            RETURNING updated_at
            """,
            (tenant_id, principal_id, view_type, view_key or "", raw),
        )
        row = await cur.fetchone()
        await conn.commit()

    return {
        "view_type": view_type,
        "view_key": view_key or "",
        "saved": True,
        "updated_at": row[0].isoformat(),
    }
