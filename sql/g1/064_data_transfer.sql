-- 064_data_transfer.sql

CREATE TABLE g1.export_template (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    name            TEXT NOT NULL,
    entity_type     TEXT NOT NULL,
    columns         JSONB NOT NULL DEFAULT '[]',
    filters         JSONB NOT NULL DEFAULT '{}',
    format          TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'xlsx', 'json')),
    created_by      UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE g1.export_job (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    template_id     UUID REFERENCES g1.export_template(id) ON DELETE SET NULL,
    entity_type     TEXT NOT NULL,
    format          TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'xlsx', 'json')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    filters         JSONB NOT NULL DEFAULT '{}',
    columns         JSONB NOT NULL DEFAULT '[]',
    row_count       INT,
    file_size_bytes BIGINT,
    file_key        TEXT,
    error_message   TEXT,
    created_by      UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE TABLE g1.import_job (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    entity_type     TEXT NOT NULL,
    format          TEXT NOT NULL DEFAULT 'csv' CHECK (format IN ('csv', 'xlsx', 'json')),
    status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'validating', 'importing', 'completed', 'failed', 'cancelled')),
    file_name       TEXT NOT NULL,
    file_size_bytes BIGINT,
    file_key        TEXT,
    mapping         JSONB NOT NULL DEFAULT '{}',
    row_count       INT,
    imported_count  INT,
    error_count     INT,
    errors          JSONB NOT NULL DEFAULT '[]',
    error_message   TEXT,
    created_by      UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX ON g1.export_template (tenant_id);
CREATE INDEX ON g1.export_job (tenant_id, created_at DESC);
CREATE INDEX ON g1.export_job (tenant_id, status);
CREATE INDEX ON g1.import_job (tenant_id, created_at DESC);
CREATE INDEX ON g1.import_job (tenant_id, status);
