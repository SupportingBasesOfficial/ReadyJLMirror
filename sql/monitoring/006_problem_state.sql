-- Problem state — mirrored canonical schema (wave4 042-046).
-- Canonical problem identity (problem_id) binds to the scoped provider
-- eventid; transitions are immutable evidence; omission resolves only on
-- a proven-complete snapshot (authoritative_negative); resolved problems
-- cannot reopen under the same provider event identity.

BEGIN;

ALTER TABLE monitoring.monitoring_sync_operation
    DROP CONSTRAINT monitoring_sync_operation_responsibility_kind_check;
ALTER TABLE monitoring.monitoring_sync_operation
    ADD CONSTRAINT monitoring_sync_operation_responsibility_kind_check
    CHECK (responsibility_kind IN (
        'validation_and_initial_sync', 'host_inventory_sync',
        'metric_definition_poll', 'current_state_poll',
        'metric_history_sync', 'metric_history_reconciliation',
        'problem_state_sync', 'problem_state_reconciliation',
        'manual_sync', 'scope_reconciliation',
        'replacement_candidate_validation', 'post_cutover_reconciliation'
    ));

ALTER TABLE monitoring.monitoring_source
    ADD COLUMN problem_poll_epoch BIGINT NOT NULL DEFAULT 1
        CHECK (problem_poll_epoch > 0),
    ADD COLUMN problem_poll_generation BIGINT NOT NULL DEFAULT 0
        CHECK (problem_poll_generation >= 0);

ALTER TABLE monitoring.monitoring_sync_operation
    ADD COLUMN problem_poll_epoch BIGINT NULL
        CHECK (problem_poll_epoch IS NULL OR problem_poll_epoch > 0),
    ADD COLUMN problem_poll_generation BIGINT NULL
        CHECK (problem_poll_generation IS NULL OR problem_poll_generation > 0);

-- -------------------------------------------------------------------------
-- Volatile fail-closed recovery admission (independent authority stream)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_problem_state_runtime_admission (
    tenant_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    problem_poll_epoch BIGINT NOT NULL CHECK (problem_poll_epoch > 0),
    recovery_generation TEXT NOT NULL CHECK (recovery_generation <> ''),
    recovery_admission_ref TEXT NOT NULL CHECK (recovery_admission_ref <> ''),
    admitted_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, monitoring_source_id),
    FOREIGN KEY (tenant_id, monitoring_source_id)
        REFERENCES monitoring.monitoring_source(tenant_id, monitoring_source_id)
        ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Trigger -> resource association bindings (provider evidence, refreshed
-- per poll pass; feed ProblemAssociationTarget at claim time)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_trigger_binding (
    tenant_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    provider_trigger_ref TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, monitoring_source_id, source_instance_generation,
                 provider_trigger_ref),
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Stable canonical problem identity binding
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_problem_provider_binding (
    tenant_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    provider_profile TEXT NOT NULL CHECK (provider_profile = 'zabbix'),
    provider_external_ref TEXT NOT NULL,
    provider_trigger_ref TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, problem_id),
    UNIQUE (tenant_id, monitoring_source_id, source_instance_generation,
            provider_profile, provider_external_ref),
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Canonical problem projection
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_problem (
    tenant_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    problem_state TEXT NOT NULL CHECK (problem_state IN ('active','resolved')),
    severity_class TEXT NOT NULL CHECK (severity_class IN
        ('unknown','informational','warning','degraded','critical')),
    summary TEXT NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ NULL,
    last_confirmed_at TIMESTAMPTZ NOT NULL,
    evidence_state TEXT NOT NULL CHECK (evidence_state IN
        ('current','stale','incomplete','reconciliation_required','unavailable')),
    projection_revision BIGINT NOT NULL CHECK (projection_revision > 0),
    problem_poll_epoch BIGINT NOT NULL CHECK (problem_poll_epoch > 0),
    problem_poll_generation BIGINT NOT NULL CHECK (problem_poll_generation > 0),
    provider_acknowledged BOOLEAN NOT NULL DEFAULT FALSE,
    provider_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, problem_id),
    FOREIGN KEY (tenant_id, problem_id)
        REFERENCES monitoring.monitoring_problem_provider_binding(
            tenant_id, problem_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (
        (problem_state = 'active' AND resolved_at IS NULL)
        OR (problem_state = 'resolved' AND resolved_at IS NOT NULL)
    )
);

-- -------------------------------------------------------------------------
-- Immutable transition evidence
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_problem_transition (
    tenant_id TEXT NOT NULL,
    problem_transition_id TEXT NOT NULL,
    problem_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    from_problem_state TEXT NULL CHECK (from_problem_state IS NULL
        OR from_problem_state IN ('active','resolved')),
    to_problem_state TEXT NOT NULL CHECK (to_problem_state IN
        ('active','resolved')),
    from_severity_class TEXT NULL CHECK (from_severity_class IS NULL
        OR from_severity_class IN
        ('unknown','informational','warning','degraded','critical')),
    to_severity_class TEXT NOT NULL CHECK (to_severity_class IN
        ('unknown','informational','warning','degraded','critical')),
    transition_reason TEXT NOT NULL CHECK (transition_reason IN (
        'provider_positive','provider_recovery',
        'authoritative_negative','severity_change')),
    provider_evidence_ref TEXT NOT NULL,
    projection_revision BIGINT NOT NULL CHECK (projection_revision > 0),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, problem_transition_id),
    UNIQUE (tenant_id, problem_id, projection_revision),
    FOREIGN KEY (tenant_id, problem_id)
        REFERENCES monitoring.monitoring_problem_provider_binding(
            tenant_id, problem_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED
);

-- -------------------------------------------------------------------------
-- Snapshot completeness evidence (canonical 044)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.monitoring_problem_snapshot_evidence (
    tenant_id TEXT NOT NULL,
    snapshot_evidence_id TEXT NOT NULL,
    monitoring_sync_operation_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    problem_poll_epoch BIGINT NOT NULL,
    problem_poll_generation BIGINT NOT NULL,
    complete_snapshot BOOLEAN NOT NULL,
    active_problem_count INTEGER NOT NULL CHECK (active_problem_count >= 0),
    recovery_count INTEGER NOT NULL CHECK (recovery_count >= 0),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, snapshot_evidence_id),
    UNIQUE (tenant_id, monitoring_sync_operation_id)
);

DROP TRIGGER IF EXISTS problem_binding_immutable
    ON monitoring.monitoring_problem_provider_binding;
CREATE TRIGGER problem_binding_immutable
BEFORE UPDATE OR DELETE ON monitoring.monitoring_problem_provider_binding
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

DROP TRIGGER IF EXISTS problem_transition_immutable
    ON monitoring.monitoring_problem_transition;
CREATE TRIGGER problem_transition_immutable
BEFORE UPDATE OR DELETE ON monitoring.monitoring_problem_transition
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

DROP TRIGGER IF EXISTS problem_snapshot_evidence_immutable
    ON monitoring.monitoring_problem_snapshot_evidence;
CREATE TRIGGER problem_snapshot_evidence_immutable
BEFORE UPDATE OR DELETE ON monitoring.monitoring_problem_snapshot_evidence
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

CREATE INDEX IF NOT EXISTS idx_problem_active_by_source
    ON monitoring.monitoring_problem (tenant_id, monitoring_source_id)
    WHERE problem_state = 'active';
CREATE INDEX IF NOT EXISTS idx_problem_binding_event
    ON monitoring.monitoring_problem_provider_binding
    (tenant_id, monitoring_source_id, provider_external_ref);

COMMIT;
