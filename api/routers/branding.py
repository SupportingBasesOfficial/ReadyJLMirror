"""G28 White-label Branding — per-tenant visual identity.

Operators configure brand_name, brand_color, and logo_url via PUT.
The shell fetches GET on login and applies CSS variables.
"""

from __future__ import annotations

import re

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/platform", tags=["branding"])

_HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


class BrandingConfig(BaseModel):
    brand_name: str | None = None
    brand_color: str | None = None
    logo_url: str | None = None


@router.get("/branding")
async def get_branding(request: Request, tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT brand_name, brand_color, logo_url, updated_at
              FROM g1.tenant_branding
             WHERE tenant_id = %s
            """,
            (tenant,),
        )
        row = await cur.fetchone()
    if row is None:
        return {"configured": False}
    return {
        "configured": True,
        "brand_name": row[0],
        "brand_color": row[1],
        "logo_url": row[2],
        "updated_at": row[3].isoformat(),
    }


@router.put("/branding", status_code=status.HTTP_200_OK)
async def upsert_branding(
    request: Request,
    body: BrandingConfig,
    tenant_id: str | None = None,
) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)

    if body.brand_color is not None and not _HEX_RE.match(body.brand_color):
        raise HTTPException(
            status_code=422,
            detail="brand_color must be a 6-digit hex color (e.g. #6366f1)",
        )
    if body.brand_name is not None and len(body.brand_name.strip()) > 80:
        raise HTTPException(status_code=422, detail="brand_name too long (max 80)")
    if body.logo_url is not None and len(body.logo_url) > 2048:
        raise HTTPException(status_code=422, detail="logo_url too long (max 2048)")

    name = body.brand_name.strip() if body.brand_name else None
    async with db_tenant_connection(tenant) as conn:
        await conn.execute(
            """
            INSERT INTO g1.tenant_branding
                (tenant_id, brand_name, brand_color, logo_url, updated_at)
            VALUES (%s, %s, %s, %s, now())
            ON CONFLICT (tenant_id) DO UPDATE
            SET brand_name  = EXCLUDED.brand_name,
                brand_color = EXCLUDED.brand_color,
                logo_url    = EXCLUDED.logo_url,
                updated_at  = now()
            """,
            (tenant, name, body.brand_color, body.logo_url),
        )
        await conn.commit()
    return {
        "configured": True,
        "brand_name": name,
        "brand_color": body.brand_color,
        "logo_url": body.logo_url,
    }
