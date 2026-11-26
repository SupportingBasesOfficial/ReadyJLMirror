-- 065_sql_console.sql

CREATE TABLE g1.sql_console_history (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    query_text      TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed', 'failed')),
    duration_ms     INTEGER,
    row_count       INTEGER,
    error_message   TEXT,
    executed_by     UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    executed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON g1.sql_console_history (tenant_id, executed_at DESC);
CREATE INDEX ON g1.sql_console_history (executed_by);
