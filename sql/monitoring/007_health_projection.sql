-- Health projection — mirrored canonical schema (wave4 047-051).
-- Health is derived from canonical Monitoring state only; it introduces
-- no provider polling authority. 'current' evidence requires a durable
-- complete problem snapshot; 'healthy' cannot coexist with an active
-- health-affecting problem or non-current evidence.

BEGIN;

-- Extend snapshot evidence with the authority fields the health guard
-- verifies (canonical 044 columns).
ALTER TABLE monitoring.monitoring_problem_snapshot_evidence
    RENAME COLUMN complete_snapshot TO snapshot_complete;
ALTER TABLE monitoring.monitoring_problem_snapshot_evidence
    ADD COLUMN operation_state TEXT NOT NULL DEFAULT 'succeeded',
    ADD COLUMN operational_evidence_state TEXT NOT NULL DEFAULT 'current',
    ADD COLUMN configuration_revision BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN scope_revision BIGINT NOT NULL DEFAULT 1;

-- -------------------------------------------------------------------------
-- Health projection (canonical Monitoring-owned derived authority)
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS monitoring.health_projection (
    tenant_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    health_class TEXT NOT NULL
        CHECK (health_class IN ('unknown','healthy','degraded','unhealthy')),
    evidence_state TEXT NOT NULL
        CHECK (evidence_state IN
            ('current','stale','incomplete','reconciliation_required','unavailable')),
    projection_revision BIGINT NOT NULL CHECK (projection_revision > 0),
    last_changed_at TIMESTAMPTZ NOT NULL,
    last_evidence_at TIMESTAMPTZ NOT NULL,
    problem_snapshot_evidence_id TEXT NULL,
    reason_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, monitoring_resource_id, source_instance_generation),
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource(tenant_id, monitoring_resource_id)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, monitoring_source_id, source_instance_generation)
        REFERENCES monitoring.monitoring_source_generation(
            tenant_id, monitoring_source_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, problem_snapshot_evidence_id)
        REFERENCES monitoring.monitoring_problem_snapshot_evidence(
            tenant_id, snapshot_evidence_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (jsonb_typeof(reason_refs) = 'array'),
    CHECK (jsonb_array_length(reason_refs) <= 64),
    CHECK (octet_length(reason_refs::text) <= 65536),
    CHECK (last_evidence_at >= last_changed_at)
);

CREATE TABLE IF NOT EXISTS monitoring.health_projection_transition (
    tenant_id TEXT NOT NULL,
    health_transition_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    from_health_class TEXT NULL CHECK (from_health_class IS NULL
        OR from_health_class IN ('unknown','healthy','degraded','unhealthy')),
    to_health_class TEXT NOT NULL
        CHECK (to_health_class IN ('unknown','healthy','degraded','unhealthy')),
    from_evidence_state TEXT NULL CHECK (from_evidence_state IS NULL
        OR from_evidence_state IN
        ('current','stale','incomplete','reconciliation_required','unavailable')),
    to_evidence_state TEXT NOT NULL
        CHECK (to_evidence_state IN
            ('current','stale','incomplete','reconciliation_required','unavailable')),
    projection_revision BIGINT NOT NULL CHECK (projection_revision > 0),
    problem_snapshot_evidence_id TEXT NULL,
    reason_refs JSONB NOT NULL DEFAULT '[]'::jsonb,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, health_transition_id),
    UNIQUE (tenant_id, monitoring_resource_id, source_instance_generation,
            projection_revision),
    FOREIGN KEY (tenant_id, monitoring_resource_id, source_instance_generation)
        REFERENCES monitoring.health_projection(
            tenant_id, monitoring_resource_id, source_instance_generation)
        DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY (tenant_id, problem_snapshot_evidence_id)
        REFERENCES monitoring.monitoring_problem_snapshot_evidence(
            tenant_id, snapshot_evidence_id)
        DEFERRABLE INITIALLY DEFERRED,
    CHECK (jsonb_typeof(reason_refs) = 'array'),
    CHECK (jsonb_array_length(reason_refs) <= 64)
);

