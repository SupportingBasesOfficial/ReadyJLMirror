-- G1 development seed — a single dev tenant.
--
-- Principals are JIT-provisioned on first login in development mode and
-- granted membership to this tenant. In production, principals and
-- memberships are provisioned through governed flows only.

BEGIN;

INSERT INTO g1.tenants (tenant_id, display_name, state, isolation_class, cell_id)
VALUES ('tenant:dev', 'Development Tenant', 'active', 'pooled', 'cell:dev-1')
ON CONFLICT (tenant_id) DO NOTHING;

COMMIT;
