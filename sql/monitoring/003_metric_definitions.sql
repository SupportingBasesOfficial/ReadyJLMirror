-- Metric definitions — mirrored canonical schema (wave4 020).
-- Poll ordering authority: item_definition_poll_epoch advances only
-- through recovery; generation advances exactly +1 per admitted poll.
-- Columns mirror vendor/ProjectJLMirror/sql/wave4/
-- 020_zabbix_metric_definitions.sql; executor-role/RLS hardening
-- remains owned by the vendor production schema.

BEGIN;

-- -------------------------------------------------------------------------
-- Poll ordering authority on the source
-- -------------------------------------------------------------------------

ALTER TABLE monitoring.monitoring_source
    ADD COLUMN item_definition_poll_epoch BIGINT NOT NULL DEFAULT 1
        CHECK (item_definition_poll_epoch > 0),
    ADD COLUMN item_definition_poll_generation BIGINT NOT NULL DEFAULT 0
        CHECK (item_definition_poll_generation >= 0);

ALTER TABLE monitoring.monitoring_sync_operation
    ADD COLUMN item_definition_poll_epoch BIGINT NULL
        CHECK (item_definition_poll_epoch IS NULL OR item_definition_poll_epoch > 0),
    ADD COLUMN item_definition_poll_generation BIGINT NULL
        CHECK (item_definition_poll_generation IS NULL OR item_definition_poll_generation > 0),
    ADD COLUMN metric_definition_snapshot_evidence_id TEXT NULL;

ALTER TABLE monitoring.monitoring_sync_operation
    DROP CONSTRAINT monitoring_sync_operation_responsibility_kind_check;
ALTER TABLE monitoring.monitoring_sync_operation
    ADD CONSTRAINT monitoring_sync_operation_responsibility_kind_check
    CHECK (responsibility_kind IN (
        'validation_and_initial_sync', 'host_inventory_sync',
        'metric_definition_poll', 'manual_sync', 'scope_reconciliation',
        'replacement_candidate_validation', 'post_cutover_reconciliation'
    ));

-- -------------------------------------------------------------------------
-- Canonical metric definition
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.metric_definition (
    tenant_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    name TEXT NOT NULL,
    value_kind TEXT NOT NULL CHECK (value_kind IN
        ('number','integer','boolean','string','text','log')),
    unit TEXT NOT NULL DEFAULT '',
    scope_state TEXT NOT NULL CHECK (scope_state IN ('in_scope','out_of_scope')),
    scope_projection_revision BIGINT NOT NULL CHECK (scope_projection_revision > 0),
    scope_evidence_state TEXT NOT NULL CHECK (scope_evidence_state IN
        ('current','reconciliation_required')),
    definition_state TEXT NOT NULL CHECK (definition_state IN ('active','retired')),
    definition_evidence_state TEXT NOT NULL CHECK (definition_evidence_state IN
        ('current','incomplete','unavailable','reconciliation_required')),
    last_confirmed_present_poll_epoch BIGINT NOT NULL CHECK
        (last_confirmed_present_poll_epoch > 0),
    last_confirmed_present_poll_generation BIGINT NOT NULL CHECK
        (last_confirmed_present_poll_generation > 0),
    retired_poll_epoch BIGINT NULL CHECK (retired_poll_epoch IS NULL
        OR retired_poll_epoch > 0),
    retired_poll_generation BIGINT NULL CHECK (retired_poll_generation IS NULL
        OR retired_poll_generation > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, metric_definition_id),
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK ((definition_state = 'retired') =
           (retired_poll_epoch IS NOT NULL AND retired_poll_generation IS NOT NULL))
);

