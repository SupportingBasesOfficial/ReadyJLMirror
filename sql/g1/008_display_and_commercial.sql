-- Display/TV principals (contract §9 — modelable part) and the
-- commercial attribution structure (§10-12, no pricing).
--
-- Display principal: independently attributable non-human principal
-- with tenant binding, narrow read permissions (via delegated
-- grants), device credential binding, rotation/revocation, expiry.
-- The exact device/session UX remains separately authorized; the
-- token IS the credential binding.

BEGIN;

ALTER TABLE g1.principals
    DROP CONSTRAINT IF EXISTS principals_kind_check;
ALTER TABLE g1.principals
    ADD CONSTRAINT principals_kind_check
    CHECK (kind IN ('human_browser_session',
                    'platform_admin_principal',
                    'display_principal'));

-- Display device tokens — only digests are stored (same rule as
-- browser session handles).
CREATE TABLE IF NOT EXISTS g1.display_tokens (
    token_digest        TEXT PRIMARY KEY,   -- sha256 hex
    principal_id        TEXT NOT NULL
                        REFERENCES g1.principals(principal_id),
    tenant_id           TEXT NOT NULL
                        REFERENCES g1.tenants(tenant_id),
    label               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ,
    retired             BOOLEAN NOT NULL DEFAULT FALSE
);
CREATE INDEX IF NOT EXISTS idx_display_tokens_principal
    ON g1.display_tokens (principal_id) WHERE retired = FALSE;

-- -------------------------------------------------------------------------
-- Commercial attribution (§10-12) — beneficiary / payer / operator
-- separation; usage records traceable to tenant + contract. No
-- pricing/rating — structure only.
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS g1.commercial_accounts (
    account_id          TEXT PRIMARY KEY,
    organization_id     TEXT NOT NULL
                        REFERENCES g1.organizations(organization_id),
    state               TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'suspended', 'closed')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.contracts (
    contract_id         TEXT PRIMARY KEY,
    account_id          TEXT NOT NULL
                        REFERENCES g1.commercial_accounts(account_id),
    plan_ref            TEXT,
    state               TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'ended', 'suspended')),
    effective_from      TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until     TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.entitlements (
    entitlement_id      TEXT PRIMARY KEY,
    contract_id         TEXT NOT NULL
                        REFERENCES g1.contracts(contract_id),
    capability          TEXT NOT NULL,          -- e.g. monitoring, itsm
    assigned_organization_id TEXT
                        REFERENCES g1.organizations(organization_id),
    state               TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'ended')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.usage_meters (
    usage_id            TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL,
    beneficiary_organization_id TEXT
                        REFERENCES g1.organizations(organization_id),
    contract_id         TEXT REFERENCES g1.contracts(contract_id),
    billing_account_id  TEXT
                        REFERENCES g1.commercial_accounts(account_id),
    meter               TEXT NOT NULL,
    quantity            NUMERIC NOT NULL,
    window_start        TIMESTAMPTZ NOT NULL,
    window_end          TIMESTAMPTZ NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON g1.display_tokens TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.commercial_accounts TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.contracts TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.entitlements TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.usage_meters TO jlmirror_app;
GRANT SELECT ON g1.display_tokens TO jlmirror_worker;

COMMIT;
