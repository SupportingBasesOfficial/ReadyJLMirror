-- Wave 4 Alerting core model (authorization: wave4.alerting-core-model@1)
--
-- Alerting owns: alert_id, lifecycle state, immutable source-evidence
-- linkage, immutable transition history, current alert projection.
-- Monitoring remains owner of problems/health — an Alert never mirrors
-- Monitoring state, it records the accepted Alerting decision.
--
-- Lifecycle v1: active | resolved. NULL->active and active->resolved
-- are the only transitions. Resolved never reopens.

CREATE SCHEMA IF NOT EXISTS alerting AUTHORIZATION jlmirror_owner;

CREATE TABLE IF NOT EXISTS alerting.alert (
    tenant_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('active', 'resolved')),
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'monitoring_problem', 'monitoring_health_projection')),
    monitoring_source_id TEXT NOT NULL,
    source_instance_generation TEXT NOT NULL,
    monitoring_resource_id TEXT NULL,
    problem_id TEXT NULL,
    source_projection_revision BIGINT NOT NULL CHECK (source_projection_revision > 0),
    source_transition_id TEXT NOT NULL,
    policy_id TEXT NOT NULL,
    policy_version BIGINT NOT NULL CHECK (policy_version > 0),
    opened_at TIMESTAMPTZ NOT NULL,
    resolved_at TIMESTAMPTZ NULL,
    last_confirmed_at TIMESTAMPTZ NOT NULL,
    projection_revision BIGINT NOT NULL CHECK (projection_revision > 0),
    created_by_transition_id TEXT NOT NULL,
    last_transition_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, alert_id),
    -- Source-kind integrity (closed discriminant):
    -- monitoring_problem requires problem_id; health requires
    -- monitoring_resource_id and MUST NOT carry problem_id.
    CHECK (
        (source_kind = 'monitoring_problem' AND problem_id IS NOT NULL)
        OR (source_kind = 'monitoring_health_projection'
            AND monitoring_resource_id IS NOT NULL AND problem_id IS NULL)
    ),
    -- resolved_at is null while active, required when resolved,
    -- never before opened_at.
    CHECK (
        (lifecycle_state = 'active' AND resolved_at IS NULL)
        OR (lifecycle_state = 'resolved'
            AND resolved_at IS NOT NULL AND resolved_at >= opened_at)
    )
);

CREATE TABLE IF NOT EXISTS alerting.alert_transition (
    tenant_id TEXT NOT NULL,
    alert_transition_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    transition_seq BIGINT NOT NULL CHECK (transition_seq IN (1, 2)),
    from_state TEXT NULL CHECK (from_state IN ('active', 'resolved')),
    to_state TEXT NOT NULL CHECK (to_state IN ('active', 'resolved')),
    transition_reason TEXT NOT NULL,
    source_kind TEXT NOT NULL CHECK (source_kind IN (
        'monitoring_problem', 'monitoring_health_projection')),
    source_transition_id TEXT NOT NULL,
    source_projection_revision BIGINT NOT NULL CHECK (source_projection_revision > 0),
    policy_id TEXT NOT NULL,
    policy_version BIGINT NOT NULL CHECK (policy_version > 0),
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    correlation_id TEXT NOT NULL,
    causation_id TEXT NULL,
    PRIMARY KEY (tenant_id, alert_transition_id),
    FOREIGN KEY (tenant_id, alert_id)
        REFERENCES alerting.alert (tenant_id, alert_id),
    -- Only NULL->active and active->resolved are legal; seq 1 = create,
    -- seq 2 = resolve. Resolved never reopens.
    CHECK (
        (from_state IS NULL AND to_state = 'active' AND transition_seq = 1)
        OR (from_state = 'active' AND to_state = 'resolved' AND transition_seq = 2)
    )
);

-- One logical transition per seq per alert: replay dedupes on seq.
CREATE UNIQUE INDEX IF NOT EXISTS alert_transition_seq_ux
    ON alerting.alert_transition (tenant_id, alert_id, transition_seq);

-- Immutable append-only history: no UPDATE/DELETE for app or worker.
ALTER TABLE alerting.alert ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_transition FORCE ROW LEVEL SECURITY;

CREATE POLICY alert_tenant ON alerting.alert
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));
CREATE POLICY alert_transition_tenant ON alerting.alert_transition
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

GRANT USAGE ON SCHEMA alerting TO jlmirror_app, jlmirror_worker;
-- The transition engine is an application-coordinated write path
-- (same shape as monitoring onboarding writes): INSERT transitions +
-- projection INSERT/UPDATE. Transition history stays immutable.
GRANT SELECT, INSERT, UPDATE ON alerting.alert TO jlmirror_app;
GRANT SELECT, INSERT ON alerting.alert_transition TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON alerting.alert TO jlmirror_worker;
GRANT SELECT, INSERT ON alerting.alert_transition TO jlmirror_worker;
REVOKE UPDATE, DELETE ON alerting.alert_transition
    FROM jlmirror_app, jlmirror_worker;
