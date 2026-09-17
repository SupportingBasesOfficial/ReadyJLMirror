-- Monitoring core — mirrored canonical schema for the Wave 4 vertical.
--
-- Mirrors the column shapes of vendor/ProjectJLMirror/sql/wave4/
-- 001_monitoring_source_foundation.sql + 003_zabbix_initial_validation_worker.sql.
-- The canonical production schema (SECURITY DEFINER authority functions, RLS,
-- executor roles) remains the vendor SQL; this is the deployment schema for
-- the application runtime.

BEGIN;

CREATE SCHEMA IF NOT EXISTS monitoring;

-- -------------------------------------------------------------------------
-- Monitoring source (tenant-scoped attachment authority)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_source (
    tenant_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    provider_scope_tenant_binding_id TEXT NOT NULL,
    provider_profile TEXT NOT NULL CHECK (provider_profile = 'zabbix'),
    active_source_instance_generation TEXT NOT NULL,
    configuration_revision BIGINT NOT NULL CHECK (configuration_revision > 0),
    scope_revision BIGINT NOT NULL CHECK (scope_revision > 0),
    display_name TEXT NOT NULL CHECK (display_name <> ''),
    credential_binding_ref TEXT NOT NULL CHECK (credential_binding_ref <> ''),
    configured_provider_scope JSONB NOT NULL CHECK (
        jsonb_typeof(configured_provider_scope) = 'object'
        AND configured_provider_scope ? 'host_group_refs'
        AND jsonb_typeof(configured_provider_scope->'host_group_refs') = 'array'
    ),
    operational_evidence_state TEXT NOT NULL CHECK (operational_evidence_state IN (
        'current', 'stale', 'incomplete', 'reconciliation_required', 'unavailable'
    )),
    replacement_candidate_ref TEXT NULL,
    last_successful_sync_at TIMESTAMPTZ NULL,
    last_attempt_at TIMESTAMPTZ NULL,
    last_sync_operation_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, monitoring_source_id),
    UNIQUE (tenant_id, provider_scope_tenant_binding_id)
);

-- -------------------------------------------------------------------------
-- Source generation (immutable generation lineage)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_source_generation (
    tenant_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    provider_profile TEXT NOT NULL CHECK (provider_profile = 'zabbix'),
    provider_instance_ref TEXT NOT NULL CHECK (provider_instance_ref <> ''),
    provider_base_url TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, monitoring_source_id, source_instance_generation),
    FOREIGN KEY (tenant_id, monitoring_source_id)
        REFERENCES monitoring.monitoring_source(tenant_id, monitoring_source_id)
        DEFERRABLE INITIALLY DEFERRED
);

ALTER TABLE monitoring.monitoring_source
    ADD CONSTRAINT monitoring_source_active_generation_fk
    FOREIGN KEY (tenant_id, monitoring_source_id, active_source_instance_generation)
    REFERENCES monitoring.monitoring_source_generation(
        tenant_id, monitoring_source_id, source_instance_generation
    ) DEFERRABLE INITIALLY DEFERRED;

-- -------------------------------------------------------------------------
-- Sync operations (claimable work units)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_sync_operation (
    tenant_id TEXT NOT NULL,
    monitoring_sync_operation_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    configuration_revision BIGINT NOT NULL CHECK (configuration_revision > 0),
    scope_revision BIGINT NOT NULL CHECK (scope_revision > 0),
    responsibility_kind TEXT NOT NULL CHECK (responsibility_kind IN (
        'validation_and_initial_sync', 'manual_sync', 'scope_reconciliation',
        'replacement_candidate_validation', 'post_cutover_reconciliation'
    )),
    state TEXT NOT NULL CHECK (state IN (
        'pending', 'running', 'succeeded',
        'reconciliation_required', 'failed_terminal'
    )),
    claim_token TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    started_at TIMESTAMPTZ NULL,
    completed_at TIMESTAMPTZ NULL,
    last_error_class TEXT NULL,
    PRIMARY KEY (tenant_id, monitoring_sync_operation_id),
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation
        ) DEFERRABLE INITIALLY DEFERRED,
    CHECK (state <> 'running' OR started_at IS NOT NULL),
    CHECK (state NOT IN ('succeeded', 'failed_terminal') OR completed_at IS NOT NULL)
);

ALTER TABLE monitoring.monitoring_source
    ADD CONSTRAINT monitoring_source_last_sync_operation_fk
    FOREIGN KEY (tenant_id, last_sync_operation_id)
    REFERENCES monitoring.monitoring_sync_operation(tenant_id, monitoring_sync_operation_id)
    DEFERRABLE INITIALLY DEFERRED;

-- -------------------------------------------------------------------------
-- Create-source idempotency
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_source_create_idempotency (
    tenant_id TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    monitoring_sync_operation_id TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('in_progress', 'completed', 'reconciliation_required')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    completed_at TIMESTAMPTZ NULL,
    PRIMARY KEY (tenant_id, idempotency_key),
    FOREIGN KEY (tenant_id, monitoring_source_id)
        REFERENCES monitoring.monitoring_source(tenant_id, monitoring_source_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_sync_operation_id)
        REFERENCES monitoring.monitoring_sync_operation(tenant_id, monitoring_sync_operation_id)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Validation evidence
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_source_validation_evidence (
    validation_evidence_id TEXT PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    monitoring_sync_operation_id TEXT NOT NULL,
    operational_evidence_state TEXT NOT NULL CHECK (operational_evidence_state IN (
        'current', 'incomplete', 'unavailable'
    )),
    visible_host_group_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    missing_host_group_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    failure_class TEXT NULL,
    egress_decision_ref TEXT NULL,
    credential_generation_ref TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_sync_op_pending
    ON monitoring.monitoring_sync_operation (state, responsibility_kind)
    WHERE state = 'pending';

COMMIT;
