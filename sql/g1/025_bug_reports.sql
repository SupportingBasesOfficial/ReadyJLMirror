-- G-Bug: Bug report table for in-app user feedback and bug tracking.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.bug_reports (
    report_id   TEXT        PRIMARY KEY,
    tenant_id   TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    screen_id   TEXT        NOT NULL,
    screen_url  TEXT,
    title       TEXT        NOT NULL CHECK (title <> ''),
    description TEXT        NOT NULL DEFAULT '',
    error_info  JSONB,
    user_agent  TEXT,
    reported_by TEXT        NOT NULL,
    status      TEXT        NOT NULL DEFAULT 'open'
                    CHECK (status IN ('open','in_progress','resolved','wont_fix')),
    resolution  TEXT,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS bug_reports_tenant_status
    ON g1.bug_reports (tenant_id, status, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON g1.bug_reports TO jlmirror_app;

COMMIT;
