-- G1-055: log_entry — ingestão e busca de logs por tenant
CREATE TABLE IF NOT EXISTS g1.log_entry (
    entry_id    UUID         NOT NULL DEFAULT gen_random_uuid(),
    tenant_id   TEXT         NOT NULL REFERENCES g1.tenants(tenant_id),
    resource_id TEXT         NULL,
    level       TEXT         NOT NULL DEFAULT 'INFO',
    message     TEXT         NOT NULL,
    source      TEXT         NULL,
    metadata    JSONB        NULL,
    logged_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (entry_id, logged_at)
);

SELECT create_hypertable('g1.log_entry', 'logged_at', if_not_exists => true);

ALTER TABLE g1.log_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.log_entry FORCE ROW LEVEL SECURITY;

CREATE POLICY log_entry_tenant ON g1.log_entry
    USING (tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), ''));

CREATE INDEX IF NOT EXISTS log_entry_tenant_time ON g1.log_entry(tenant_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS log_entry_resource ON g1.log_entry(tenant_id, resource_id, logged_at DESC);
CREATE INDEX IF NOT EXISTS log_entry_level ON g1.log_entry(tenant_id, level, logged_at DESC);

GRANT SELECT, INSERT, DELETE ON g1.log_entry TO jlmirror_app;
