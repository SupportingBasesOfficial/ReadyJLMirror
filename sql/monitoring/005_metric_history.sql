-- Metric history — mirrored canonical schema (wave4 040).
-- metric_observation reuses the durable acceptance identity (FK to
-- monitoring_metric_observation_acceptance). Stream state is an
-- independent per-(source, generation, item, value_type) checkpoint;
-- provisional high-water is not completeness authority.

BEGIN;

ALTER TABLE monitoring.monitoring_sync_operation
    DROP CONSTRAINT monitoring_sync_operation_responsibility_kind_check;
ALTER TABLE monitoring.monitoring_sync_operation
    ADD CONSTRAINT monitoring_sync_operation_responsibility_kind_check
    CHECK (responsibility_kind IN (
        'validation_and_initial_sync', 'host_inventory_sync',
        'metric_definition_poll', 'current_state_poll',
        'metric_history_sync', 'metric_history_reconciliation',
        'manual_sync', 'scope_reconciliation',
        'replacement_candidate_validation', 'post_cutover_reconciliation'
    ));

ALTER TABLE monitoring.monitoring_sync_operation
    ADD COLUMN history_time_from BIGINT NULL,
    ADD COLUMN history_time_till BIGINT NULL;

-- History-first acceptance envelopes have no current-state poll slot.
ALTER TABLE monitoring.monitoring_metric_observation_acceptance
    ALTER COLUMN current_state_poll_epoch DROP NOT NULL;
ALTER TABLE monitoring.monitoring_metric_observation_acceptance
    ALTER COLUMN current_state_poll_generation DROP NOT NULL;

-- -------------------------------------------------------------------------
-- Immutable canonical historical sample (acceptance identity reuse)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.metric_observation (
    tenant_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    provider_profile TEXT NOT NULL CHECK (provider_profile = 'zabbix'),
    provider_external_ref TEXT NOT NULL,
    provider_clock BIGINT NOT NULL CHECK (provider_clock > 0),
    provider_ns INTEGER NOT NULL CHECK (provider_ns BETWEEN 0 AND 999999999),
    observed_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL,
    projected_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    value_kind TEXT NOT NULL CHECK (value_kind IN
        ('number','integer','boolean','string','text','log')),
    canonical_value JSONB NOT NULL,
    PRIMARY KEY (tenant_id, observation_id),
    UNIQUE (tenant_id, monitoring_source_id, source_instance_generation,
            provider_external_ref, provider_clock, provider_ns),
    FOREIGN KEY (tenant_id, observation_id)
        REFERENCES monitoring.monitoring_metric_observation_acceptance(
            tenant_id, observation_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, metric_definition_id)
        REFERENCES monitoring.metric_definition(tenant_id, metric_definition_id)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Stream checkpoint (independent per logical stream)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.metric_history_stream_state (
    tenant_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    provider_external_ref TEXT NOT NULL,
    history_value_type INTEGER NOT NULL CHECK (history_value_type BETWEEN 0 AND 5),
    metric_definition_id TEXT NOT NULL,
    provisional_clock BIGINT NULL CHECK (provisional_clock IS NULL OR provisional_clock > 0),
    provisional_ns INTEGER NULL CHECK (provisional_ns IS NULL OR provisional_ns BETWEEN 0 AND 999999999),
    safe_clock BIGINT NULL CHECK (safe_clock IS NULL OR safe_clock > 0),
    safe_ns INTEGER NULL CHECK (safe_ns IS NULL OR safe_ns BETWEEN 0 AND 999999999),
    finalized_through_clock BIGINT NULL CHECK (finalized_through_clock IS NULL OR finalized_through_clock > 0),
    coverage_state TEXT NOT NULL DEFAULT 'open'
        CHECK (coverage_state IN ('open','reconciliation_required','gap','finalized')),
    checkpoint_revision BIGINT NOT NULL DEFAULT 1 CHECK (checkpoint_revision > 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, monitoring_source_id, source_instance_generation,
                 provider_external_ref, history_value_type),
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, metric_definition_id)
        REFERENCES monitoring.metric_definition(tenant_id, metric_definition_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK ((provisional_clock IS NULL) = (provisional_ns IS NULL)),
    CHECK ((safe_clock IS NULL) = (safe_ns IS NULL))
);

-- -------------------------------------------------------------------------
-- Gap evidence (immutable)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.metric_history_gap_evidence (
    tenant_id TEXT NOT NULL,
    history_gap_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    provider_external_ref TEXT NOT NULL,
    history_value_type INTEGER NOT NULL CHECK (history_value_type BETWEEN 0 AND 5),
    metric_definition_id TEXT NOT NULL,
    gap_from_clock BIGINT NOT NULL CHECK (gap_from_clock > 0),
    gap_through_clock BIGINT NOT NULL CHECK (gap_through_clock >= gap_from_clock),
    reason TEXT NOT NULL CHECK (reason IN (
        'provider_retention_loss','provider_visibility_uncertain',
        'truncated_window','recovery_gap')),
    evidence_ref TEXT NULL,
    detected_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, history_gap_id),
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation,
                 provider_external_ref, history_value_type)
        REFERENCES monitoring.metric_history_stream_state(
            tenant_id, monitoring_source_id, source_instance_generation,
            provider_external_ref, history_value_type)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, metric_definition_id)
        REFERENCES monitoring.metric_definition(tenant_id, metric_definition_id)
        DEFERRABLE INITIALLY DEFERRED
);

DROP TRIGGER IF EXISTS metric_history_gap_evidence_immutable
    ON monitoring.metric_history_gap_evidence;
CREATE TRIGGER metric_history_gap_evidence_immutable
BEFORE UPDATE OR DELETE ON monitoring.metric_history_gap_evidence
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

DROP TRIGGER IF EXISTS metric_observation_immutable
    ON monitoring.metric_observation;
CREATE TRIGGER metric_observation_immutable
BEFORE UPDATE OR DELETE ON monitoring.metric_observation
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

CREATE INDEX IF NOT EXISTS idx_metric_observation_stream
    ON monitoring.metric_observation
    (tenant_id, monitoring_source_id, provider_external_ref, provider_clock);
CREATE INDEX IF NOT EXISTS idx_acceptance_pending_projection
    ON monitoring.monitoring_metric_observation_acceptance (tenant_id, monitoring_source_id)
    WHERE history_projection_state = 'pending';

COMMIT;
