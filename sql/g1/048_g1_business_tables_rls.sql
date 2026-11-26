-- Sprint 3 Security — Apply FORCE RLS to g1 business data tables.
-- Pre-condition: all these tables are accessed exclusively via db_tenant_connection,
-- which sets jlmirror.tenant_id GUC before every query.
--
-- Intentionally excluded (cross-tenant or no direct tenant_id):
--   g1.apm_request_log       — platform admin cross-tenant reads
--   g1.contracts              — no direct tenant_id; joined via g1.commercial_accounts
--   g1.entitlements           — same join chain as contracts
--   g1.lgpd_deletion_requests — filtered by principal_id, not tenant_id
--   g1.tenants / g1.principals / g1.tenant_memberships — identity tables
--   g1.alertmanager_source_config — webhook cross-tenant lookup (see 047)

BEGIN;

-- ── g1.api_keys ─────────────────────────────────────────────────────────────
ALTER TABLE g1.api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.api_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY api_keys_tenant ON g1.api_keys
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.billing_invoice ───────────────────────────────────────────────────────
ALTER TABLE g1.billing_invoice ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.billing_invoice FORCE ROW LEVEL SECURITY;
CREATE POLICY billing_invoice_tenant ON g1.billing_invoice
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.tenant_branding ───────────────────────────────────────────────────────
ALTER TABLE g1.tenant_branding ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.tenant_branding FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_branding_tenant ON g1.tenant_branding
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.feature_flag ──────────────────────────────────────────────────────────
ALTER TABLE g1.feature_flag ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.feature_flag FORCE ROW LEVEL SECURITY;
CREATE POLICY feature_flag_tenant ON g1.feature_flag
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.helpdesk_category ─────────────────────────────────────────────────────
ALTER TABLE g1.helpdesk_category ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.helpdesk_category FORCE ROW LEVEL SECURITY;
CREATE POLICY helpdesk_category_tenant ON g1.helpdesk_category
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.helpdesk_ticket ───────────────────────────────────────────────────────
ALTER TABLE g1.helpdesk_ticket ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.helpdesk_ticket FORCE ROW LEVEL SECURITY;
CREATE POLICY helpdesk_ticket_tenant ON g1.helpdesk_ticket
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.helpdesk_comment ──────────────────────────────────────────────────────
ALTER TABLE g1.helpdesk_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.helpdesk_comment FORCE ROW LEVEL SECURITY;
CREATE POLICY helpdesk_comment_tenant ON g1.helpdesk_comment
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.bug_reports ───────────────────────────────────────────────────────────
ALTER TABLE g1.bug_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.bug_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY bug_reports_tenant ON g1.bug_reports
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.sla_policy ────────────────────────────────────────────────────────────
ALTER TABLE g1.sla_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.sla_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY sla_policy_tenant ON g1.sla_policy
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.sla_alert_tracker ─────────────────────────────────────────────────────
ALTER TABLE g1.sla_alert_tracker ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.sla_alert_tracker FORCE ROW LEVEL SECURITY;
CREATE POLICY sla_alert_tracker_tenant ON g1.sla_alert_tracker
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

-- ── g1.sla_breach ────────────────────────────────────────────────────────────
ALTER TABLE g1.sla_breach ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.sla_breach FORCE ROW LEVEL SECURITY;
CREATE POLICY sla_breach_tenant ON g1.sla_breach
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

COMMIT;
