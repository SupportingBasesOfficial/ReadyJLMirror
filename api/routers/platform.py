"""Platform administration surface — the platform-owner control plane
(organization-operating-model-contract.md §14).

Every endpoint requires the caller's principal to be a
platform_admin_principal (kind in g1.principals). Cross-tenant reach
is the privilege; all mutations emit durable audit evidence.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared import access
from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/platform", tags=["platform"])

# NOT under _DOMAIN_PREFIXES — platform endpoints gate on principal
# kind, not tenant-scoped permissions.


async def _require_platform_admin(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None:
        raise HTTPException(status_code=403,
                            detail="platform admin required")
    async with db_connection() as conn:
        ok = await access.principal_is_platform_admin(
            conn, ctx["principal_id"])
    if not ok:
        raise HTTPException(status_code=403,
                            detail="platform admin required")
    return ctx["principal_id"]


class OrganizationCreate(BaseModel):
    organization_id: str
    display_name: str


@router.get("/organizations")
async def list_organizations(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT organization_id, display_name, state, created_at "
            "FROM g1.organizations ORDER BY organization_id")
        return [{"organization_id": r[0], "display_name": r[1],
                 "state": r[2],
                 "created_at": r[3].isoformat()}
                for r in await cur.fetchall()]


@router.post("/organizations", status_code=201)
async def create_organization(request: Request,
                              body: OrganizationCreate) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            "INSERT INTO g1.organizations (organization_id, "
            "display_name) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (body.organization_id, body.display_name))
        await record_audit_event(
            conn, "platform",
            action="platform.organization.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="organization",
            subject_id=body.organization_id,
            detail={"display_name": body.display_name})
        await conn.commit()
    return {"organization_id": body.organization_id}


class RelationshipCreate(BaseModel):
    family: str
    source_organization_id: str
    target_organization_id: str


@router.get("/relationships")
async def list_relationships(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT relationship_id, family, source_organization_id, "
            "target_organization_id, state, effective_from, "
            "effective_until FROM g1.organization_relationships "
            "ORDER BY family, source_organization_id")
        return [{"relationship_id": r[0], "family": r[1],
                 "source_organization_id": r[2],
                 "target_organization_id": r[3], "state": r[4],
                 "effective_from": r[5].isoformat(),
                 "effective_until": r[6].isoformat() if r[6] else None}
                for r in await cur.fetchall()]


@router.post("/relationships", status_code=201)
async def create_relationship(request: Request,
                              body: RelationshipCreate) -> dict:
    actor = await _require_platform_admin(request)
    rel_id = f"rel_{secrets.token_urlsafe(12)}"
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            """
            INSERT INTO g1.organization_relationships
                (relationship_id, family, source_organization_id,
                 target_organization_id)
            VALUES (%s, %s, %s, %s)
            """,
            (rel_id, body.family, body.source_organization_id,
             body.target_organization_id))
        await record_audit_event(
            conn, "platform",
            action="platform.relationship.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="organization_relationship",
            subject_id=rel_id,
            detail={"family": body.family,
                    "source": body.source_organization_id,
                    "target": body.target_organization_id})
        await conn.commit()
    return {"relationship_id": rel_id}


class GrantCreate(BaseModel):
    source_organization_id: str
    target_tenant_id: str
    principal_id: str
    permissions: list[str]


@router.get("/delegated-grants")
async def list_grants(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT grant_id, source_organization_id, target_tenant_id,
                   principal_id, permissions, state, effective_from,
                   effective_until
              FROM g1.delegated_grants
             ORDER BY created_at DESC
            """)
        return [{"grant_id": r[0], "source_organization_id": r[1],
                 "target_tenant_id": r[2], "principal_id": r[3],
                 "permissions": r[4], "state": r[5],
                 "effective_from": r[6].isoformat(),
                 "effective_until": r[7].isoformat() if r[7] else None}
                for r in await cur.fetchall()]


