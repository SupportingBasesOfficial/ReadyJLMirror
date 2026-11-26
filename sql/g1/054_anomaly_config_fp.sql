-- G12 AIOps: config por device/metric e false-positive marking para anomalias

BEGIN;

CREATE TABLE IF NOT EXISTS aiops.anomaly_config (
    config_id    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id    TEXT        NOT NULL,
    resource_id  TEXT        NOT NULL,
    metric_id    TEXT        NOT NULL,
    enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
    threshold    NUMERIC(6,2) NULL,  -- NULL = usa threshold global da requisição
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_by   TEXT        NOT NULL DEFAULT 'system',
    UNIQUE (tenant_id, resource_id, metric_id)
);

CREATE INDEX IF NOT EXISTS anomaly_config_tenant
    ON aiops.anomaly_config (tenant_id);

CREATE TABLE IF NOT EXISTS aiops.anomaly_false_positive (
    fp_id        UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id    TEXT        NOT NULL,
    resource_id  TEXT        NOT NULL,
    metric_id    TEXT        NOT NULL,
    note         TEXT        NOT NULL DEFAULT '',
    marked_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    marked_by    TEXT        NOT NULL DEFAULT 'system',
    UNIQUE (tenant_id, resource_id, metric_id)
);

CREATE INDEX IF NOT EXISTS anomaly_fp_tenant
    ON aiops.anomaly_false_positive (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON aiops.anomaly_config TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON aiops.anomaly_false_positive TO jlmirror_app;

COMMIT;
