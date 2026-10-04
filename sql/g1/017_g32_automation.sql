-- G32 Automation Runtime
-- Automation scripts (webhook/noop), interval schedules, and immutable run records.
-- Tenant isolation via tenant-scoped connection.

CREATE TABLE IF NOT EXISTS g1.automation_script (
    script_id       TEXT PRIMARY KEY,           -- 'auto:<uuid>'
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name            TEXT NOT NULL,              -- max 120 chars
    description     TEXT NOT NULL DEFAULT '',
    script_type     TEXT NOT NULL               -- 'webhook' | 'noop'
                        CHECK (script_type IN ('webhook', 'noop')),
    config          JSONB NOT NULL DEFAULT '{}',
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- config shape for script_type = 'webhook':
--   { "url": "https://...", "method": "POST",
--     "headers": {"X-Token": "..."}, "body_template": "..." }
-- body_template supports {{alert_id}}, {{tenant_id}}, {{timestamp}} substitutions

CREATE TABLE IF NOT EXISTS g1.automation_schedule (
    schedule_id     TEXT PRIMARY KEY,           -- 'asched:<uuid>'
    tenant_id       TEXT NOT NULL,
    script_id       TEXT NOT NULL REFERENCES g1.automation_script(script_id),
    interval_secs   INTEGER NOT NULL,           -- minimum 60
    last_run_at     TIMESTAMPTZ,
    next_run_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.automation_run (
    run_id          TEXT PRIMARY KEY,           -- 'arun:<uuid>'
    tenant_id       TEXT NOT NULL,
    script_id       TEXT NOT NULL REFERENCES g1.automation_script(script_id),
    trigger_type    TEXT NOT NULL DEFAULT 'manual'  -- 'manual' | 'schedule'
                        CHECK (trigger_type IN ('manual', 'schedule')),
    schedule_id     TEXT,
    outcome         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (outcome IN ('pending', 'success', 'failed', 'skipped')),
    http_status     INTEGER,                    -- for webhook runs
    error_detail    TEXT,                       -- max 512 chars
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_automation_script_tenant
    ON g1.automation_script (tenant_id);
CREATE INDEX IF NOT EXISTS idx_automation_schedule_due
    ON g1.automation_schedule (tenant_id, next_run_at)
    WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_automation_run_script
    ON g1.automation_run (script_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_automation_run_tenant
    ON g1.automation_run (tenant_id, created_at DESC);

-- Grants
GRANT SELECT, INSERT, UPDATE ON g1.automation_script   TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.automation_schedule TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.automation_run      TO jlmirror_app;

GRANT SELECT ON g1.automation_script   TO jlmirror_owner;
GRANT SELECT ON g1.automation_schedule TO jlmirror_owner;
GRANT SELECT ON g1.automation_run      TO jlmirror_owner;

GRANT SELECT, INSERT, UPDATE ON g1.automation_schedule TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE ON g1.automation_run      TO jlmirror_worker;
GRANT SELECT                 ON g1.automation_script   TO jlmirror_worker;
