-- Migration 032: Enable and force RLS on monitoring tables added after the
-- initial tenant isolation wave (009_tenant_rls.sql).
--
-- Tables covered:
--   monitoring.company_hostgroup_scope  (tenant_id TEXT)
--   monitoring.synthetic_check          (tenant_id TEXT)
--   monitoring.synthetic_result         (tenant_id TEXT)
--   monitoring.config_baseline          (tenant_id UUID — cast to text for policy)
--   monitoring.config_drift_event       (tenant_id UUID — cast to text for policy)
--
-- jlmirror_worker: already has BYPASSRLS + explicit grants (see below).
-- jlmirror_owner:  allowed through monitoring.tenant_matches().
-- jlmirror_app:    sees only rows where tenant_id matches the session GUC.

BEGIN;

-- ── company_hostgroup_scope (TEXT tenant_id) ────────────────────────────────

ALTER TABLE monitoring.company_hostgroup_scope ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring.company_hostgroup_scope FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS company_hostgroup_scope_tenant_policy
    ON monitoring.company_hostgroup_scope;
CREATE POLICY company_hostgroup_scope_tenant_policy
    ON monitoring.company_hostgroup_scope
    USING  (monitoring.tenant_matches(tenant_id))
    WITH CHECK (monitoring.tenant_matches(tenant_id));

GRANT SELECT, INSERT, UPDATE, DELETE
    ON monitoring.company_hostgroup_scope TO jlmirror_worker;

-- ── synthetic_check (TEXT tenant_id) ────────────────────────────────────────

ALTER TABLE monitoring.synthetic_check ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring.synthetic_check FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS synthetic_check_tenant_policy ON monitoring.synthetic_check;
CREATE POLICY synthetic_check_tenant_policy
    ON monitoring.synthetic_check
    USING  (monitoring.tenant_matches(tenant_id))
    WITH CHECK (monitoring.tenant_matches(tenant_id));

-- ── synthetic_result (TEXT tenant_id) ───────────────────────────────────────

ALTER TABLE monitoring.synthetic_result ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring.synthetic_result FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS synthetic_result_tenant_policy ON monitoring.synthetic_result;
CREATE POLICY synthetic_result_tenant_policy
    ON monitoring.synthetic_result
    USING  (monitoring.tenant_matches(tenant_id))
    WITH CHECK (monitoring.tenant_matches(tenant_id));

-- ── config_baseline (UUID tenant_id — cast required) ────────────────────────
-- tenant_id is UUID here (schema debt from early migration), so we cast to
-- text to match the monitoring.tenant_matches(text) function signature.

ALTER TABLE monitoring.config_baseline ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring.config_baseline FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS config_baseline_tenant_policy ON monitoring.config_baseline;
CREATE POLICY config_baseline_tenant_policy
    ON monitoring.config_baseline
    USING  (monitoring.tenant_matches(tenant_id::text))
    WITH CHECK (monitoring.tenant_matches(tenant_id::text));

GRANT SELECT, INSERT, UPDATE, DELETE
    ON monitoring.config_baseline TO jlmirror_app, jlmirror_worker;

-- ── config_drift_event (UUID tenant_id — cast required) ─────────────────────

ALTER TABLE monitoring.config_drift_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring.config_drift_event FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS config_drift_event_tenant_policy
    ON monitoring.config_drift_event;
CREATE POLICY config_drift_event_tenant_policy
    ON monitoring.config_drift_event
    USING  (monitoring.tenant_matches(tenant_id::text))
    WITH CHECK (monitoring.tenant_matches(tenant_id::text));

GRANT SELECT, INSERT, UPDATE, DELETE
    ON monitoring.config_drift_event TO jlmirror_app, jlmirror_worker;

COMMIT;
