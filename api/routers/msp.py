"""MSP cross-tenant overview router.

Returns aggregated metrics (alerts, incidents) across all client tenants
a principal has access to via delegated grants.  The tenant list comes from
shared.access.accessible_tenants(), which is the authoritative gate — the
SQL function never re-checks permissions, it trusts the caller-supplied IDs.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from shared.access import accessible_tenants
from shared.db import db_connection

router = APIRouter(prefix="/api/v1/msp", tags=["msp"])


def _actor(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    return ctx.get("principal_id", "dev-operator")


@router.get("/overview")
async def msp_overview(request: Request) -> dict:
    """Aggregated alert + incident counts for all delegated client tenants."""
    principal_id = _actor(request)

    async with db_connection() as conn:
        tenants = await accessible_tenants(conn, principal_id)

    # Only tenants reached via a delegated grant are MSP-managed clients.
    # Platform admins see everything via 'platform' role — for them include all
    # tenants that are NOT their own bound tenant (or all of them for a full view).
    delegated = [t for t in tenants if t.get("via") == "delegation"]

    # Platform admins get all tenants regardless (they manage the whole platform)
    if not delegated:
        all_tenants = [t for t in tenants if t.get("role") == "platform"]
        if all_tenants:
            delegated = all_tenants

    if not delegated:
        return {"tenants": [], "totals": _totals([])}

    tenant_ids = [t["tenant_id"] for t in delegated]
    tenant_meta = {t["tenant_id"]: t for t in delegated}

    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT g1.msp_tenant_overview(%s::text[])", (tenant_ids,))
        row = await cur.fetchone()

    rows: list[dict] = row[0] if row and row[0] else []

    # Merge display_name from accessible_tenants into each row (already there
    # from the SQL function, but ensure consistency)
    for r in rows:
        meta = tenant_meta.get(r["tenant_id"], {})
        r.setdefault("display_name", meta.get("display_name", r["tenant_id"]))

    return {"tenants": rows, "totals": _totals(rows)}


@router.get("/clients")
async def msp_clients(request: Request) -> dict:
    """List of delegated client tenant IDs — used by Shell for MSP banner check."""
    principal_id = _actor(request)
    async with db_connection() as conn:
        tenants = await accessible_tenants(conn, principal_id)
    # Only actual delegation grants count as MSP clients.
    # Platform-level membership (role == "platform") is platform-admin access,
    # not an MSP client relationship — platform admins use Portfólio de Clientes.
    delegated = [t for t in tenants if t.get("via") == "delegation"]
    return {"clients": [{"tenant_id": t["tenant_id"]} for t in delegated]}


def _totals(rows: list[dict]) -> dict:
    return {
        "tenant_count": len(rows),
        "active_alerts": sum(r.get("active_alerts", 0) for r in rows),
        "critical_alerts": sum(r.get("critical_alerts", 0) for r in rows),
        "open_incidents": sum(r.get("open_incidents", 0) for r in rows),
        "in_progress_incidents": sum(r.get("in_progress_incidents", 0) for r in rows),
    }
