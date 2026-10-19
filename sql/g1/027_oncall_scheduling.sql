-- G38 On-call scheduling — named rotations with time-bounded shifts.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.oncall_schedule (
    schedule_id  TEXT        PRIMARY KEY,
    tenant_id    TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    name         TEXT        NOT NULL,
    description  TEXT,
    timezone     TEXT        NOT NULL DEFAULT 'UTC',
    enabled      BOOLEAN     NOT NULL DEFAULT true,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, name)
);

CREATE TABLE IF NOT EXISTS g1.oncall_shift (
    shift_id     TEXT        PRIMARY KEY,
    schedule_id  TEXT        NOT NULL
                 REFERENCES g1.oncall_schedule(schedule_id) ON DELETE CASCADE,
    tenant_id    TEXT        NOT NULL,
    principal_id TEXT        NOT NULL,
    display_name TEXT,
    starts_at    TIMESTAMPTZ NOT NULL,
    ends_at      TIMESTAMPTZ NOT NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT shift_end_after_start CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS oncall_shift_range
    ON g1.oncall_shift (schedule_id, starts_at, ends_at);

CREATE INDEX IF NOT EXISTS oncall_shift_tenant_range
    ON g1.oncall_shift (tenant_id, starts_at, ends_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.oncall_schedule TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.oncall_shift    TO jlmirror_app;

COMMIT;
