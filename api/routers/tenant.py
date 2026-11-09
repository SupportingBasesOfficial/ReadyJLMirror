"""Tenant-scoped membership administration — the Tenant Administrator
surface (actors-and-personas / contract §8).

Requires the tenant:admin permission (admin role template or an
equivalent delegated grant). Every mutation emits durable audit
evidence in the target tenant.
"""

from __future__ import annotations

import secrets

import psycopg
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared import access
from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection

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
                   m.created_at, p.display_name, p.email
              FROM g1.tenant_memberships m
              JOIN g1.principals p USING (principal_id)
             WHERE m.tenant_id = %s
             ORDER BY m.created_at
            """, (tenant,))
        return [{"membership_id": r[0], "principal_id": r[1],
                 "role": r[2], "state": r[3],
                 "created_at": r[4].isoformat(),
                 "display_name": r[5] or "",
                 "email": r[6] or ""}
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


class MemberRoleUpdate(BaseModel):
    role: str


@router.patch("/members/{membership_id}")
async def update_member_role(
    request: Request, membership_id: str, body: MemberRoleUpdate
) -> dict:
    tenant, actor = _tenant_ctx(request)
    if body.role not in ROLES and not body.role.startswith("custom:"):
        raise HTTPException(
            status_code=422,
            detail=f"role must be one of {ROLES} or 'custom:<name>'")
    async with db_tenant_connection(tenant) as conn:
        if body.role.startswith("custom:"):
            cur = await conn.execute(
                "SELECT 1 FROM g1.tenant_roles WHERE tenant_id = %s "
                "AND role_name = %s AND state = 'active'",
                (tenant, body.role[7:]))
            if await cur.fetchone() is None:
                raise HTTPException(status_code=404, detail="custom role not found")
        cur = await conn.execute(
            """
            UPDATE g1.tenant_memberships
               SET role = %s
             WHERE membership_id = %s AND tenant_id = %s
               AND state = 'active'
            """, (body.role, membership_id, tenant))
        if cur.rowcount != 1:
            raise HTTPException(status_code=404,
                                detail="membership not found or inactive")
        await record_audit_event(
            conn, tenant,
            action="tenant.membership.role_changed",
            actor_kind="principal", actor_id=actor,
            subject_type="membership", subject_id=membership_id,
            detail={"role": body.role})
        await conn.commit()
    return {"membership_id": membership_id, "role": body.role}


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
        except psycopg.IntegrityError:
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


@router.get("/usage")
async def tenant_usage(request: Request) -> list[dict]:
    """Tenant-facing usage records — the tenant sees its own
    consumption attribution (contract §12)."""
    tenant, _ = _tenant_ctx(request)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT usage_id, meter, quantity, window_start,
                   window_end, contract_id
              FROM g1.usage_meters
             WHERE tenant_id = %s
             ORDER BY window_start DESC LIMIT 200
            """, (tenant,))
        return [{"usage_id": r[0], "meter": r[1],
                 "quantity": float(r[2]),
                 "window_start": r[3].isoformat(),
                 "window_end": r[4].isoformat(),
                 "contract_id": r[5]}
                for r in await cur.fetchall()]


# ── Permission catalog ─────────────────────────────────────────────────────────

_PERMISSION_DESCRIPTIONS = {
    "tenant:read":          "View tenant configuration and member list",
    "tenant:admin":         "Manage tenant members, roles, and settings",
    "monitoring:read":      "View hosts, services, checks, and status",
    "monitoring:operate":   "Acknowledge alerts, run checks, manage suppressions",
    "alerting:read":        "View alert rules, channels, and history",
    "alerting:operate":     "Create and modify alert rules and notification channels",
    "observability:read":   "Access logs, metrics, traces, and dashboards",
    "audit:read":           "View audit trail and compliance reports",
}


@router.get("/permissions")
async def list_permissions(request: Request) -> dict:
    """Return the platform permission catalog: all permissions and role→permission mappings.

    Any authenticated tenant member may call this endpoint.
    Used by PermissionCatalogPage to display live data instead of hardcoded values.
    """
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tenant_id = ctx.get("tenant_id")
    principal_id = ctx.get("principal_id")
    if not tenant_id or not principal_id:
        from fastapi import HTTPException
        raise HTTPException(status_code=403, detail="tenant context required")

    # Return current caller's effective permissions alongside the catalog
    async with db_connection() as conn:
        caller_perms = await access.effective_permissions(conn, principal_id, tenant_id)

    return {
        "permissions": [
            {"permission": p, "description": _PERMISSION_DESCRIPTIONS.get(p, "")}
            for p in access.PERMISSIONS
        ],
        "roles": {
            role: sorted(perms)
            for role, perms in access.ROLE_PERMISSIONS.items()
        },
        "caller_permissions": sorted(caller_perms),
    }