-- -------------------------------------------------------------------------
-- Projection guard (mirrors wave4 047 invariants)
-- -------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION monitoring.guard_health_projection_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'UPDATE' AND (
        NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
        OR NEW.monitoring_resource_id IS DISTINCT FROM OLD.monitoring_resource_id
        OR NEW.monitoring_source_id IS DISTINCT FROM OLD.monitoring_source_id
        OR NEW.source_instance_generation IS DISTINCT FROM OLD.source_instance_generation
    ) THEN
        RAISE EXCEPTION 'Health projection ownership and canonical identity are immutable';
    END IF;

    IF TG_OP = 'UPDATE'
       AND NEW.projection_revision <> OLD.projection_revision + 1 THEN
        RAISE EXCEPTION 'Health projection revision must advance exactly once';
    END IF;

    IF NEW.evidence_state = 'current' THEN
        IF NEW.problem_snapshot_evidence_id IS NULL OR NOT EXISTS (
            SELECT 1
              FROM monitoring.monitoring_problem_snapshot_evidence e
              JOIN monitoring.monitoring_source s
                ON s.tenant_id = e.tenant_id
               AND s.monitoring_source_id = e.monitoring_source_id
              JOIN monitoring.monitoring_resource r
                ON r.tenant_id = NEW.tenant_id
               AND r.monitoring_resource_id = NEW.monitoring_resource_id
             WHERE e.tenant_id = NEW.tenant_id
               AND e.snapshot_evidence_id = NEW.problem_snapshot_evidence_id
               AND e.monitoring_source_id = NEW.monitoring_source_id
               AND e.source_instance_generation = NEW.source_instance_generation
               AND e.snapshot_complete
               AND e.operation_state = 'succeeded'
               AND e.operational_evidence_state = 'current'
               AND s.active_source_instance_generation =
                   NEW.source_instance_generation
               AND s.configuration_revision = e.configuration_revision
               AND s.scope_revision = e.scope_revision
               AND s.operational_evidence_state = 'current'
               AND r.monitoring_source_id = NEW.monitoring_source_id
               AND r.source_instance_generation = NEW.source_instance_generation
               AND r.presence_state = 'present'
               AND r.presence_evidence_state = 'current'
               AND r.scope_state = 'in_scope'
               AND r.scope_evidence_state = 'current'
               AND r.scope_projection_revision = e.scope_revision
        ) THEN
            RAISE EXCEPTION 'Current Health requires current source/resource/scope and durable complete Problem State evidence';
        END IF;
    END IF;

    IF NEW.health_class = 'healthy' THEN
        IF NEW.evidence_state <> 'current' THEN
            RAISE EXCEPTION 'Healthy cannot be projected from non-current evidence';
        END IF;
        IF EXISTS (
            SELECT 1
              FROM monitoring.monitoring_problem p
             WHERE p.tenant_id = NEW.tenant_id
               AND p.monitoring_source_id = NEW.monitoring_source_id
               AND p.source_instance_generation = NEW.source_instance_generation
               AND p.monitoring_resource_id = NEW.monitoring_resource_id
               AND p.problem_state = 'active'
               AND p.severity_class IN
                   ('unknown','warning','degraded','critical')
        ) THEN
            RAISE EXCEPTION 'Healthy cannot coexist with an active health-affecting canonical problem';
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS health_projection_guard
    ON monitoring.health_projection;
CREATE TRIGGER health_projection_guard
BEFORE INSERT OR UPDATE ON monitoring.health_projection
FOR EACH ROW EXECUTE FUNCTION monitoring.guard_health_projection_mutation();

DROP TRIGGER IF EXISTS health_transition_immutable
    ON monitoring.health_projection_transition;
CREATE TRIGGER health_transition_immutable
BEFORE UPDATE OR DELETE ON monitoring.health_projection_transition
FOR EACH ROW EXECUTE FUNCTION monitoring.reject_evidence_mutation();

CREATE INDEX IF NOT EXISTS idx_health_projection_source
    ON monitoring.health_projection
    (tenant_id, monitoring_source_id, source_instance_generation);

COMMIT;
