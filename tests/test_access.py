"""Organization & Access layer — effective-authority resolution.

Covers the canonical separation:
  - membership role templates (deny-by-default vocabulary)
  - delegated grants (narrowing authority over a target tenant)
  - platform_admin_principal (privileged cross-tenant capability)
  - revocation/expiry of grants removing authority
"""

import asyncio
import sys

import pytest

if sys.platform == "win32":
    asyncio.set_event_loop_policy(
        asyncio.WindowsSelectorEventLoopPolicy())

pytestmark = pytest.mark.integration


@pytest.fixture
async def db():
    """Pool bound to THIS test's event loop; closed on teardown so
    worker threads don't outlive the function-scoped loop."""
    from shared.db import close_pool, db_connection, init_pool
    await init_pool()
    yield db_connection
    await close_pool()


@pytest.mark.asyncio
async def test_membership_role_templates(db):
    """Self-contained: temp principal + operator membership +
    custom role — template and custom-role resolution."""
    from shared import access
    async with db() as conn:
        await conn.execute(
            """
            INSERT INTO g1.principals
                (principal_id, kind, credential_generation)
            VALUES ('p-test-roles', 'human_browser_session', 'cg-1')
            ON CONFLICT DO NOTHING;
            INSERT INTO g1.tenant_memberships
                (membership_id, tenant_id, principal_id, role)
            VALUES ('mem-test-roles', 'tenant:dev',
                    'p-test-roles', 'operator')
            ON CONFLICT (tenant_id, principal_id)
            DO UPDATE SET role = 'operator', state = 'active';
            INSERT INTO g1.tenant_roles
                (tenant_id, role_name, permissions)
            VALUES ('tenant:dev', 'noc-test',
                    ARRAY['monitoring:read', 'observability:read'])
            ON CONFLICT (tenant_id, role_name)
            DO UPDATE SET permissions = EXCLUDED.permissions,
                          state = 'active'
            """)
        await conn.commit()

        perms = await access.effective_permissions(
            conn, "p-test-roles", "tenant:dev")
        assert "monitoring:operate" in perms
        assert "tenant:admin" not in perms

        # Custom role resolution (contract §8 — first-class)
        await conn.execute(
            "UPDATE g1.tenant_memberships SET role = 'custom:noc-test'"
            " WHERE membership_id = 'mem-test-roles'")
        await conn.commit()
        perms = await access.effective_permissions(
            conn, "p-test-roles", "tenant:dev")
        assert perms == frozenset(
            {"monitoring:read", "observability:read"})

        await conn.execute(
            "DELETE FROM g1.tenant_memberships "
            "WHERE membership_id = 'mem-test-roles';"
            "DELETE FROM g1.tenant_roles WHERE role_name = 'noc-test';"
            "DELETE FROM g1.principals "
            "WHERE principal_id = 'p-test-roles'")
        await conn.commit()


@pytest.mark.asyncio
async def test_delegated_grant_scoped_authority(db):
    from shared import access
    async with db() as conn:
        # MSP admin: membership in tenant:msp-alpha only; grant over
        # tenant:a — authority exists ONLY on the target.
        perms_a = await access.effective_permissions(
            conn, "dev-msp-admin", "tenant:a")
        assert "monitoring:operate" in perms_a

        perms_dev = await access.effective_permissions(
            conn, "dev-msp-admin", "tenant:dev")
        assert perms_dev == frozenset()

        assert await access.tenant_authorized(
            conn, "dev-msp-admin", "tenant:a")
        assert not await access.tenant_authorized(
            conn, "dev-msp-admin", "tenant:dev")


@pytest.mark.asyncio
async def test_platform_admin_cross_tenant(db):
    from shared import access
    async with db() as conn:
        assert await access.principal_is_platform_admin(
            conn, "dev-platform-admin")
        for tenant in ("tenant:dev", "tenant:a", "tenant:msp-alpha"):
            perms = await access.effective_permissions(
                conn, "dev-platform-admin", tenant)
            assert perms == access.TENANT_ALL
            assert await access.tenant_authorized(
                conn, "dev-platform-admin", tenant)

        # Ordinary human principal is NOT platform admin
        assert not await access.principal_is_platform_admin(
            conn, "dev-msp-admin")


@pytest.mark.asyncio
async def test_grant_revocation_removes_authority(db):
    from shared import access
    async with db() as conn:
        # dev-msp-admin has NO membership on tenant:dev — a temporary
        # grant is the only authority; revoking must remove it.
        await conn.execute(
            """
            INSERT INTO g1.delegated_grants
                (grant_id, source_organization_id, target_tenant_id,
                 principal_id, permissions)
            VALUES ('grant-test-revoke', 'org:msp-alpha',
                    'tenant:dev', 'dev-msp-admin',
                    ARRAY['monitoring:read'])
            ON CONFLICT (grant_id) DO UPDATE
                SET state = 'active', revoked_at = NULL
            """)
        await conn.commit()

        assert await access.tenant_authorized(
            conn, "dev-msp-admin", "tenant:dev")
        perms = await access.effective_permissions(
            conn, "dev-msp-admin", "tenant:dev")
        assert "monitoring:read" in perms

        await conn.execute(
            "UPDATE g1.delegated_grants SET state = 'revoked' "
            "WHERE grant_id = 'grant-test-revoke'")
        await conn.commit()

        assert not await access.tenant_authorized(
            conn, "dev-msp-admin", "tenant:dev")
        perms = await access.effective_permissions(
            conn, "dev-msp-admin", "tenant:dev")
        assert perms == frozenset()
        await conn.execute(
            "DELETE FROM g1.delegated_grants "
            "WHERE grant_id = 'grant-test-revoke'")
        await conn.commit()


@pytest.mark.asyncio
async def test_accessible_tenants_union(db):
    from shared import access
    async with db() as conn:
        tenants = {t["tenant_id"] for t in
                   await access.accessible_tenants(
                       conn, "dev-msp-admin")}
        assert tenants == {"tenant:msp-alpha", "tenant:a"}

        all_tenants = {t["tenant_id"] for t in
                       await access.accessible_tenants(
                           conn, "dev-platform-admin")}
        assert {"tenant:dev", "tenant:a",
                "tenant:msp-alpha"} <= all_tenants
