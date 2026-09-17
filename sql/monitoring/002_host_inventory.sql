-- Host inventory — mirrored canonical schema (wave4 005).
-- Canonical resources: monitoring_resource + immutable snapshot/provider
-- evidence. Column shapes mirror vendor/ProjectJLMirror/sql/wave4/
-- 005_zabbix_host_inventory.sql; RLS and executor-role hardening remain
-- owned by the vendor production schema.

BEGIN;

-- Extend the operation responsibility kinds with host inventory.
ALTER TABLE monitoring.monitoring_sync_operation
    DROP CONSTRAINT monitoring_sync_operation_responsibility_kind_check;
ALTER TABLE monitoring.monitoring_sync_operation
    ADD CONSTRAINT monitoring_sync_operation_responsibility_kind_check
    CHECK (responsibility_kind IN (
        'validation_and_initial_sync', 'host_inventory_sync', 'manual_sync',
        'scope_reconciliation', 'replacement_candidate_validation',
        'post_cutover_reconciliation'
    ));

ALTER TABLE monitoring.monitoring_sync_operation
    ADD COLUMN host_inventory_snapshot_evidence_id TEXT NULL;

-- -------------------------------------------------------------------------
-- Canonical monitored resource (host inventory)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_resource (
    tenant_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    resource_kind TEXT NOT NULL CHECK (resource_kind = 'host'),
    provider_object_kind TEXT NOT NULL CHECK (provider_object_kind = 'zabbix_host'),
    provider_external_ref TEXT NOT NULL,
    display_name TEXT NOT NULL,
    scope_state TEXT NOT NULL CHECK (scope_state IN ('in_scope','out_of_scope')),
    scope_projection_revision BIGINT NOT NULL CHECK (scope_projection_revision > 0),
    scope_evidence_state TEXT NOT NULL CHECK (scope_evidence_state IN ('current','reconciliation_required')),
    presence_state TEXT NOT NULL CHECK (presence_state IN ('present','removed')),
    presence_evidence_state TEXT NOT NULL CHECK (presence_evidence_state IN ('current','incomplete','unavailable','reconciliation_required')),
    last_observed_at TIMESTAMPTZ NOT NULL,
    last_confirmed_present_at TIMESTAMPTZ NOT NULL,
    removed_at TIMESTAMPTZ NULL,
    latest_provider_evidence_id TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, monitoring_resource_id),
    UNIQUE (tenant_id, monitoring_source_id, source_instance_generation, provider_external_ref),
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK ((presence_state = 'removed') = (removed_at IS NOT NULL))
);

-- -------------------------------------------------------------------------
-- Snapshot evidence (immutable)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_host_inventory_snapshot_evidence (
    tenant_id TEXT NOT NULL,
    host_inventory_snapshot_evidence_id TEXT NOT NULL,
    monitoring_sync_operation_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    provider_scope_tenant_binding_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    configuration_revision BIGINT NOT NULL CHECK (configuration_revision > 0),
    scope_revision BIGINT NOT NULL CHECK (scope_revision > 0),
    provider_instance_ref TEXT NOT NULL,
    snapshot_complete BOOLEAN NOT NULL,
    host_count BIGINT NOT NULL CHECK (host_count >= 0 AND host_count <= 50000),
    operational_evidence_state TEXT NOT NULL CHECK (operational_evidence_state IN ('current','incomplete','unavailable')),
    operation_state TEXT NOT NULL CHECK (operation_state IN ('succeeded','reconciliation_required')),
    failure_class TEXT NULL,
    egress_decision_ref TEXT NULL,
    credential_generation_ref TEXT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, host_inventory_snapshot_evidence_id),
    UNIQUE (tenant_id, monitoring_sync_operation_id),
    FOREIGN KEY (tenant_id, monitoring_sync_operation_id)
        REFERENCES monitoring.monitoring_sync_operation(tenant_id, monitoring_sync_operation_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK ((operation_state = 'succeeded') = snapshot_complete),
    CHECK ((operation_state = 'succeeded') = (operational_evidence_state = 'current')),
    CHECK ((operation_state = 'succeeded') = (failure_class IS NULL))
);

-- -------------------------------------------------------------------------
-- Provider evidence per resource (immutable)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_resource_provider_evidence (
    tenant_id TEXT NOT NULL,
    provider_evidence_id TEXT NOT NULL,
    host_inventory_snapshot_evidence_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    provider_object_kind TEXT NOT NULL CHECK (provider_object_kind = 'zabbix_host'),
    provider_external_ref TEXT NOT NULL,
    evidence_fingerprint TEXT NOT NULL CHECK (evidence_fingerprint ~ '^[0-9a-f]{64}$'),
    normalized_evidence JSONB NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, provider_evidence_id),
    UNIQUE (tenant_id, host_inventory_snapshot_evidence_id, provider_external_ref),
    FOREIGN KEY (tenant_id, host_inventory_snapshot_evidence_id)
        REFERENCES monitoring.monitoring_host_inventory_snapshot_evidence(tenant_id, host_inventory_snapshot_evidence_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (jsonb_typeof(normalized_evidence) = 'object'),
    CHECK (octet_length(normalized_evidence::text) <= 65536)
);

ALTER TABLE monitoring.monitoring_resource
    ADD CONSTRAINT monitoring_resource_latest_provider_evidence_fk
    FOREIGN KEY (tenant_id, latest_provider_evidence_id)
    REFERENCES monitoring.monitoring_resource_provider_evidence(tenant_id, provider_evidence_id)
    DEFERRABLE INITIALLY DEFERRED;

-- -------------------------------------------------------------------------
-- Evidence immutability (mirrors canonical triggers)
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION monitoring.reject_evidence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'Monitoring inventory evidence is immutable';
END;
$$;

DROP TRIGGER IF EXISTS host_inventory_snapshot_evidence_immutable
    ON monitoring.monitoring_host_inventory_snapshot_evidence;
CREATE TRIGGER host_inventory_snapshot_evidence_immutable
BEFORE UPDATE OR DELETE ON monitoring.monitoring_host_inventory_snapshot_evidence
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

DROP TRIGGER IF EXISTS resource_provider_evidence_immutable
    ON monitoring.monitoring_resource_provider_evidence;
CREATE TRIGGER resource_provider_evidence_immutable
BEFORE UPDATE OR DELETE ON monitoring.monitoring_resource_provider_evidence
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

CREATE INDEX IF NOT EXISTS idx_resource_source
    ON monitoring.monitoring_resource (tenant_id, monitoring_source_id);

CREATE INDEX IF NOT EXISTS idx_sync_op_pending
    ON monitoring.monitoring_sync_operation (state, responsibility_kind)
    WHERE state = 'pending';

COMMIT;
