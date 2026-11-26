from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.auth import _require_operate, _require_ctx
from shared.db import db_connection
from shared.audit import record_audit_event

router = APIRouter(prefix="/assets", tags=["assets"])

ASSET_TYPES = ["hardware", "software", "license"]
ASSET_STATUSES = ["active", "inactive", "retired", "disposed"]


# ── Models ────────────────────────────────────────────────────────────────────

class AssetCreate(BaseModel):
    name: str
    asset_type: str
    category: Optional[str] = None
    status: str = "active"
    # hardware
    manufacturer: Optional[str] = None
    model: Optional[str] = None
    serial_number: Optional[str] = None
    location: Optional[str] = None
    purchase_date: Optional[str] = None
    warranty_expiry: Optional[str] = None
    # software
    version: Optional[str] = None
    installed_on: Optional[str] = None
    # license
    vendor: Optional[str] = None
    license_key: Optional[str] = None
    seats_total: Optional[int] = None
    seats_used: Optional[int] = None
    expiry_date: Optional[str] = None
    # common
    assigned_to: Optional[str] = None
    tags: list[str] = []
    notes: Optional[str] = None
    metadata: dict = {}


class AssetUpdate(AssetCreate):
    name: Optional[str] = None
    asset_type: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────────

def _validate_type_status(asset_type: Optional[str], status: Optional[str]):
    if asset_type and asset_type not in ASSET_TYPES:
        raise HTTPException(400, f"asset_type inválido: {asset_type}")
    if status and status not in ASSET_STATUSES:
        raise HTTPException(400, f"status inválido: {status}")


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def get_stats(request: Request):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                (SELECT COUNT(*) FROM g1.asset WHERE tenant_id=$1) AS total,
                (SELECT COUNT(*) FROM g1.asset WHERE tenant_id=$1 AND asset_type='hardware' AND status='active') AS hardware,
                (SELECT COUNT(*) FROM g1.asset WHERE tenant_id=$1 AND asset_type='software' AND status='active') AS software,
                (SELECT COUNT(*) FROM g1.asset WHERE tenant_id=$1 AND asset_type='license' AND status='active') AS licenses,
                (SELECT COUNT(*) FROM g1.asset WHERE tenant_id=$1 AND asset_type='license'
                    AND status='active' AND expiry_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 30) AS expiring_soon,
                (SELECT COUNT(*) FROM g1.asset WHERE tenant_id=$1 AND asset_type='license'
                    AND status='active' AND expiry_date < CURRENT_DATE) AS expired
            """,
            tid,
        )
    return dict(row)


# ── List ──────────────────────────────────────────────────────────────────────

@router.get("/")
async def list_assets(
    request: Request,
    asset_type: Optional[str] = None,
    status: Optional[str] = None,
    category: Optional[str] = None,
    search: Optional[str] = None,
    limit: int = 200,
):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    _validate_type_status(asset_type, status)
    where = ["a.tenant_id=$1"]
    vals: list = [tid]
    n = 2
    if asset_type:
        where.append(f"a.asset_type=${n}"); vals.append(asset_type); n += 1
    if status:
        where.append(f"a.status=${n}"); vals.append(status); n += 1
    if category:
        where.append(f"a.category=${n}"); vals.append(category); n += 1
    if search:
        where.append(f"(a.name ILIKE ${n} OR a.serial_number ILIKE ${n} OR a.license_key ILIKE ${n})")
        vals.append(f"%{search}%"); n += 1
    vals.append(limit)
    async with db_connection() as conn:
        rows = await conn.fetch(
            f"""
            SELECT a.*,
                   u.full_name AS assigned_to_name
            FROM g1.asset a
            LEFT JOIN g1.user_account u ON u.id = a.assigned_to
            WHERE {' AND '.join(where)}
            ORDER BY a.created_at DESC
            LIMIT ${n}
            """,
            *vals,
        )
    return [dict(r) for r in rows]


# ── Create ────────────────────────────────────────────────────────────────────

@router.post("/", status_code=201)
async def create_asset(request: Request, body: AssetCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    _validate_type_status(body.asset_type, body.status)
    assigned = UUID(body.assigned_to) if body.assigned_to else None
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO g1.asset (
                tenant_id, name, asset_type, category, status,
                manufacturer, model, serial_number, location,
                purchase_date, warranty_expiry,
                version, installed_on,
                vendor, license_key, seats_total, seats_used, expiry_date,
                assigned_to, tags, notes, metadata
            ) VALUES (
                $1,$2,$3,$4,$5,
                $6,$7,$8,$9,
                $10::date,$11::date,
                $12,$13,
                $14,$15,$16,$17,$18::date,
                $19,$20,$21,$22
            ) RETURNING *
            """,
            tid, body.name, body.asset_type, body.category, body.status,
            body.manufacturer, body.model, body.serial_number, body.location,
            body.purchase_date, body.warranty_expiry,
            body.version, body.installed_on,
            body.vendor, body.license_key, body.seats_total, body.seats_used, body.expiry_date,
            assigned, body.tags, body.notes, body.metadata,
        )
        await record_audit_event(conn, tid, actor, "asset.create", row["id"],
                                 {"name": body.name, "type": body.asset_type})
    return dict(row)


