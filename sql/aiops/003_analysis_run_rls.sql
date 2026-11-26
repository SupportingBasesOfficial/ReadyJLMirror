-- Migration 003: Enable and force RLS on aiops.analysis_run.
--
-- aiops.finding already has ENABLE + FORCE RLS (001_g12_aiops_core.sql).
-- aiops.analysis_run was missing both — a superuser or table-owner session
-- could read run metadata across tenants.
--
-- jlmirror_worker has BYPASSRLS so it continues to write cross-tenant.
-- jlmirror_app sees only rows belonging to the session's tenant.

BEGIN;

ALTER TABLE aiops.analysis_run ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiops.analysis_run FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS analysis_run_tenant_policy ON aiops.analysis_run;
CREATE POLICY analysis_run_tenant_policy
    ON aiops.analysis_run
    USING (tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), ''))
    WITH CHECK (tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), ''));

COMMIT;
