-- G35 Config Drift Detection: baselines and drift events
-- Idempotent — safe to re-run.

CREATE TABLE IF NOT EXISTS monitoring.config_baseline (
    baseline_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL,
    source_id       UUID NOT NULL,
    resource_ref    TEXT NOT NULL,
    config_key      TEXT NOT NULL,
    expected_value  TEXT NOT NULL,
    captured_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    captured_by     TEXT,
    UNIQUE (tenant_id, source_id, resource_ref, config_key)
);

CREATE TABLE IF NOT EXISTS monitoring.config_drift_event (
    drift_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    baseline_id     UUID REFERENCES monitoring.config_baseline(baseline_id) ON DELETE SET NULL,
    tenant_id       UUID NOT NULL,
    source_id       UUID NOT NULL,
    resource_ref    TEXT NOT NULL,
    config_key      TEXT NOT NULL,
    expected_value  TEXT NOT NULL,
    actual_value    TEXT NOT NULL,
    detected_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    acknowledged_at TIMESTAMPTZ,
    acknowledged_by TEXT,
    state           TEXT NOT NULL DEFAULT 'open'
                    CHECK (state IN ('open', 'acknowledged', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_config_drift_tenant
    ON monitoring.config_drift_event(tenant_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_config_drift_state
    ON monitoring.config_drift_event(tenant_id, state);
CREATE INDEX IF NOT EXISTS idx_config_baseline_tenant
    ON monitoring.config_baseline(tenant_id, source_id);
