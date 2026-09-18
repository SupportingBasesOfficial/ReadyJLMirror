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
from shared.db import db_connection

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
    async with db_connection() as conn:
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
    async with db_connection() as conn:
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
    async with db_connection() as conn:
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
    async with db_connection() as conn:
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
