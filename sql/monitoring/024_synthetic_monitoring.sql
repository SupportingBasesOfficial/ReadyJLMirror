-- G37 Synthetic monitoring — HTTP health checks with periodic polling.

BEGIN;

CREATE TABLE IF NOT EXISTS monitoring.synthetic_check (
    check_id         TEXT        PRIMARY KEY,
    tenant_id        TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    name             TEXT        NOT NULL,
    check_type       TEXT        NOT NULL DEFAULT 'http',
    url              TEXT        NOT NULL,
    method           TEXT        NOT NULL DEFAULT 'GET',
    expected_status  INTEGER     NOT NULL DEFAULT 200,
    timeout_seconds  INTEGER     NOT NULL DEFAULT 10,
    interval_seconds INTEGER     NOT NULL DEFAULT 300,
    headers          JSONB,
    enabled          BOOLEAN     NOT NULL DEFAULT true,
    last_checked_at  TIMESTAMPTZ,
    last_ok          BOOLEAN,
    last_status_code INTEGER,
    last_response_ms INTEGER,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS synthetic_check_next_check
    ON monitoring.synthetic_check (tenant_id, last_checked_at NULLS FIRST)
    WHERE enabled = true;

CREATE TABLE IF NOT EXISTS monitoring.synthetic_result (
    result_id       TEXT        PRIMARY KEY,
    check_id        TEXT        NOT NULL
                    REFERENCES monitoring.synthetic_check(check_id)
                    ON DELETE CASCADE,
    tenant_id       TEXT        NOT NULL,
    checked_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ok              BOOLEAN     NOT NULL,
    status_code     INTEGER,
    response_ms     INTEGER,
    error           TEXT
);

CREATE INDEX IF NOT EXISTS synthetic_result_check_time
    ON monitoring.synthetic_result (check_id, checked_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON monitoring.synthetic_check TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE         ON monitoring.synthetic_check TO jlmirror_worker;
GRANT SELECT, INSERT                 ON monitoring.synthetic_result TO jlmirror_app;
GRANT SELECT, INSERT                 ON monitoring.synthetic_result TO jlmirror_worker;

COMMIT;
