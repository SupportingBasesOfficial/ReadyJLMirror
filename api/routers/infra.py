"""G35 Infrastructure Governance API — certificates and assets."""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/infra", tags=["infra"])

_VALID_ASSET_TYPES = {
    "server", "vm", "container", "network",
    "storage", "database", "service", "other",
}
_VALID_STATUSES = {"active", "inactive", "decommissioned", "maintenance"}


def _require_tenant(request: Request) -> str:
    tid = request.state.jlmirror_context.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


# ── Certificate tracker ────────────────────────────────────────────────────


class CreateCert(BaseModel):
    domain: str
    port: int = 443
    alert_days: int = 30


@router.get("/certs")
async def list_certs(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT cert_id, domain, port, expires_at, issuer,
                   fingerprint_sha256, last_checked_at, state,
                   error_detail, alert_days, check_enabled, created_at
              FROM g1.cert_tracker
             WHERE tenant_id = %s
             ORDER BY domain, port
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/certs", status_code=status.HTTP_201_CREATED)
async def create_cert(request: Request, body: CreateCert) -> dict:
    tenant_id = _require_tenant(request)
    domain = body.domain.strip().lower()
    if not domain:
        raise HTTPException(status_code=422, detail="domain is required")
    if not (1 <= body.port <= 65535):
        raise HTTPException(status_code=422, detail="port must be 1-65535")
    if not (1 <= body.alert_days <= 365):
        raise HTTPException(status_code=422, detail="alert_days must be 1-365")

    cert_id = f"cert:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        try:
            await conn.execute(
                """
                INSERT INTO g1.cert_tracker
                    (cert_id, tenant_id, domain, port, alert_days)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (cert_id, tenant_id, domain, body.port, body.alert_days),
            )
            await conn.commit()
        except Exception as exc:
            await conn.rollback()
            if "unique" in str(exc).lower():
                raise HTTPException(
                    status_code=409,
                    detail=f"{domain}:{body.port} already tracked",
                )
            raise
    return {"cert_id": cert_id, "domain": domain, "port": body.port}


@router.delete("/certs/{cert_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_cert(request: Request, cert_id: str) -> Response:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT cert_id FROM g1.cert_tracker "
            "WHERE tenant_id=%s AND cert_id=%s",
            (tenant_id, cert_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="cert not found")
        await conn.execute(
            "UPDATE g1.cert_tracker SET check_enabled=false, updated_at=now() "
            "WHERE cert_id=%s",
            (cert_id,),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Asset inventory ────────────────────────────────────────────────────────


class CreateAsset(BaseModel):
    name: str
    asset_type: str = "other"
    status: str = "active"
    ip_address: Optional[str] = None
    location: Optional[str] = None
    owner: Optional[str] = None


class UpdateAsset(BaseModel):
    name: Optional[str] = None
    asset_type: Optional[str] = None
    status: Optional[str] = None
    ip_address: Optional[str] = None
    location: Optional[str] = None
    owner: Optional[str] = None


@router.get("/assets")
async def list_assets(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT asset_id, name, asset_type, status, ip_address,
                   location, owner, tags, metadata, created_at, updated_at
              FROM g1.infra_asset
             WHERE tenant_id = %s
             ORDER BY asset_type, name
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/assets", status_code=status.HTTP_201_CREATED)
async def create_asset(request: Request, body: CreateAsset) -> dict:
    tenant_id = _require_tenant(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if len(name) > 200:
        raise HTTPException(status_code=422, detail="name max 200 chars")
    if body.asset_type not in _VALID_ASSET_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"asset_type must be one of {sorted(_VALID_ASSET_TYPES)}",
        )
    if body.status not in _VALID_STATUSES:
        raise HTTPException(
            status_code=422,
            detail=f"status must be one of {sorted(_VALID_STATUSES)}",
        )

    asset_id = f"asset:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.infra_asset
                (asset_id, tenant_id, name, asset_type, status,
                 ip_address, location, owner)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                asset_id, tenant_id, name, body.asset_type, body.status,
                body.ip_address, body.location, body.owner,
            ),
        )
        await conn.commit()
    return {"asset_id": asset_id, "name": name}


@router.put("/assets/{asset_id}")
async def update_asset(
    request: Request, asset_id: str, body: UpdateAsset
) -> dict:
    tenant_id = _require_tenant(request)
    if body.asset_type and body.asset_type not in _VALID_ASSET_TYPES:
        raise HTTPException(status_code=422, detail="invalid asset_type")
    if body.status and body.status not in _VALID_STATUSES:
        raise HTTPException(status_code=422, detail="invalid status")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT asset_id FROM g1.infra_asset "
            "WHERE tenant_id=%s AND asset_id=%s",
            (tenant_id, asset_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="asset not found")

        fields: list[str] = []
        values: list = []
        for col in ("name", "asset_type", "status", "ip_address", "location", "owner"):
            val = getattr(body, col)
            if val is not None:
                fields.append(f"{col} = %s")
                values.append(val)

        if fields:
            fields.append("updated_at = now()")
            values.append(asset_id)
            await conn.execute(
                f"UPDATE g1.infra_asset SET {', '.join(fields)} "
                "WHERE asset_id = %s",
                values,
            )
            await conn.commit()

    return {"asset_id": asset_id, "updated": True}


@router.delete("/assets/{asset_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_asset(request: Request, asset_id: str) -> Response:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT asset_id FROM g1.infra_asset "
            "WHERE tenant_id=%s AND asset_id=%s",
            (tenant_id, asset_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="asset not found")
        await conn.execute(
            "DELETE FROM g1.infra_asset WHERE asset_id=%s", (asset_id,)
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
