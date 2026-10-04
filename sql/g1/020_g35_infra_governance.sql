-- G35 Infrastructure Governance — certificate tracking and asset inventory.

BEGIN;

-- ── Certificate tracker ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS g1.cert_tracker (
    cert_id         TEXT        PRIMARY KEY,  -- 'cert:<uuid>'
    tenant_id       TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    domain          TEXT        NOT NULL,
    port            INTEGER     NOT NULL DEFAULT 443,
    expires_at      TIMESTAMPTZ,
    issuer          TEXT,
    fingerprint_sha256 TEXT,
    last_checked_at TIMESTAMPTZ,
    check_enabled   BOOLEAN     NOT NULL DEFAULT true,
    alert_days      INTEGER     NOT NULL DEFAULT 30,
    state           TEXT        NOT NULL DEFAULT 'unknown'
                        CHECK (state IN ('ok','warning','critical','error','unknown')),
    error_detail    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, domain, port)
);

CREATE INDEX IF NOT EXISTS cert_tracker_next_check
    ON g1.cert_tracker (tenant_id, last_checked_at NULLS FIRST)
    WHERE check_enabled = true;

-- ── Asset inventory ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS g1.infra_asset (
    asset_id    TEXT        PRIMARY KEY,  -- 'asset:<uuid>'
    tenant_id   TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    name        TEXT        NOT NULL CHECK (name <> ''),
    asset_type  TEXT        NOT NULL DEFAULT 'other'
                    CHECK (asset_type IN (
                        'server','vm','container','network',
                        'storage','database','service','other'
                    )),
    status      TEXT        NOT NULL DEFAULT 'active'
                    CHECK (status IN ('active','inactive','decommissioned','maintenance')),
    ip_address  TEXT,
    location    TEXT,
    owner       TEXT,
    tags        JSONB       NOT NULL DEFAULT '{}',
    metadata    JSONB       NOT NULL DEFAULT '{}',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS infra_asset_tenant_type
    ON g1.infra_asset (tenant_id, asset_type, status);

-- ── Grants ─────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON g1.cert_tracker TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.cert_tracker TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.infra_asset TO jlmirror_app;

COMMIT;