-- -------------------------------------------------------------------------
-- Provider binding (zabbix_item identity)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.metric_definition_provider_binding (
    tenant_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    provider_profile TEXT NOT NULL CHECK (provider_profile = 'zabbix'),
    provider_object_kind TEXT NOT NULL CHECK (provider_object_kind = 'zabbix_item'),
    provider_external_ref TEXT NOT NULL,
    provider_host_ref TEXT NOT NULL,
    provider_key TEXT NOT NULL,
    native_value_type TEXT NOT NULL CHECK (native_value_type IN
        ('float','unsigned','character','text','log')),
    provider_operational_state TEXT NOT NULL CHECK (provider_operational_state IN
        ('enabled','disabled','unsupported')),
    evidence_state TEXT NOT NULL CHECK (evidence_state IN
        ('current','incomplete','unavailable','reconciliation_required')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, metric_definition_id),
    UNIQUE (tenant_id, monitoring_source_id, source_instance_generation,
            provider_external_ref),
    FOREIGN KEY (tenant_id, metric_definition_id)
        REFERENCES monitoring.metric_definition(tenant_id, metric_definition_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Snapshot evidence (immutable)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_metric_definition_snapshot_evidence (
    tenant_id TEXT NOT NULL,
    metric_definition_snapshot_evidence_id TEXT NOT NULL,
    monitoring_sync_operation_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    configuration_revision BIGINT NOT NULL CHECK (configuration_revision > 0),
    scope_revision BIGINT NOT NULL CHECK (scope_revision > 0),
    item_definition_poll_epoch BIGINT NOT NULL CHECK (item_definition_poll_epoch > 0),
    item_definition_poll_generation BIGINT NOT NULL CHECK (item_definition_poll_generation > 0),
    snapshot_complete BOOLEAN NOT NULL,
    item_count BIGINT NOT NULL CHECK (item_count >= 0 AND item_count <= 200000),
    operational_evidence_state TEXT NOT NULL CHECK (operational_evidence_state IN
        ('current','incomplete','unavailable','reconciliation_required')),
    operation_state TEXT NOT NULL CHECK (operation_state IN
        ('succeeded','reconciliation_required')),
    failure_class TEXT NULL,
    egress_decision_ref TEXT NULL,
    credential_generation_ref TEXT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, metric_definition_snapshot_evidence_id),
    UNIQUE (tenant_id, monitoring_sync_operation_id),
    FOREIGN KEY (tenant_id, monitoring_sync_operation_id)
        REFERENCES monitoring.monitoring_sync_operation(tenant_id, monitoring_sync_operation_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Provider evidence per item (immutable)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_metric_definition_provider_evidence (
    tenant_id TEXT NOT NULL,
    provider_evidence_id TEXT NOT NULL,
    metric_definition_snapshot_evidence_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    provider_external_ref TEXT NOT NULL,
    normalized_evidence JSONB NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, provider_evidence_id),
    UNIQUE (tenant_id, metric_definition_snapshot_evidence_id, provider_external_ref),
    FOREIGN KEY (tenant_id, metric_definition_snapshot_evidence_id)
        REFERENCES monitoring.monitoring_metric_definition_snapshot_evidence(
            tenant_id, metric_definition_snapshot_evidence_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, metric_definition_id)
        REFERENCES monitoring.metric_definition(tenant_id, metric_definition_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (jsonb_typeof(normalized_evidence) = 'object')
);

-- Immutability for metric evidence (reuse the existing reject function)
DROP TRIGGER IF EXISTS metric_definition_snapshot_evidence_immutable
    ON monitoring.monitoring_metric_definition_snapshot_evidence;
CREATE TRIGGER metric_definition_snapshot_evidence_immutable
BEFORE UPDATE OR DELETE ON monitoring.monitoring_metric_definition_snapshot_evidence
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

DROP TRIGGER IF EXISTS metric_definition_provider_evidence_immutable
    ON monitoring.monitoring_metric_definition_provider_evidence;
CREATE TRIGGER metric_definition_provider_evidence_immutable
BEFORE UPDATE OR DELETE ON monitoring.monitoring_metric_definition_provider_evidence
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

CREATE INDEX IF NOT EXISTS idx_metric_definition_source
    ON monitoring.metric_definition (tenant_id, monitoring_source_id);
CREATE INDEX IF NOT EXISTS idx_metric_binding_ref
    ON monitoring.metric_definition_provider_binding
    (tenant_id, monitoring_source_id, source_instance_generation,
     provider_external_ref);

COMMIT;
