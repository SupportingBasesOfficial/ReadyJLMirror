-- G31 SLA Management
-- SLA definitions, per-alert SLA tracking, and breach records.
-- Tenant isolation via tenant-scoped connection.

CREATE TABLE IF NOT EXISTS g1.sla_policy (
    sla_id          TEXT PRIMARY KEY,           -- 'sla:<uuid>'
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name            TEXT NOT NULL,              -- max 120 chars
    severity_match  TEXT,                       -- NULL = match any; or alert severity value
    response_secs   INTEGER NOT NULL,           -- time-to-acknowledge SLA in seconds
    resolve_secs    INTEGER NOT NULL,           -- time-to-resolve SLA in seconds
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per-alert SLA tracking (upserted when alert is raised or ack'd)
CREATE TABLE IF NOT EXISTS g1.sla_alert_tracker (
    tracker_id          TEXT PRIMARY KEY,               -- 'slat:<uuid>'
    tenant_id           TEXT NOT NULL,
    alert_id            TEXT NOT NULL,
    sla_id              TEXT NOT NULL REFERENCES g1.sla_policy(sla_id),
    alert_fired_at      TIMESTAMPTZ NOT NULL,
    response_deadline   TIMESTAMPTZ NOT NULL,
    resolve_deadline    TIMESTAMPTZ NOT NULL,
    acknowledged_at     TIMESTAMPTZ,
    resolved_at         TIMESTAMPTZ,
    response_breached   BOOLEAN NOT NULL DEFAULT false,
    resolve_breached    BOOLEAN NOT NULL DEFAULT false,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, alert_id)
);

-- Immutable breach event log
CREATE TABLE IF NOT EXISTS g1.sla_breach (
    breach_id       TEXT PRIMARY KEY,           -- 'slabr:<uuid>'
    tenant_id       TEXT NOT NULL,
    alert_id        TEXT NOT NULL,
    sla_id          TEXT NOT NULL,
    breach_type     TEXT NOT NULL               -- 'response' | 'resolve'
                        CHECK (breach_type IN ('response', 'resolve')),
    breached_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    deadline_was    TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_sla_policy_tenant
    ON g1.sla_policy (tenant_id);
CREATE INDEX IF NOT EXISTS idx_sla_tracker_tenant_alert
    ON g1.sla_alert_tracker (tenant_id, alert_id);
CREATE INDEX IF NOT EXISTS idx_sla_tracker_unack
    ON g1.sla_alert_tracker (tenant_id, response_breached, acknowledged_at)
    WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_sla_breach_tenant
    ON g1.sla_breach (tenant_id, breached_at DESC);

-- Grants
GRANT SELECT, INSERT, UPDATE ON g1.sla_policy        TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.sla_alert_tracker TO jlmirror_app;
GRANT SELECT, INSERT         ON g1.sla_breach        TO jlmirror_app;

GRANT SELECT ON g1.sla_policy        TO jlmirror_owner;
GRANT SELECT ON g1.sla_alert_tracker TO jlmirror_owner;
GRANT SELECT ON g1.sla_breach        TO jlmirror_owner;

-- Also grant to worker role (breach detection worker needs read+update)
GRANT SELECT, INSERT, UPDATE ON g1.sla_policy        TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE ON g1.sla_alert_tracker TO jlmirror_worker;
GRANT SELECT, INSERT         ON g1.sla_breach        TO jlmirror_worker;
