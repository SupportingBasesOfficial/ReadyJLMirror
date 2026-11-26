-- Sprint 1 Security — Apply RLS to g1 automation and alertmanager tables.
-- Pattern matches audit.audit_event (002_audit_event.sql) and notification tables.

BEGIN;

-- ── automation_script ───────────────────────────────────────────────────────
ALTER TABLE g1.automation_script ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.automation_script FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_script_tenant ON g1.automation_script
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── automation_schedule ─────────────────────────────────────────────────────
ALTER TABLE g1.automation_schedule ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.automation_schedule FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_schedule_tenant ON g1.automation_schedule
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── automation_run ──────────────────────────────────────────────────────────
ALTER TABLE g1.automation_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.automation_run FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_run_tenant ON g1.automation_run
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── automation_credential ───────────────────────────────────────────────────
ALTER TABLE g1.automation_credential ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.automation_credential FORCE ROW LEVEL SECURITY;
CREATE POLICY automation_credential_tenant ON g1.automation_credential
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── alertmanager_source_config ──────────────────────────────────────────────
ALTER TABLE g1.alertmanager_source_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.alertmanager_source_config FORCE ROW LEVEL SECURITY;
CREATE POLICY alertmanager_source_config_tenant ON g1.alertmanager_source_config
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── alertmanager_event ──────────────────────────────────────────────────────
ALTER TABLE g1.alertmanager_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.alertmanager_event FORCE ROW LEVEL SECURITY;
CREATE POLICY alertmanager_event_tenant ON g1.alertmanager_event
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

COMMIT;
