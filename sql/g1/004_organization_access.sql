-- Organization & Access layer — canonical organization operating
-- model (organization-operating-model-contract.md):
--
--   - Organization: stable business entity; Tenant stays the
--     protected boundary (OOM-INV-002).
--   - Directional organization relationships (4 canonical families).
--   - Delegated grants: explicit narrowing authority — a service
--     provider's principal operates target tenants without becoming
--     a fake member (OOM-INV-003, contract §7).
--   - Membership role vocabulary widened; roles are templates, not
--     the authorization source of truth (contract §8).
--
-- Platform-owner personnel get cross-tenant authority through the
-- 'platform_admin_principal' kind — a privileged, attributable
-- capability, never an implicit wildcard (OOM-INV-006, §14).

BEGIN;

-- -------------------------------------------------------------------------
-- Organizations
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS g1.organizations (
    organization_id     TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL,
    state               TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'retired')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE g1.tenants
    ADD COLUMN IF NOT EXISTS organization_id TEXT
    REFERENCES g1.organizations(organization_id);

-- -------------------------------------------------------------------------
-- Organization relationships — directional, independently lifecycled
-- statements of responsibility/association.
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS g1.organization_relationships (
    relationship_id         TEXT PRIMARY KEY,
    family                  TEXT NOT NULL CHECK (family IN (
        'contracts_platform',
        'provides_monitoring_service_for',
        'delegated_administration_for',
        'billing_responsible_for')),
    source_organization_id  TEXT NOT NULL
                            REFERENCES g1.organizations(organization_id),
    target_organization_id  TEXT NOT NULL
                            REFERENCES g1.organizations(organization_id),
    state                   TEXT NOT NULL DEFAULT 'active'
                            CHECK (state IN ('active', 'ended')),
    effective_from          TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until         TIMESTAMPTZ,
    evidence_ref            TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- At most one ACTIVE relationship per (family, source, target)
CREATE UNIQUE INDEX IF NOT EXISTS uq_org_relationship_active
    ON g1.organization_relationships
        (family, source_organization_id, target_organization_id)
    WHERE state = 'active';

-- -------------------------------------------------------------------------
-- Delegated grants — narrowing authority (contract §7)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS g1.delegated_grants (
    grant_id                TEXT PRIMARY KEY,
    source_organization_id  TEXT NOT NULL
                            REFERENCES g1.organizations(organization_id),
    target_tenant_id        TEXT NOT NULL
                            REFERENCES g1.tenants(tenant_id),
    principal_id            TEXT NOT NULL
                            REFERENCES g1.principals(principal_id),
    permissions             TEXT[] NOT NULL,
    resource_scope          JSONB NOT NULL DEFAULT '{}'::jsonb,
    state                   TEXT NOT NULL DEFAULT 'active'
                            CHECK (state IN ('active', 'revoked', 'expired')),
    effective_from          TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until         TIMESTAMPTZ,
    granted_by              TEXT,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    revoked_at              TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_delegated_grants_principal
    ON g1.delegated_grants (principal_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_delegated_grants_tenant
    ON g1.delegated_grants (target_tenant_id) WHERE state = 'active';

-- -------------------------------------------------------------------------
-- Membership role vocabulary — templates only (contract §8).
-- Legacy values ('member', 'tenant_admin') map to operator/admin.
-- -------------------------------------------------------------------------

ALTER TABLE g1.tenant_memberships
    DROP CONSTRAINT IF EXISTS tenant_memberships_role_check;
ALTER TABLE g1.tenant_memberships
    ADD CONSTRAINT tenant_memberships_role_check
    CHECK (role IN ('admin', 'operator', 'viewer', 'auditor',
                    'member', 'tenant_admin'));

GRANT SELECT, INSERT, UPDATE ON g1.organizations TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.organization_relationships TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.delegated_grants TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.organizations TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE ON g1.organization_relationships TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE ON g1.delegated_grants TO jlmirror_worker;

COMMIT;
