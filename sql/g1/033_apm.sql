-- G-APM: API Performance Monitoring request log
-- Populated by APMMiddleware in api/main.py; kept 7 days (purged via DELETE endpoint).

CREATE TABLE IF NOT EXISTS g1.apm_request_log (
    id            BIGSERIAL PRIMARY KEY,
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    tenant_id     TEXT,
    principal_id  TEXT,
    method        TEXT NOT NULL,
    path          TEXT NOT NULL,
    status_code   INT  NOT NULL,
    duration_ms   DOUBLE PRECISION NOT NULL
);

CREATE INDEX IF NOT EXISTS apm_request_log_tenant_ts
    ON g1.apm_request_log (tenant_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS apm_request_log_ts
    ON g1.apm_request_log (recorded_at DESC);