@router.post("/delegated-grants", status_code=201)
async def create_grant(request: Request, body: GrantCreate) -> dict:
    actor = await _require_platform_admin(request)
    invalid = [p for p in body.permissions
               if p not in access.PERMISSIONS]
    if invalid:
        raise HTTPException(status_code=422,
                            detail=f"unknown permissions: {invalid}")
    grant_id = f"grant_{secrets.token_urlsafe(12)}"
    async with db_tenant_connection("platform") as conn:
        # Fail-closed: a delegated grant must be backed by an ACTIVE
        # relationship authorizing the source organization over the
        # target tenant's organization (contract §7 — delegation is
        # explicit, never emergent).
        cur = await conn.execute(
            """
            SELECT r.relationship_id, r.family
              FROM g1.organization_relationships r
              JOIN g1.tenants t
                ON t.organization_id = r.target_organization_id
             WHERE r.source_organization_id = %s
               AND t.tenant_id = %s
               AND r.state = 'active'
               AND r.family IN ('delegated_administration_for',
                                'provides_monitoring_service_for')
            """,
            (body.source_organization_id, body.target_tenant_id))
        relationship = await cur.fetchone()
        if relationship is None:
            raise HTTPException(
                status_code=403,
                detail="no active delegation relationship from the "
                       "source organization to the target tenant's "
                       "organization — grant refused")
        await conn.execute(
            """
            INSERT INTO g1.delegated_grants
                (grant_id, source_organization_id, target_tenant_id,
                 principal_id, permissions, granted_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (grant_id, body.source_organization_id,
             body.target_tenant_id, body.principal_id,
             body.permissions, actor))
        await record_audit_event(
            conn, "platform",
            action="platform.delegated_grant.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="delegated_grant", subject_id=grant_id,
            detail={"target_tenant": body.target_tenant_id,
                    "principal": body.principal_id,
                    "permissions": body.permissions})
        await conn.commit()
    return {"grant_id": grant_id}


@router.post("/delegated-grants/{grant_id}/revoke")
async def revoke_grant(request: Request, grant_id: str) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            """
            UPDATE g1.delegated_grants
               SET state = 'revoked',
                   revoked_at = transaction_timestamp()
             WHERE grant_id = %s AND state = 'active'
            """, (grant_id,))
        if cur.rowcount != 1:
            raise HTTPException(status_code=404,
                                detail="grant not found or not active")
        await record_audit_event(
            conn, "platform",
            action="platform.delegated_grant.revoked",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="delegated_grant", subject_id=grant_id)
        await conn.commit()
    return {"grant_id": grant_id, "state": "revoked"}


@router.get("/organizations/{organization_id}")
async def organization_360(request: Request,
                           organization_id: str) -> dict:
    """Organization 360 (contract §15): what the org is, which
    tenants it owns, its relationships, delegated grants, and
    principals reachable through those grants."""
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT organization_id, display_name, state, created_at "
            "FROM g1.organizations WHERE organization_id = %s",
            (organization_id,))
        org = await cur.fetchone()
        if org is None:
            raise HTTPException(status_code=404,
                                detail="organization not found")

        cur = await conn.execute(
            "SELECT tenant_id, display_name, state FROM g1.tenants "
            "WHERE organization_id = %s ORDER BY tenant_id",
            (organization_id,))
        tenants = [{"tenant_id": r[0], "display_name": r[1],
                    "state": r[2]} for r in await cur.fetchall()]

        cur = await conn.execute(
            """
            SELECT relationship_id, family, source_organization_id,
                   target_organization_id, state
              FROM g1.organization_relationships
             WHERE source_organization_id = %s
                OR target_organization_id = %s
             ORDER BY family
            """, (organization_id, organization_id))
        relationships = [
            {"relationship_id": r[0], "family": r[1],
             "direction": ("outgoing" if r[2] == organization_id
                           else "incoming"),
             "other_organization_id":
                 r[3] if r[2] == organization_id else r[2],
             "state": r[4]}
            for r in await cur.fetchall()]

        cur = await conn.execute(
            """
            SELECT g.grant_id, g.target_tenant_id, g.principal_id,
                   g.permissions, g.state
              FROM g1.delegated_grants g
             WHERE g.source_organization_id = %s
             ORDER BY g.created_at DESC
            """, (organization_id,))
        grants = [{"grant_id": r[0], "target_tenant_id": r[1],
                   "principal_id": r[2], "permissions": r[3],
                   "state": r[4]} for r in await cur.fetchall()]

        cur = await conn.execute(
            """
            SELECT m.principal_id, m.tenant_id, m.role, m.state
              FROM g1.tenant_memberships m
              JOIN g1.tenants t USING (tenant_id)
             WHERE t.organization_id = %s
            """, (organization_id,))
        members = [{"principal_id": r[0], "tenant_id": r[1],
                    "role": r[2], "state": r[3]}
                   for r in await cur.fetchall()]

    return {
        "organization_id": org[0], "display_name": org[1],
        "state": org[2], "created_at": org[3].isoformat(),
        "tenants": tenants, "relationships": relationships,
        "delegated_grants": grants, "members": members,
    }


class MspTransfer(BaseModel):
    """Service-provider transfer (contract §13): the monitored
    organization's tenant/identity is preserved; old delegated
    authority is fenced; successor authority is established;
    history remains attributable to the authority that existed
    when actions occurred."""
    target_organization_id: str
    from_organization_id: str
    to_organization_id: str


@router.post("/service-provider-transfer")
async def service_provider_transfer(request: Request,
                                    body: MspTransfer) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            "SELECT tenant_id FROM g1.tenants "
            "WHERE organization_id = %s", (body.target_organization_id,))
        target_tenants = [r[0] for r in await cur.fetchall()]
        if not target_tenants:
            raise HTTPException(
                status_code=404,
                detail="target organization has no tenants")

        # 1) Fence: revoke every active delegated grant from the
        #    outgoing provider over the target org's tenants.
        cur = await conn.execute(
            """
            UPDATE g1.delegated_grants
               SET state = 'revoked',
                   revoked_at = transaction_timestamp()
             WHERE source_organization_id = %s
               AND target_tenant_id = ANY(%s)
               AND state = 'active'
             RETURNING grant_id
            """, (body.from_organization_id, target_tenants))
        fenced = [r[0] for r in await cur.fetchall()]

        # 2) End the outgoing provider's relationships to the
        #    target organization.
        cur = await conn.execute(
            """
            UPDATE g1.organization_relationships
               SET state = 'ended',
                   effective_until = transaction_timestamp()
             WHERE source_organization_id = %s
               AND target_organization_id = %s
               AND state = 'active'
             RETURNING relationship_id
            """, (body.from_organization_id,
                  body.target_organization_id))
        ended = [r[0] for r in await cur.fetchall()]

        # 3) Establish successor relationships (same families).
        cur = await conn.execute(
            """
            SELECT family FROM g1.organization_relationships
             WHERE relationship_id = ANY(%s)
            """, (ended,))
        families = [r[0] for r in await cur.fetchall()]
        successors = []
        for fam in families:
            rel_id = f"rel_{secrets.token_urlsafe(12)}"
            await conn.execute(
                """
                INSERT INTO g1.organization_relationships
                    (relationship_id, family, source_organization_id,
                     target_organization_id)
                VALUES (%s, %s, %s, %s)
                """, (rel_id, fam, body.to_organization_id,
                      body.target_organization_id))
            successors.append(rel_id)

        await record_audit_event(
            conn, "platform",
            action="platform.service_provider.transferred",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="organization",
            subject_id=body.target_organization_id,
            detail={
                "from": body.from_organization_id,
                "to": body.to_organization_id,
                "fenced_grants": fenced,
                "ended_relationships": ended,
                "successor_relationships": successors})
        await conn.commit()

    return {"target_organization_id": body.target_organization_id,
            "fenced_grants": fenced,
            "ended_relationships": ended,
            "successor_relationships": successors}


@router.get("/tenants")
async def list_tenants(request: Request) -> list[dict]:
    """Platform sovereign view of tenants (§14) — read-only."""
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT t.tenant_id, t.display_name, t.state,
                   t.organization_id
              FROM g1.tenants t ORDER BY t.tenant_id
            """)
        return [{"tenant_id": r[0], "display_name": r[1],
                 "state": r[2], "organization_id": r[3]}
                for r in await cur.fetchall()]
