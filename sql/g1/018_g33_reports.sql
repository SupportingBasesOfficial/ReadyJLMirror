-- G33 Scheduled Reports
-- Report template definitions, scheduled delivery, and delivery history.
-- Tenant isolation via tenant-scoped connection.

CREATE TABLE IF NOT EXISTS g1.report_template (
    template_id     TEXT PRIMARY KEY,           -- 'rpt:<uuid>'
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name            TEXT NOT NULL,              -- max 120 chars
    report_type     TEXT NOT NULL               -- 'alert_summary' | 'sla_summary' | 'incident_summary'
                        CHECK (report_type IN ('alert_summary', 'sla_summary', 'incident_summary')),
    delivery_email  TEXT NOT NULL,              -- recipient address
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.report_schedule (
    report_schedule_id  TEXT PRIMARY KEY,       -- 'rsched:<uuid>'
    tenant_id           TEXT NOT NULL,
    template_id         TEXT NOT NULL REFERENCES g1.report_template(template_id),
    interval_secs       INTEGER NOT NULL,       -- minimum 3600 (1 hour)
    last_sent_at        TIMESTAMPTZ,
    next_send_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    enabled             BOOLEAN NOT NULL DEFAULT true,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.report_delivery (
    delivery_id     TEXT PRIMARY KEY,           -- 'rdel:<uuid>'
    tenant_id       TEXT NOT NULL,
    template_id     TEXT NOT NULL,
    report_type     TEXT NOT NULL,
    recipient       TEXT NOT NULL,
    outcome         TEXT NOT NULL DEFAULT 'pending'
                        CHECK (outcome IN ('pending', 'sent', 'failed')),
    error_detail    TEXT,
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    row_count       INTEGER,                    -- records included in report
    delivered_at    TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_report_template_tenant
    ON g1.report_template (tenant_id);
CREATE INDEX IF NOT EXISTS idx_report_schedule_due
    ON g1.report_schedule (tenant_id, next_send_at)
    WHERE enabled = true;
CREATE INDEX IF NOT EXISTS idx_report_delivery_tenant
    ON g1.report_delivery (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON g1.report_template  TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.report_schedule  TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.report_delivery  TO jlmirror_app;

GRANT SELECT ON g1.report_template  TO jlmirror_owner;
GRANT SELECT ON g1.report_schedule  TO jlmirror_owner;
GRANT SELECT ON g1.report_delivery  TO jlmirror_owner;

GRANT SELECT, INSERT, UPDATE ON g1.report_schedule  TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE ON g1.report_delivery  TO jlmirror_worker;
GRANT SELECT                 ON g1.report_template  TO jlmirror_worker;
