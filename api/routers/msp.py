"""MSP cross-tenant overview router.

Returns aggregated metrics (alerts, incidents) across all client tenants
a principal has access to via delegated grants.  The tenant list comes from
shared.access.accessible_tenants(), which is the authoritative gate — the
SQL function never re-checks permissions, it trusts the caller-supplied IDs.

POST /api/v1/msp/clients — MSP self-onboarding: creates a client org + tenant
and grants the calling MSP admin full delegation to manage it.
"""

from __future__ import annotations

import re
import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared import access
from shared.access import accessible_tenants
from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/msp", tags=["msp"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]$")


def _actor(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    return ctx.get("principal_id", "dev-operator")


def _ctx(request: Request) -> dict:
    return getattr(request.state, "jlmirror_context", None) or {}


class ClientCreate(BaseModel):
    client_name: str         # display name, e.g. "Empresa ABC"
    client_slug: str         # kebab-case slug, e.g. "empresa-abc" → org/tenant IDs


async def _require_msp_admin(request: Request) -> tuple[str, str, str]:
    """Return (principal_id, tenant_id, msp_organization_id).

    Requires tenant:admin in the calling principal's current tenant AND
    that tenant's organization must have org_kind='msp'.
    """
    ctx = _ctx(request)
    principal_id = ctx.get("principal_id")
    tenant_id = ctx.get("tenant_id")
    if not principal_id or not tenant_id:
        raise HTTPException(status_code=403, detail="tenant context required")

    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
        if "tenant:admin" not in perms:
            raise HTTPException(status_code=403, detail="tenant:admin required")

        cur = await conn.execute(
            """
            SELECT o.organization_id, o.org_kind
              FROM g1.tenants t
              JOIN g1.organizations o ON o.organization_id = t.organization_id
             WHERE t.tenant_id = %s AND o.state = 'active'
            """,
            (tenant_id,))
        row = await cur.fetchone()

    if not row or row[1] != "msp":
        raise HTTPException(
            status_code=403,
            detail="only MSP organizations can create client tenants")

    return principal_id, tenant_id, row[0]


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


@router.post("/clients", status_code=201)
async def create_msp_client(request: Request, body: ClientCreate) -> dict:
    """MSP admin creates a new client org + tenant with full delegation.

    The calling principal must have tenant:admin in an MSP-kind organization.
    Creates: client org → client tenant → MSP relationship → delegated grant.
    The calling admin immediately gains full access to manage the new tenant.
    """
    principal_id, _msp_tenant_id, msp_org_id = await _require_msp_admin(request)

    slug = body.client_slug.strip().lower()
    if not _SLUG_RE.match(slug):
        raise HTTPException(
            status_code=422,
            detail="client_slug must be 3-50 lowercase letters/digits/hyphens, "
                   "starting and ending with a letter or digit")

    client_org_id = f"org:{slug}"
    client_tenant_id = f"tenant:{slug}"
    rel_id = f"rel_{secrets.token_urlsafe(12)}"
    grant_id = f"grant_{secrets.token_urlsafe(12)}"

    async with db_tenant_connection("platform") as conn:
        # Idempotency guard — slug already in use
        cur = await conn.execute(
            "SELECT 1 FROM g1.organizations WHERE organization_id = %s",
            (client_org_id,))
        if await cur.fetchone() is not None:
            raise HTTPException(
                status_code=409, detail=f"slug '{slug}' is already taken")

        await conn.execute(
            "INSERT INTO g1.organizations (organization_id, display_name, org_kind) "
            "VALUES (%s, %s, 'client')",
            (client_org_id, body.client_name.strip()))

        await conn.execute(
            "INSERT INTO g1.tenants (tenant_id, display_name, organization_id) "
            "VALUES (%s, %s, %s)",
            (client_tenant_id, body.client_name.strip(), client_org_id))

        await conn.execute(
            """
            INSERT INTO g1.organization_relationships
                (relationship_id, family, source_organization_id, target_organization_id)
            VALUES (%s, 'provides_monitoring_service_for', %s, %s)
            """,
            (rel_id, msp_org_id, client_org_id))

        await conn.execute(
            """
            INSERT INTO g1.delegated_grants
                (grant_id, source_organization_id, target_tenant_id,
                 principal_id, permissions, granted_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (grant_id, msp_org_id, client_tenant_id,
             principal_id, list(access.TENANT_ALL), principal_id))

        await record_audit_event(
            conn, "platform",
            action="msp.client.created",
            actor_kind="msp_admin", actor_id=principal_id,
            subject_type="tenant", subject_id=client_tenant_id,
            detail={
                "client_name": body.client_name,
                "msp_org": msp_org_id,
                "relationship_id": rel_id,
                "grant_id": grant_id,
            })
        await conn.commit()

    return {
        "organization_id": client_org_id,
        "tenant_id": client_tenant_id,
        "relationship_id": rel_id,
        "grant_id": grant_id,
    }


def _totals(rows: list[dict]) -> dict:
    return {
        "tenant_count": len(rows),
        "active_alerts": sum(r.get("active_alerts", 0) for r in rows),
        "critical_alerts": sum(r.get("critical_alerts", 0) for r in rows),
        "open_incidents": sum(r.get("open_incidents", 0) for r in rows),
        "in_progress_incidents": sum(r.get("in_progress_incidents", 0) for r in rows),
    }
