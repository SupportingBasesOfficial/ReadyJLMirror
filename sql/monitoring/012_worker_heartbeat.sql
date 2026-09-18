-- Worker heartbeat (ADR-017 operational diagnostics): the worker
-- pipeline upserts one row per worker_id every tick so readiness and
-- operators can tell a live pipeline from a silently dead one.
-- tenant_id 'system' keeps the standard RLS shape; the app role does
-- not read it (readiness checks run under owner/system authority).

CREATE TABLE IF NOT EXISTS monitoring.worker_heartbeat (
    tenant_id TEXT NOT NULL DEFAULT 'system',
    worker_id TEXT NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL,
    last_processed BIGINT NOT NULL DEFAULT 0,
    tick_count BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, worker_id)
);

ALTER TABLE monitoring.worker_heartbeat ENABLE ROW LEVEL SECURITY;
ALTER TABLE monitoring.worker_heartbeat FORCE ROW LEVEL SECURITY;

CREATE POLICY worker_heartbeat_tenant ON monitoring.worker_heartbeat
    USING (monitoring.tenant_matches(tenant_id))
    WITH CHECK (monitoring.tenant_matches(tenant_id));

GRANT SELECT, INSERT, UPDATE ON monitoring.worker_heartbeat
    TO jlmirror_worker;
GRANT SELECT ON monitoring.worker_heartbeat TO jlmirror_app;
