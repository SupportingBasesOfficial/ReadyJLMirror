-- g1/041: Add tenant:test for existing dev databases.
-- New installs get it via 002a_seed_dev.sql. This migration ensures
-- existing dev DBs that already ran 002a also have the test tenant.
-- CI always uses a fresh DB, so this is a dev-only backfill.

INSERT INTO g1.tenants (tenant_id, display_name, state, isolation_class, cell_id)
VALUES ('tenant:test', 'Test Tenant (CI/unit tests)', 'active', 'pooled', 'cell:dev-1')
ON CONFLICT (tenant_id) DO NOTHING;
