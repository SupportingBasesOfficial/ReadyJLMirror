"""Effective-authority resolution — canonical organization operating
model implemented on top of the durable inputs:

    membership (home tenant)  +  delegated grants (target tenants)
    +  platform_admin_principal (privileged cross-tenant capability)

Deny-by-default: every protected mutation/read declares a required
permission; roles are templates, not the source of truth
(organization-operating-model-contract.md §8).
"""

from __future__ import annotations

from psycopg import AsyncConnection

# Permission vocabulary — action domains, deliberately small.
PERMISSIONS = (
    "tenant:read",
    "tenant:admin",
    "monitoring:read",
    "monitoring:operate",
    "alerting:read",
    "alerting:operate",
    "observability:read",
    "audit:read",
)

TENANT_ALL = frozenset(PERMISSIONS)

# Role templates (§8) — convenience defaults only.
ROLE_PERMISSIONS: dict[str, frozenset[str]] = {
    "admin": TENANT_ALL,
    "tenant_admin": TENANT_ALL,            # legacy
    "operator": frozenset({
        "tenant:read",
        "monitoring:read", "monitoring:operate",
        "alerting:read", "alerting:operate",
        "observability:read", "audit:read",
    }),
    "member": frozenset({                  # legacy default = operator
        "tenant:read",
        "monitoring:read", "monitoring:operate",
        "alerting:read", "alerting:operate",
        "observability:read", "audit:read",
    }),
    "viewer": frozenset({
        "tenant:read",
        "monitoring:read", "alerting:read",
        "observability:read",
    }),
    "auditor": frozenset({
        "tenant:read",
        "observability:read", "audit:read",
        "monitoring:read",
    }),
}


async def principal_is_platform_admin(
        conn: AsyncConnection, principal_id: str) -> bool:
    cur = await conn.execute(
        """
        SELECT 1 FROM g1.principals
         WHERE principal_id = %s AND active = TRUE
           AND kind = 'platform_admin_principal'
        """, (principal_id,))
    return await cur.fetchone() is not None


async def effective_permissions(
        conn: AsyncConnection, principal_id: str,
        tenant_id: str) -> frozenset[str]:
    """Union of membership-role permissions and active delegated
    grants for (principal, tenant). Platform admins resolve to the
    full tenant permission set — the privilege is the cross-tenant
    reach, not a different vocabulary."""
    perms: set[str] = set()

    cur = await conn.execute(
        """
        SELECT role FROM g1.tenant_memberships
         WHERE tenant_id = %s AND principal_id = %s
           AND state = 'active'
        """, (tenant_id, principal_id))
    custom_roles: list[str] = []
    for (role,) in await cur.fetchall():
        if role.startswith("custom:"):
            custom_roles.append(role[7:])
        else:
            perms |= ROLE_PERMISSIONS.get(role, frozenset())

    if custom_roles:
        cur = await conn.execute(
            """
            SELECT permissions FROM g1.tenant_roles
             WHERE tenant_id = %s AND role_name = ANY(%s)
               AND state = 'active'
            """, (tenant_id, custom_roles))
        for (role_perms,) in await cur.fetchall():
            perms |= {p for p in role_perms if p in PERMISSIONS}

    cur = await conn.execute(
        """
        SELECT permissions FROM g1.delegated_grants
         WHERE target_tenant_id = %s AND principal_id = %s
           AND state = 'active'
           AND effective_from <= now()
           AND (effective_until IS NULL OR effective_until > now())
        """, (tenant_id, principal_id))
    for (grant_perms,) in await cur.fetchall():
        perms |= {p for p in grant_perms if p in PERMISSIONS}

    if await principal_is_platform_admin(conn, principal_id):
        perms |= TENANT_ALL

    return frozenset(perms)


async def accessible_tenants(
        conn: AsyncConnection, principal_id: str) -> list[dict]:
    """Tenants the principal may enter: active memberships + active
    delegated-grant targets (+ every tenant for platform admins)."""
    if await principal_is_platform_admin(conn, principal_id):
        cur = await conn.execute(
            """
            SELECT tenant_id, display_name, 'platform' AS role
              FROM g1.tenants WHERE state = 'active'
             ORDER BY tenant_id
            """)
        return [{"tenant_id": r[0], "display_name": r[1],
                 "role": r[2]} for r in await cur.fetchall()]

    cur = await conn.execute(
        """
        SELECT t.tenant_id, t.display_name, m.role, 'membership' AS via
          FROM g1.tenant_memberships m
          JOIN g1.tenants t USING (tenant_id)
         WHERE m.principal_id = %s AND m.state = 'active'
           AND t.state = 'active'
        UNION
        SELECT t.tenant_id, t.display_name, 'delegated', 'delegation'
          FROM g1.delegated_grants g
          JOIN g1.tenants t ON t.tenant_id = g.target_tenant_id
         WHERE g.principal_id = %s AND g.state = 'active'
           AND g.effective_from <= now()
           AND (g.effective_until IS NULL OR g.effective_until > now())
           AND t.state = 'active'
         ORDER BY tenant_id
        """, (principal_id, principal_id))
    return [{"tenant_id": r[0], "display_name": r[1], "role": r[2],
             "via": r[3]} for r in await cur.fetchall()]


async def allowed_source_ids(
        conn: AsyncConnection, principal_id: str,
        tenant_id: str) -> frozenset[str] | None:
    """Resource-scope refinement for monitoring sources.

    Returns None when authority is unrestricted (membership,
    platform capability, or grants without scope). Returns the
    union of active-grant `resource_scope.monitoring_source_ids`
    when every authority the principal holds on the tenant is
    scoped — a delegated operator restricted to named sources.
    """
    if await principal_is_platform_admin(conn, principal_id):
        return None

    cur = await conn.execute(
        """
        SELECT 1 FROM g1.tenant_memberships
         WHERE tenant_id = %s AND principal_id = %s
           AND state = 'active'
        """, (tenant_id, principal_id))
    if await cur.fetchone() is not None:
        return None

    cur = await conn.execute(
        """
        SELECT resource_scope FROM g1.delegated_grants
         WHERE target_tenant_id = %s AND principal_id = %s
           AND state = 'active'
           AND effective_from <= now()
           AND (effective_until IS NULL OR effective_until > now())
        """, (tenant_id, principal_id))
    scopes = [r[0] for r in await cur.fetchall()]
    if not scopes or any(
            not (s or {}).get("monitoring_source_ids") for s in scopes):
        return None
    ids: set[str] = set()
    for s in scopes:
        ids.update(str(v) for v in
                   (s or {}).get("monitoring_source_ids") or [])
    return frozenset(ids)


async def tenant_authorized(
        conn: AsyncConnection, principal_id: str,
        tenant_id: str) -> bool:
    """Membership, active grant, or platform capability — the three
    legal ways to bind a tenant (no existence leakage to callers)."""
    cur = await conn.execute(
        """
        SELECT 1 FROM g1.tenant_memberships
         WHERE tenant_id = %s AND principal_id = %s
           AND state = 'active'
        UNION
        SELECT 1 FROM g1.delegated_grants
         WHERE target_tenant_id = %s AND principal_id = %s
           AND state = 'active'
           AND effective_from <= now()
           AND (effective_until IS NULL OR effective_until > now())
        """, (tenant_id, principal_id, tenant_id, principal_id))
    if await cur.fetchone() is not None:
        return True
    return await principal_is_platform_admin(conn, principal_id)
