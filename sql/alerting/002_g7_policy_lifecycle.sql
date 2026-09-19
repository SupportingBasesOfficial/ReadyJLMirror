-- G7 alert policy lifecycle — adapted from canonical
-- sql/alerting/001_alert_policy_lifecycle.sql (same six relations,
-- same invariants; app-role SQL style, mutations happen inside
-- tenant-scoped transactions in application code).

BEGIN;

-- The wave4 alert core model (alerting.alert / alert_transition,
-- authorized as wave4.alerting-core-model@1) is SUPERSEDED by the
-- canonical G7 relations below: immutable policy versions, pinned
-- occurrences, one-active-per-subject, decision idempotency. The
-- G6 inbox transport state (alerting.inbox_receipt) is kept.
DROP TABLE IF EXISTS alerting.alert_transition CASCADE;
DROP TABLE IF EXISTS alerting.alert CASCADE;

CREATE SCHEMA IF NOT EXISTS alerting;

CREATE TABLE alerting.alert_policy (
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, policy_id)
);

-- Immutable numbered versions. New-occurrence authority requires the
-- current effective ENABLED version; a pinned version may only
-- continue its own occurrence to terminal resolution.
CREATE TABLE alerting.alert_policy_version (
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version BIGINT NOT NULL CHECK (policy_version > 0),
    source_kind TEXT NOT NULL CHECK (source_kind IN
        ('monitoring_problem','monitoring_health_projection')),
    problem_min_severity TEXT NULL CHECK (problem_min_severity IS NULL
        OR problem_min_severity IN
        ('unknown','informational','warning','degraded','critical')),
    health_classes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    monitoring_source_id TEXT NULL,
    monitoring_resource_id TEXT NULL,
    content_hash TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    superseded_at TIMESTAMPTZ NULL,
    PRIMARY KEY (tenant_id, policy_id, policy_version),
    FOREIGN KEY (tenant_id, policy_id)
        REFERENCES alerting.alert_policy(tenant_id, policy_id),
    CHECK (
        (source_kind='monitoring_problem'
         AND problem_min_severity IS NOT NULL
         AND cardinality(health_classes)=0)
        OR
        (source_kind='monitoring_health_projection'
         AND problem_min_severity IS NULL
         AND cardinality(health_classes)>0
         AND health_classes <@ ARRAY['unknown','healthy','degraded',
                                     'unhealthy']::TEXT[]))
);

-- Exactly one effective version pointer per policy; enablement lives
-- here so a superseded version can never re-acquire authority.
CREATE TABLE alerting.alert_policy_effective_version (
    tenant_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version BIGINT NOT NULL,
    enabled BOOLEAN NOT NULL,
    effective_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, policy_id),
    FOREIGN KEY (tenant_id, policy_id, policy_version)
        REFERENCES alerting.alert_policy_version(tenant_id, policy_id,
                                                 policy_version)
);

-- Occurrence: problem identity = canonical problem_id; health
-- identity = resource that first matched. The alert is pinned to the
-- policy_version that created it.
CREATE TABLE alerting.alert (
    tenant_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version BIGINT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN
        ('monitoring_problem','monitoring_health_projection')),
    source_subject_id TEXT NOT NULL,
    monitoring_source_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    source_occurrence_revision BIGINT NOT NULL
        CHECK (source_occurrence_revision > 0),
    current_source_revision BIGINT NOT NULL
        CHECK (current_source_revision >= source_occurrence_revision),
    lifecycle_state TEXT NOT NULL
        CHECK (lifecycle_state IN ('active','resolved')),
    source_evidence_summary JSONB NOT NULL,
    opened_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    resolved_at TIMESTAMPTZ NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, alert_id),
    FOREIGN KEY (tenant_id, policy_id, policy_version)
        REFERENCES alerting.alert_policy_version(tenant_id, policy_id,
                                                 policy_version),
    CHECK (jsonb_typeof(source_evidence_summary)='object'),
    CHECK ((lifecycle_state='active' AND resolved_at IS NULL)
        OR (lifecycle_state='resolved' AND resolved_at IS NOT NULL))
);

-- At most one ACTIVE alert per (policy, subject) across versions.
CREATE UNIQUE INDEX alert_one_active_occurrence
ON alerting.alert(tenant_id, policy_id, source_kind,
                  source_subject_id)
WHERE lifecycle_state='active';

CREATE TABLE alerting.alert_transition (
    tenant_id TEXT NOT NULL,
    alert_transition_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version BIGINT NOT NULL,
    from_lifecycle_state TEXT NULL CHECK (from_lifecycle_state IS NULL
        OR from_lifecycle_state='active'),
    to_lifecycle_state TEXT NOT NULL
        CHECK (to_lifecycle_state IN ('active','resolved')),
    source_revision BIGINT NOT NULL CHECK (source_revision > 0),
    source_evidence_summary JSONB NOT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, alert_transition_id),
    FOREIGN KEY (tenant_id, alert_id)
        REFERENCES alerting.alert(tenant_id, alert_id),
    CHECK ((from_lifecycle_state IS NULL AND to_lifecycle_state='active')
        OR (from_lifecycle_state='active'
            AND to_lifecycle_state='resolved'))
);

-- Idempotency: one decision per (subject, revision, content_hash).
CREATE TABLE alerting.alert_decision (
    tenant_id TEXT NOT NULL,
    decision_id TEXT NOT NULL,
    decision_hash TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version BIGINT NOT NULL,
    source_kind TEXT NOT NULL,
    source_subject_id TEXT NOT NULL,
    source_revision BIGINT NOT NULL CHECK (source_revision > 0),
    effect_kind TEXT NOT NULL CHECK (effect_kind IN ('create','resolve')),
    alert_id TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, decision_id),
    FOREIGN KEY (tenant_id, alert_id)
        REFERENCES alerting.alert(tenant_id, alert_id)
);
CREATE UNIQUE INDEX alert_decision_idempotent
ON alerting.alert_decision
    (tenant_id, policy_id, source_kind, source_subject_id,
     source_revision, effect_kind);

ALTER TABLE alerting.alert_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_policy_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_policy_version FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_policy_effective_version
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_policy_effective_version
    FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_transition FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_decision ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_decision FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'alert_policy','alert_policy_version',
        'alert_policy_effective_version','alert',
        'alert_transition','alert_decision']
    LOOP
        EXECUTE format(
            'CREATE POLICY %I_tenant_policy ON alerting.%I
             USING (tenant_id=NULLIF(current_setting(
                 ''jlmirror.tenant_id'',true),''''))
             WITH CHECK (tenant_id=NULLIF(current_setting(
                 ''jlmirror.tenant_id'',true),''''))', t, t);
    END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON
    alerting.alert_policy,
    alerting.alert_policy_version,
    alerting.alert_policy_effective_version,
    alerting.alert,
    alerting.alert_transition,
    alerting.alert_decision
TO jlmirror_app;

GRANT SELECT, INSERT, UPDATE ON
    alerting.alert_policy,
    alerting.alert_policy_version,
    alerting.alert_policy_effective_version,
    alerting.alert,
    alerting.alert_transition,
    alerting.alert_decision
TO jlmirror_worker;

COMMIT;
