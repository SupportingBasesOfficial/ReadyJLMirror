-- Metric current state — mirrored canonical schema (wave4 030).
-- Observation acceptance envelope (dedup by provider clock) -> current
-- projection per definition -> immutable transition evidence.
-- history_projection_state preserves the mandatory later History
-- projection obligation. Runtime admission (placement/recovery) is
-- deferred — no placement authority exists yet in this deployment.

BEGIN;

-- -------------------------------------------------------------------------
-- Current-state poll ordering authority
-- -------------------------------------------------------------------------

ALTER TABLE monitoring.monitoring_source
    ADD COLUMN current_state_poll_epoch BIGINT NOT NULL DEFAULT 1
        CHECK (current_state_poll_epoch > 0),
    ADD COLUMN current_state_poll_generation BIGINT NOT NULL DEFAULT 0
        CHECK (current_state_poll_generation >= 0);

ALTER TABLE monitoring.monitoring_sync_operation
    ADD COLUMN current_state_poll_epoch BIGINT NULL
        CHECK (current_state_poll_epoch IS NULL OR current_state_poll_epoch > 0),
    ADD COLUMN current_state_poll_generation BIGINT NULL
        CHECK (current_state_poll_generation IS NULL OR current_state_poll_generation > 0);

ALTER TABLE monitoring.monitoring_sync_operation
    DROP CONSTRAINT monitoring_sync_operation_responsibility_kind_check;
ALTER TABLE monitoring.monitoring_sync_operation
    ADD CONSTRAINT monitoring_sync_operation_responsibility_kind_check
    CHECK (responsibility_kind IN (
        'validation_and_initial_sync', 'host_inventory_sync',
        'metric_definition_poll', 'current_state_poll', 'manual_sync',
        'scope_reconciliation', 'replacement_candidate_validation',
        'post_cutover_reconciliation'
    ));

-- -------------------------------------------------------------------------
-- Observation acceptance (durable envelope; NOT history materialization)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_metric_observation_acceptance (
    tenant_id TEXT NOT NULL,
    observation_id TEXT NOT NULL,
    monitoring_sync_operation_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    provider_profile TEXT NOT NULL CHECK (provider_profile = 'zabbix'),
    provider_external_ref TEXT NOT NULL,
    provider_clock BIGINT NOT NULL CHECK (provider_clock > 0),
    provider_ns INTEGER NOT NULL CHECK (provider_ns BETWEEN 0 AND 999999999),
    observed_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    value_kind TEXT NOT NULL CHECK (value_kind IN
        ('number','integer','boolean','string','text','log')),
    canonical_value JSONB NOT NULL,
    configuration_revision BIGINT NOT NULL CHECK (configuration_revision > 0),
    scope_revision BIGINT NOT NULL CHECK (scope_revision > 0),
    current_state_poll_epoch BIGINT NOT NULL CHECK (current_state_poll_epoch > 0),
    current_state_poll_generation BIGINT NOT NULL CHECK (current_state_poll_generation > 0),
    history_projection_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (history_projection_state IN ('pending','projected')),
    PRIMARY KEY (tenant_id, observation_id),
    UNIQUE (tenant_id, monitoring_source_id, source_instance_generation,
            provider_external_ref, provider_clock, provider_ns),
    FOREIGN KEY (tenant_id, monitoring_sync_operation_id)
        REFERENCES monitoring.monitoring_sync_operation(tenant_id, monitoring_sync_operation_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Current state projection
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.metric_current_state (
    tenant_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    current_observation_id TEXT NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ NOT NULL,
    value_kind TEXT NOT NULL CHECK (value_kind IN
        ('number','integer','boolean','string','text','log')),
    canonical_value JSONB NOT NULL,
    evidence_state TEXT NOT NULL CHECK (evidence_state IN
        ('current','stale','incomplete','reconciliation_required','unavailable')),
    projection_revision BIGINT NOT NULL CHECK (projection_revision > 0),
    current_state_poll_epoch BIGINT NOT NULL CHECK (current_state_poll_epoch > 0),
    current_state_poll_generation BIGINT NOT NULL CHECK (current_state_poll_generation > 0),
    last_changed_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, metric_definition_id),
    FOREIGN KEY (tenant_id, metric_definition_id)
        REFERENCES monitoring.metric_definition(tenant_id, metric_definition_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, current_observation_id)
        REFERENCES monitoring.monitoring_metric_observation_acceptance(tenant_id, observation_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Transition evidence (immutable)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_metric_current_state_transition (
    tenant_id TEXT NOT NULL,
    current_state_transition_id TEXT NOT NULL,
    metric_definition_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    from_observation_id TEXT NULL,
    to_observation_id TEXT NOT NULL,
    projection_revision BIGINT NOT NULL CHECK (projection_revision > 0),
    evidence_state TEXT NOT NULL CHECK (evidence_state IN
        ('current','stale','incomplete','reconciliation_required','unavailable')),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, current_state_transition_id),
    UNIQUE (tenant_id, metric_definition_id, to_observation_id),
    FOREIGN KEY (tenant_id, metric_definition_id)
        REFERENCES monitoring.metric_definition(tenant_id, metric_definition_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, to_observation_id)
        REFERENCES monitoring.monitoring_metric_observation_acceptance(tenant_id, observation_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED
);

DROP TRIGGER IF EXISTS current_state_transition_immutable
    ON monitoring.monitoring_metric_current_state_transition;
CREATE TRIGGER current_state_transition_immutable
BEFORE UPDATE OR DELETE ON monitoring.monitoring_metric_current_state_transition
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

CREATE INDEX IF NOT EXISTS idx_obs_acceptance_source
    ON monitoring.monitoring_metric_observation_acceptance
    (tenant_id, monitoring_source_id, source_instance_generation);
CREATE INDEX IF NOT EXISTS idx_current_state_source
    ON monitoring.metric_current_state (tenant_id, monitoring_source_id);

COMMIT;
