-- Production gap fixes: missing grants for workers + synthetic failure tracking
-- Applied 2026-10-28

BEGIN;

-- Config drift tables — jlmirror_app and jlmirror_worker need access
-- (025_config_drift.sql was created without explicit grants)
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring.config_baseline      TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring.config_drift_event   TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE         ON monitoring.config_baseline      TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring.config_drift_event   TO jlmirror_worker;

-- Tenant settings: workers need SMTP config for per-tenant email delivery
GRANT SELECT ON g1.tenant_settings TO jlmirror_worker;

-- LGPD: worker processes pending deletion requests
GRANT SELECT, UPDATE ON g1.lgpd_deletion_requests TO jlmirror_worker;
GRANT SELECT, UPDATE ON g1.principals TO jlmirror_worker;
GRANT DELETE         ON g1.tenant_membership TO jlmirror_worker;

-- Synthetic check failure tracking columns
ALTER TABLE monitoring.synthetic_check
    ADD COLUMN IF NOT EXISTS consecutive_failures INT NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS alert_fired BOOLEAN NOT NULL DEFAULT false;

-- On-call shift: worker reads to route notifications
GRANT SELECT ON g1.oncall_shift     TO jlmirror_worker;
GRANT SELECT ON g1.oncall_schedule  TO jlmirror_worker;

COMMIT;
