-- G1-058: capacity metrics (hypertable) + thresholds por recurso/metrica
CREATE TABLE IF NOT EXISTS g1.capacity_metric (
    metric_id    UUID         NOT NULL DEFAULT gen_random_uuid(),
    tenant_id    TEXT         NOT NULL REFERENCES g1.tenants(tenant_id),
    resource_id  TEXT         NOT NULL,
    resource_name TEXT        NULL,
    metric_name  TEXT         NOT NULL,
    value        NUMERIC(10,4) NOT NULL,
    unit         TEXT         NOT NULL DEFAULT '%',
    sampled_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    PRIMARY KEY (metric_id, sampled_at)
);
SELECT create_hypertable('g1.capacity_metric', 'sampled_at', if_not_exists => true);
ALTER TABLE g1.capacity_metric ENABLE ROW LEVEL SECURITY;
ALTER TABLE g1.capacity_metric FORCE ROW LEVEL SECURITY;
CREATE POLICY capacity_metric_tenant ON g1.capacity_metric
    USING (tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), ''));

CREATE TABLE IF NOT EXISTS g1.capacity_threshold (
    threshold_id UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id    TEXT         NOT NULL REFERENCES g1.tenants(tenant_id),
    resource_id  TEXT         NOT NULL,
    metric_name  TEXT         NOT NULL,
    warn_pct     NUMERIC(6,2) NOT NULL DEFAULT 70,
    crit_pct     NUMERIC(6,2) NOT NULL DEFAULT 90,
    enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by   TEXT         NOT NULL DEFAULT 'system',
    UNIQUE (tenant_id, resource_id, metric_name)
);

CREATE INDEX IF NOT EXISTS capacity_metric_tenant_resource ON g1.capacity_metric(tenant_id, resource_id, sampled_at DESC);
CREATE INDEX IF NOT EXISTS capacity_metric_tenant_metric ON g1.capacity_metric(tenant_id, metric_name, sampled_at DESC);
CREATE INDEX IF NOT EXISTS capacity_threshold_tenant ON g1.capacity_threshold(tenant_id);

GRANT SELECT, INSERT, DELETE ON g1.capacity_metric TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.capacity_threshold TO jlmirror_app;
