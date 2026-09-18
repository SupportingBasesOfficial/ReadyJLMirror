"""Tenant-scoped membership administration — the Tenant Administrator
surface (actors-and-personas / contract §8).

Requires the tenant:admin permission (admin role template or an
equivalent delegated grant). Every mutation emits durable audit
evidence in the target tenant.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.audit import record_audit_event
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/tenant", tags=["tenant"])

ROLES = ("admin", "operator", "viewer", "auditor")


def _tenant_ctx(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None or not ctx.get("tenant_id"):
        raise HTTPException(status_code=403, detail="no tenant authority")
    return ctx["tenant_id"], ctx["principal_id"]


@router.get("/members")
async def list_members(request: Request) -> list[dict]:
    tenant, _ = _tenant_ctx(request)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT m.membership_id, m.principal_id, m.role, m.state,
                   m.created_at
              FROM g1.tenant_memberships m
             WHERE m.tenant_id = %s
             ORDER BY m.created_at
            """, (tenant,))
        return [{"membership_id": r[0], "principal_id": r[1],
                 "role": r[2], "state": r[3],
                 "created_at": r[4].isoformat()}
                for r in await cur.fetchall()]


class MemberCreate(BaseModel):
    principal_id: str
    role: str = "viewer"


@router.post("/members", status_code=201)
async def add_member(request: Request, body: MemberCreate) -> dict:
    tenant, actor = _tenant_ctx(request)
    if body.role not in ROLES and not body.role.startswith("custom:"):
        raise HTTPException(
            status_code=422,
            detail=f"role must be one of {ROLES} or 'custom:<name>'")
    membership_id = f"mem_{secrets.token_urlsafe(12)}"
    async with db_tenant_connection(tenant) as conn:
        if body.role.startswith("custom:"):
            cur = await conn.execute(
                "SELECT 1 FROM g1.tenant_roles WHERE tenant_id = %s "
                "AND role_name = %s AND state = 'active'",
                (tenant, body.role[7:]))
            if await cur.fetchone() is None:
                raise HTTPException(
                    status_code=404, detail="custom role not found")
        cur = await conn.execute(
            """
            INSERT INTO g1.tenant_memberships
                (membership_id, tenant_id, principal_id, role)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (tenant_id, principal_id)
            DO UPDATE SET role = EXCLUDED.role, state = 'active'
            RETURNING membership_id
            """,
            (membership_id, tenant, body.principal_id, body.role))
        membership_id = (await cur.fetchone())[0]
        await record_audit_event(
            conn, tenant,
            action="tenant.membership.granted",
            actor_kind="principal", actor_id=actor,
            subject_type="membership", subject_id=membership_id,
            detail={"principal_id": body.principal_id,
                    "role": body.role})
        await conn.commit()
    return {"membership_id": membership_id}


@router.post("/members/{membership_id}/revoke")
async def revoke_member(request: Request, membership_id: str) -> dict:
    tenant, actor = _tenant_ctx(request)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            UPDATE g1.tenant_memberships
               SET state = 'revoked'
             WHERE membership_id = %s AND tenant_id = %s
               AND state = 'active'
            """, (membership_id, tenant))
        if cur.rowcount != 1:
            raise HTTPException(status_code=404,
                                detail="membership not found or inactive")
        await record_audit_event(
            conn, tenant,
            action="tenant.membership.revoked",
            actor_kind="principal", actor_id=actor,
            subject_type="membership", subject_id=membership_id)
        await conn.commit()
    return {"membership_id": membership_id, "state": "revoked"}


# ---------------------------------------------------------------------------
# Custom roles (contract §8 — first-class)
# ---------------------------------------------------------------------------


@router.get("/roles")
async def list_roles(request: Request) -> list[dict]:
    tenant, _ = _tenant_ctx(request)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT role_name, permissions, state, created_by,
                   created_at
              FROM g1.tenant_roles
             WHERE tenant_id = %s
             ORDER BY role_name
            """, (tenant,))
        return [{"role_name": r[0], "permissions": r[1],
                 "state": r[2], "created_by": r[3],
                 "created_at": r[4].isoformat()}
                for r in await cur.fetchall()]


class RoleCreate(BaseModel):
    name: str
    permissions: list[str]


@router.post("/roles", status_code=201)
async def create_role(request: Request, body: RoleCreate) -> dict:
    tenant, actor = _tenant_ctx(request)
    from shared import access
    invalid = [p for p in body.permissions if p not in access.PERMISSIONS]
    if invalid:
        raise HTTPException(status_code=422,
                            detail=f"unknown permissions: {invalid}")
    async with db_tenant_connection(tenant) as conn:
        try:
            await conn.execute(
                """
                INSERT INTO g1.tenant_roles
                    (tenant_id, role_name, permissions, created_by)
                VALUES (%s, %s, %s, %s)
                """, (tenant, body.name, body.permissions, actor))
        except Exception:
            raise HTTPException(
                status_code=422,
                detail="invalid role name or duplicate")
        await record_audit_event(
            conn, tenant,
            action="tenant.role.created",
            actor_kind="principal", actor_id=actor,
            subject_type="tenant_role", subject_id=body.name,
            detail={"permissions": body.permissions})
        await conn.commit()
    return {"role_name": body.name, "role": f"custom:{body.name}"}


@router.post("/roles/{role_name}/retire")
async def retire_role(request: Request, role_name: str) -> dict:
    tenant, actor = _tenant_ctx(request)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            UPDATE g1.tenant_roles SET state = 'retired'
             WHERE tenant_id = %s AND role_name = %s
               AND state = 'active'
            """, (tenant, role_name))
        if cur.rowcount != 1:
            raise HTTPException(status_code=404,
                                detail="role not found or inactive")
        await record_audit_event(
            conn, tenant,
            action="tenant.role.retired",
            actor_kind="principal", actor_id=actor,
            subject_type="tenant_role", subject_id=role_name)
        await conn.commit()
    return {"role_name": role_name, "state": "retired"}