# ── Get ───────────────────────────────────────────────────────────────────────

@router.get("/{asset_id}")
async def get_asset(request: Request, asset_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT a.*, u.full_name AS assigned_to_name
            FROM g1.asset a
            LEFT JOIN g1.user_account u ON u.id = a.assigned_to
            WHERE a.id=$1 AND a.tenant_id=$2
            """,
            asset_id, tid,
        )
    if not row:
        raise HTTPException(404, "ativo não encontrado")
    return dict(row)


# ── Update ────────────────────────────────────────────────────────────────────

@router.put("/{asset_id}")
async def update_asset(request: Request, asset_id: UUID, body: AssetUpdate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    _validate_type_status(body.asset_type, body.status)
    assigned = UUID(body.assigned_to) if body.assigned_to else None
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.asset SET
                name            = COALESCE($3, name),
                asset_type      = COALESCE($4, asset_type),
                category        = $5,
                status          = COALESCE($6, status),
                manufacturer    = $7,
                model           = $8,
                serial_number   = $9,
                location        = $10,
                purchase_date   = $11::date,
                warranty_expiry = $12::date,
                version         = $13,
                installed_on    = $14,
                vendor          = $15,
                license_key     = $16,
                seats_total     = $17,
                seats_used      = $18,
                expiry_date     = $19::date,
                assigned_to     = $20,
                tags            = $21,
                notes           = $22,
                metadata        = $23,
                updated_at      = NOW()
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            asset_id, tid,
            body.name, body.asset_type, body.category, body.status,
            body.manufacturer, body.model, body.serial_number, body.location,
            body.purchase_date, body.warranty_expiry,
            body.version, body.installed_on,
            body.vendor, body.license_key, body.seats_total, body.seats_used, body.expiry_date,
            assigned, body.tags, body.notes, body.metadata,
        )
        if not row:
            raise HTTPException(404, "ativo não encontrado")
        await record_audit_event(conn, tid, actor, "asset.update", asset_id, {"name": body.name})
    if not row:
        raise HTTPException(404, "ativo não encontrado")
    return dict(row)


# ── Delete ────────────────────────────────────────────────────────────────────

@router.delete("/{asset_id}", status_code=204)
async def delete_asset(request: Request, asset_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        result = await conn.execute(
            "DELETE FROM g1.asset WHERE id=$1 AND tenant_id=$2",
            asset_id, tid,
        )
        if result == "DELETE 0":
            raise HTTPException(404, "ativo não encontrado")
        await record_audit_event(conn, tid, actor, "asset.delete", asset_id, {})
