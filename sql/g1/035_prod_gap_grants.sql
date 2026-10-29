-- Production gap fixes: missing grants for workers + synthetic failure tracking
-- Applied 2026-10-28

BEGIN;

-- LGPD deletion requests table (no prior migration created this)
CREATE TABLE IF NOT EXISTS g1.lgpd_deletion_requests (
    request_id   TEXT        PRIMARY KEY DEFAULT 'lgpd_' || gen_random_uuid()::text,
    principal_id TEXT        NOT NULL REFERENCES g1.principals(principal_id),
    status       TEXT        NOT NULL DEFAULT 'pending',
    requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at  TIMESTAMPTZ,
    notes        TEXT,
    CONSTRAINT lgpd_deletion_requests_status_check
        CHECK (status IN ('pending','processing','completed','rejected'))
);
CREATE INDEX IF NOT EXISTS lgpd_deletion_requests_status
    ON g1.lgpd_deletion_requests (status) WHERE status = 'pending';

-- Config drift tables — jlmirror_app and jlmirror_worker need access
-- (025_config_drift.sql was created without explicit grants)
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring.config_baseline      TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring.config_drift_event   TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE         ON monitoring.config_baseline      TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring.config_drift_event   TO jlmirror_worker;

-- Tenant settings: workers need SMTP config for per-tenant email delivery
GRANT SELECT ON g1.tenant_settings TO jlmirror_worker;

-- LGPD: API creates requests; worker processes them
GRANT SELECT, INSERT ON g1.lgpd_deletion_requests TO jlmirror_app;
GRANT SELECT, UPDATE ON g1.lgpd_deletion_requests TO jlmirror_worker;
GRANT SELECT, UPDATE ON g1.principals TO jlmirror_worker;
GRANT DELETE         ON g1.tenant_memberships TO jlmirror_worker;

-- Synthetic check failure tracking columns
ALTER TABLE monitoring.synthetic_check
    ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS alert_fired BOOLEAN NOT NULL DEFAULT false;

-- On-call shift: worker reads to route notifications
GRANT SELECT ON g1.oncall_shift     TO jlmirror_worker;
GRANT SELECT ON g1.oncall_schedule  TO jlmirror_worker;

-- config_baseline and config_drift_event were created with tenant_id/source_id
-- as UUID by mistake — all other monitoring tables use TEXT
ALTER TABLE monitoring.config_baseline
    ALTER COLUMN tenant_id TYPE TEXT,
    ALTER COLUMN source_id TYPE TEXT;
ALTER TABLE monitoring.config_drift_event
    ALTER COLUMN tenant_id TYPE TEXT,
    ALTER COLUMN source_id TYPE TEXT;

COMMIT;
