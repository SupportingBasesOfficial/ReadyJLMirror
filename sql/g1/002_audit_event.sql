-- Audit trail (SEC-AUD / ADR-008): durable, immutable, append-only
-- record of authoritative mutations. Written in the SAME transaction
-- as the mutation it describes — mutation rollback => audit rollback.
-- Distinct from structured logs: logs are operational telemetry;
-- this is accountability evidence surviving log retention windows.

CREATE SCHEMA IF NOT EXISTS audit AUTHORIZATION jlmirror_owner;

CREATE TABLE IF NOT EXISTS audit.audit_event (
    tenant_id TEXT NOT NULL,
    audit_event_id TEXT NOT NULL,
    action TEXT NOT NULL,
    actor_kind TEXT NOT NULL CHECK (actor_kind IN (
        'principal', 'system', 'worker', 'operator')),
    actor_id TEXT NULL,
    subject_type TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    detail JSONB NOT NULL DEFAULT '{}'::jsonb,
    correlation_id TEXT NULL,
    occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, audit_event_id)
);
CREATE INDEX IF NOT EXISTS audit_event_action_idx
    ON audit.audit_event (tenant_id, action, occurred_at);
CREATE INDEX IF NOT EXISTS audit_event_subject_idx
    ON audit.audit_event (tenant_id, subject_type, subject_id);

ALTER TABLE audit.audit_event ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit.audit_event FORCE ROW LEVEL SECURITY;

CREATE POLICY audit_event_tenant ON audit.audit_event
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

GRANT USAGE ON SCHEMA audit TO jlmirror_app, jlmirror_worker;
-- Append-only for every application role: INSERT + SELECT, never
-- UPDATE/DELETE — accountability evidence is immutable.
GRANT SELECT, INSERT ON audit.audit_event TO jlmirror_app;
GRANT SELECT, INSERT ON audit.audit_event TO jlmirror_worker;
REVOKE UPDATE, DELETE ON audit.audit_event
    FROM jlmirror_app, jlmirror_worker;
