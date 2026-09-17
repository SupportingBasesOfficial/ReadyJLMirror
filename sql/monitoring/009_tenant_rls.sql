-- Tenant isolation hardening — mirrored canonical RLS (wave4).
-- jlmirror_app is subject to FORCE RLS: every request-scoped
-- transaction must SET LOCAL jlmirror.tenant_id. jlmirror_worker
-- (worker system authority, like canonical SECURITY DEFINER executors)
-- and jlmirror_owner (migration/admin) operate cross-tenant.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles
                   WHERE rolname = 'jlmirror_worker') THEN
        CREATE ROLE jlmirror_worker
            LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT BYPASSRLS
            PASSWORD 'jlmirror_dev';
    END IF;
END;
$$;

GRANT USAGE ON SCHEMA monitoring TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA monitoring
    TO jlmirror_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA monitoring
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jlmirror_worker;
GRANT USAGE ON SCHEMA g1 TO jlmirror_worker;
GRANT SELECT ON ALL TABLES IN SCHEMA g1 TO jlmirror_worker;

CREATE OR REPLACE FUNCTION monitoring.tenant_matches(tenant_id TEXT)
RETURNS boolean LANGUAGE sql STABLE AS $$
    SELECT tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), '')
        OR current_user IN ('jlmirror_owner', 'jlmirror_worker')
$$;

DO $$
DECLARE
    t TEXT;
    policy_name TEXT;
    monitoring_tables TEXT[] := ARRAY[
        'monitoring_source', 'monitoring_source_generation',
        'monitoring_sync_operation', 'monitoring_source_create_idempotency',
        'monitoring_source_validation_evidence', 'monitoring_resource',
        'monitoring_host_inventory_snapshot_evidence',
        'monitoring_resource_provider_evidence',
        'metric_definition', 'metric_definition_provider_binding',
        'monitoring_metric_definition_snapshot_evidence',
        'monitoring_metric_definition_provider_evidence',
        'monitoring_metric_observation_acceptance', 'metric_current_state',
        'monitoring_metric_current_state_transition', 'metric_observation',
        'metric_history_stream_state', 'metric_history_gap_evidence',
        'monitoring_problem_state_runtime_admission',
        'monitoring_trigger_binding', 'monitoring_problem_provider_binding',
        'monitoring_problem', 'monitoring_problem_transition',
        'monitoring_problem_snapshot_evidence',
        'health_projection', 'health_projection_transition',
        'monitoring_outbox'
    ];
BEGIN
    FOREACH t IN ARRAY monitoring_tables LOOP
        EXECUTE format(
            'ALTER TABLE monitoring.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format(
            'ALTER TABLE monitoring.%I FORCE ROW LEVEL SECURITY', t);
        policy_name := t || '_tenant_policy';
        EXECUTE format(
            'DROP POLICY IF EXISTS %I ON monitoring.%I', policy_name, t);
        EXECUTE format(
            'CREATE POLICY %I ON monitoring.%I
             USING (monitoring.tenant_matches(tenant_id))
             WITH CHECK (monitoring.tenant_matches(tenant_id))',
            policy_name, t);
    END LOOP;
END;
$$;

COMMIT;
