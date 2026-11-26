-- migration 062: motor de correlacao de alertas — regras, grupos e membros

CREATE TABLE IF NOT EXISTS g1.correlation_rule (
    rule_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name TEXT NOT NULL,
    description TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    match_severity TEXT[] NOT NULL DEFAULT '{}',
    match_source_kind TEXT NOT NULL DEFAULT '*',
    match_labels JSONB NOT NULL DEFAULT '{}',
    group_by TEXT[] NOT NULL DEFAULT '{}',
    group_window_seconds INT NOT NULL DEFAULT 300,
    group_wait_seconds INT NOT NULL DEFAULT 30,
    auto_resolve_seconds INT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_correlation_rule_tenant ON g1.correlation_rule (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.correlation_rule TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.alert_group (
    group_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    rule_id UUID NULL REFERENCES g1.correlation_rule(rule_id) ON DELETE SET NULL,
    fingerprint TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'firing',
    severity TEXT NOT NULL DEFAULT 'unknown',
    alert_count INT NOT NULL DEFAULT 0,
    labels JSONB NOT NULL DEFAULT '{}',
    summary TEXT NULL,
    acknowledged_by TEXT NULL,
    acknowledged_at TIMESTAMPTZ NULL,
    resolved_at TIMESTAMPTZ NULL,
    first_fired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, fingerprint),
    CONSTRAINT alert_group_status_check CHECK (status IN ('firing', 'acknowledged', 'resolved'))
);

CREATE INDEX IF NOT EXISTS idx_alert_group_tenant_status ON g1.alert_group (tenant_id, status, last_updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_group_rule ON g1.alert_group (rule_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.alert_group TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.alert_group_member (
    member_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    group_id UUID NOT NULL REFERENCES g1.alert_group(group_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    alert_occurrence_id TEXT NULL,
    alert_name TEXT NOT NULL,
    host_id TEXT NULL,
    severity TEXT NOT NULL DEFAULT 'unknown',
    labels JSONB NOT NULL DEFAULT '{}',
    summary TEXT NULL,
    added_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_alert_group_member_group ON g1.alert_group_member (group_id, added_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_group_member_tenant ON g1.alert_group_member (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.alert_group_member TO jlmirror_app;

-- Notify channel for SSE streaming
CREATE OR REPLACE FUNCTION g1.notify_alert_group_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    PERFORM pg_notify(
        'alert_group_' || NEW.tenant_id,
        json_build_object(
            'group_id', NEW.group_id,
            'status', NEW.status,
            'severity', NEW.severity,
            'alert_count', NEW.alert_count,
            'fingerprint', NEW.fingerprint
        )::text
    );
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_alert_group_notify ON g1.alert_group;
CREATE TRIGGER trg_alert_group_notify
    AFTER INSERT OR UPDATE ON g1.alert_group
    FOR EACH ROW EXECUTE FUNCTION g1.notify_alert_group_change();
