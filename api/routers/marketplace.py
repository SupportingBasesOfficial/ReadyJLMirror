"""G13-adjacent: Integration Marketplace endpoints.

Provides a global catalog of integrations (managed by JL Platform Admin)
and per-tenant installation management.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared import access
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/marketplace", tags=["marketplace"])


def _require_tenant(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


async def _require_platform_admin(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    principal_id = ctx.get("principal_id")
    tenant_id = ctx.get("tenant_id")
    if not principal_id or not tenant_id:
        raise HTTPException(status_code=403, detail="context required")
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="platform admin required")
    return principal_id


async def _require_admin(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    principal_id = ctx.get("principal_id")
    tenant_id = ctx.get("tenant_id")
    if not principal_id or not tenant_id:
        raise HTTPException(status_code=403, detail="context required")
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="tenant:admin required")
    return principal_id, tenant_id


# ── Catalog (global, readable by any authenticated user) ──────────────────────

@router.get("")
async def list_catalog(request: Request) -> list[dict]:
    """Return the full integration catalog."""
    _require_tenant(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT integration_id, name, description, category,
                   icon_emoji, vendor, website_url, is_enabled, created_at
              FROM g1.marketplace_integration
             ORDER BY category, name
            """
        )
        rows = await cur.fetchall()
    return [
        {
            "integration_id": r[0],
            "name": r[1],
            "description": r[2],
            "category": r[3],
            "icon_emoji": r[4],
            "vendor": r[5],
            "website_url": r[6],
            "is_enabled": r[7],
            "created_at": r[8].isoformat(),
        }
        for r in rows
    ]


@router.get("/catalog/{integration_id}")
async def get_integration(request: Request, integration_id: str) -> dict:
    _require_tenant(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT integration_id, name, description, category,
                   icon_emoji, vendor, website_url, config_schema, is_enabled, created_at
              FROM g1.marketplace_integration
             WHERE integration_id = %s
            """,
            (integration_id,),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="integration not found")
    return {
        "integration_id": row[0],
        "name": row[1],
        "description": row[2],
        "category": row[3],
        "icon_emoji": row[4],
        "vendor": row[5],
        "website_url": row[6],
        "config_schema": row[7],
        "is_enabled": row[8],
        "created_at": row[9].isoformat(),
    }


class CatalogCreate(BaseModel):
    integration_id: str
    name: str
    description: str = ""
    category: str = "other"
    icon_emoji: str = "🔌"
    vendor: str = ""
    website_url: str | None = None
    config_schema: dict = {}


@router.post("/catalog", status_code=status.HTTP_201_CREATED)
async def create_catalog_entry(request: Request, body: CatalogCreate) -> dict:
    """Platform admin: add a new integration to the catalog."""
    await _require_platform_admin(request)
    valid_categories = {"monitoring", "alerting", "itsm", "chatops",
                        "security", "automation", "storage", "other"}
    if body.category not in valid_categories:
        raise HTTPException(status_code=422, detail=f"category must be one of {sorted(valid_categories)}")
    async with db_connection() as conn:
        try:
            await conn.execute(
                """
                INSERT INTO g1.marketplace_integration
                    (integration_id, name, description, category,
                     icon_emoji, vendor, website_url, config_schema)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (body.integration_id, body.name, body.description, body.category,
                 body.icon_emoji, body.vendor, body.website_url,
                 __import__("json").dumps(body.config_schema)),
            )
            await conn.commit()
        except Exception:
            raise HTTPException(status_code=409, detail="integration_id already exists")
    return {"integration_id": body.integration_id, "name": body.name}


class CatalogPatch(BaseModel):
    name: str | None = None
    description: str | None = None
    category: str | None = None
    icon_emoji: str | None = None
    vendor: str | None = None
    website_url: str | None = None
    is_enabled: bool | None = None


