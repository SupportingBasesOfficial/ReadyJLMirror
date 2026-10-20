-- G39 Client Companies — MSP empresa entities with hostgroup scope mapping.
-- Each ClientCompany groups monitoring hostgroups from one or more sources,
-- forming the foundational scope unit for alerts, SLA, users, AIOps, etc.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.client_companies (
    company_id  TEXT        PRIMARY KEY,
    tenant_id   TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    name        TEXT        NOT NULL,
    slug        TEXT        NOT NULL,
    status      TEXT        NOT NULL DEFAULT 'active'
                CHECK (status IN ('active', 'inactive', 'suspended')),
    notes       TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, slug)
);

-- Maps a (source_id, hostgroup_id) pair to a ClientCompany.
-- A hostgroup belongs to at most one company per tenant (unique constraint).
CREATE TABLE IF NOT EXISTS monitoring.company_hostgroup_scope (
    scope_id        TEXT        PRIMARY KEY,
    company_id      TEXT        NOT NULL
                    REFERENCES g1.client_companies(company_id) ON DELETE CASCADE,
    tenant_id       TEXT        NOT NULL,
    source_id       TEXT        NOT NULL,
    hostgroup_id    TEXT        NOT NULL,
    hostgroup_name  TEXT        NOT NULL DEFAULT '',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, source_id, hostgroup_id)
);

CREATE INDEX IF NOT EXISTS company_hostgroup_scope_by_company
    ON monitoring.company_hostgroup_scope (company_id);

CREATE INDEX IF NOT EXISTS company_hostgroup_scope_by_tenant_source
    ON monitoring.company_hostgroup_scope (tenant_id, source_id);

-- Associates a principal to a ClientCompany with a role.
CREATE TABLE IF NOT EXISTS g1.company_memberships (
    membership_id   TEXT        PRIMARY KEY,
    company_id      TEXT        NOT NULL
                    REFERENCES g1.client_companies(company_id) ON DELETE CASCADE,
    tenant_id       TEXT        NOT NULL,
    principal_id    TEXT        NOT NULL
                    REFERENCES g1.principals(principal_id) ON DELETE CASCADE,
    role            TEXT        NOT NULL DEFAULT 'viewer'
                    CHECK (role IN ('viewer', 'operator', 'manager')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (company_id, principal_id)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.client_companies                  TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring.company_hostgroup_scope   TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.company_memberships               TO jlmirror_app;

COMMIT;
