-- Custom roles — first-class per contract §8. A tenant administrator
-- defines tenant-scoped roles as named permission sets; memberships
-- bind them via 'custom:<name>'.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.tenant_roles (
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    role_name       TEXT NOT NULL,
    permissions     TEXT[] NOT NULL,
    state           TEXT NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active', 'retired')),
    created_by      TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (tenant_id, role_name),
    CHECK (role_name ~ '^[a-z0-9][a-z0-9_-]{0,39}$')
);

-- Membership roles now allow 'custom:<name>' in addition to the
-- built-in templates.
ALTER TABLE g1.tenant_memberships
    DROP CONSTRAINT IF EXISTS tenant_memberships_role_check;
ALTER TABLE g1.tenant_memberships
    ADD CONSTRAINT tenant_memberships_role_check
    CHECK (role IN ('admin', 'operator', 'viewer', 'auditor',
                    'member', 'tenant_admin')
           OR role ~ '^custom:[a-z0-9][a-z0-9_-]{0,39}$');

GRANT SELECT, INSERT, UPDATE ON g1.tenant_roles TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.tenant_roles TO jlmirror_worker;

COMMIT;