@router.patch("/catalog/{integration_id}")
async def update_catalog_entry(request: Request, integration_id: str, body: CatalogPatch) -> dict:
    """Platform admin: update catalog entry."""
    await _require_platform_admin(request)
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(status_code=422, detail="nothing to update")
    set_clause = ", ".join(f"{k} = %s" for k in fields)
    async with db_connection() as conn:
        cur = await conn.execute(
            f"UPDATE g1.marketplace_integration SET {set_clause} WHERE integration_id = %s RETURNING integration_id",
            (*fields.values(), integration_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="integration not found")
        await conn.commit()
    return {"integration_id": integration_id, "updated": True}


# ── Per-tenant installations ───────────────────────────────────────────────────

@router.get("/installed")
async def list_installed(request: Request) -> list[dict]:
    """Return all integrations installed in the current tenant."""
    tenant_id = _require_tenant(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT ti.id, ti.integration_id, mi.name, mi.category, mi.icon_emoji,
                   mi.vendor, ti.config, ti.state, ti.error_detail,
                   ti.installed_by, ti.installed_at, ti.updated_at
              FROM g1.tenant_integration ti
              JOIN g1.marketplace_integration mi ON mi.integration_id = ti.integration_id
             WHERE ti.tenant_id = %s
             ORDER BY mi.category, mi.name
            """,
            (tenant_id,),
        )
        rows = await cur.fetchall()
    return [
        {
            "id": r[0],
            "integration_id": r[1],
            "name": r[2],
            "category": r[3],
            "icon_emoji": r[4],
            "vendor": r[5],
            "config": r[6],
            "state": r[7],
            "error_detail": r[8],
            "installed_by": r[9],
            "installed_at": r[10].isoformat(),
            "updated_at": r[11].isoformat(),
        }
        for r in rows
    ]


class InstallBody(BaseModel):
    config: dict = {}


@router.post("/{integration_id}/install", status_code=status.HTTP_201_CREATED)
async def install_integration(
    request: Request, integration_id: str, body: InstallBody
) -> dict:
    """Install an integration in the current tenant."""
    principal_id, tenant_id = await _require_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT integration_id FROM g1.marketplace_integration WHERE integration_id = %s AND is_enabled = TRUE",
            (integration_id,),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="integration not found or not enabled")
        try:
            cur2 = await conn.execute(
                """
                INSERT INTO g1.tenant_integration
                    (tenant_id, integration_id, config, installed_by)
                VALUES (%s, %s, %s, %s)
                RETURNING id
                """,
                (tenant_id, integration_id,
                 __import__("json").dumps(body.config), principal_id),
            )
            row = await cur2.fetchone()
            await conn.commit()
        except Exception:
            raise HTTPException(status_code=409, detail="integration already installed")
    return {"id": row[0], "integration_id": integration_id, "state": "active"}


class UpdateInstallBody(BaseModel):
    config: dict | None = None
    state: str | None = None


@router.patch("/{integration_id}/install")
async def update_installation(
    request: Request, integration_id: str, body: UpdateInstallBody
) -> dict:
    """Update config or toggle state of an installed integration."""
    _, tenant_id = await _require_admin(request)
    if body.state and body.state not in ("active", "inactive"):
        raise HTTPException(status_code=422, detail="state must be active or inactive")
    updates = []
    params: list = []
    if body.config is not None:
        updates.append("config = %s")
        params.append(__import__("json").dumps(body.config))
    if body.state is not None:
        updates.append("state = %s")
        params.append(body.state)
    if not updates:
        raise HTTPException(status_code=422, detail="nothing to update")
    updates.append("updated_at = now()")
    params.extend([tenant_id, integration_id])
    async with db_connection() as conn:
        cur = await conn.execute(
            f"UPDATE g1.tenant_integration SET {', '.join(updates)} "
            f"WHERE tenant_id = %s AND integration_id = %s RETURNING id",
            params,
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="installation not found")
        await conn.commit()
    return {"integration_id": integration_id, "updated": True}


@router.delete("/{integration_id}/install", status_code=status.HTTP_204_NO_CONTENT)
async def uninstall_integration(request: Request, integration_id: str):
    """Uninstall an integration from the current tenant."""
    _, tenant_id = await _require_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM g1.tenant_integration WHERE tenant_id = %s AND integration_id = %s RETURNING id",
            (tenant_id, integration_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="installation not found")
        await conn.commit()


@router.get("/stats")
async def marketplace_stats(request: Request) -> dict:
    """Return summary stats for the current tenant's marketplace usage."""
    tenant_id = _require_tenant(request)
    async with db_connection() as conn:
        cur_total = await conn.execute(
            "SELECT COUNT(*) FROM g1.marketplace_integration WHERE is_enabled = TRUE"
        )
        total = (await cur_total.fetchone())[0]

        cur_installed = await conn.execute(
            "SELECT COUNT(*), COUNT(*) FILTER (WHERE state = 'active'), "
            "COUNT(*) FILTER (WHERE state = 'inactive'), "
            "COUNT(*) FILTER (WHERE state = 'error') "
            "FROM g1.tenant_integration WHERE tenant_id = %s",
            (tenant_id,),
        )
        r = await cur_installed.fetchone()
    return {
        "catalog_total": total,
        "installed": r[0],
        "active": r[1],
        "inactive": r[2],
        "error": r[3],
    }
