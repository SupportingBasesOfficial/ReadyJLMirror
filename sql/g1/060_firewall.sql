-- migration 060: firewall rulesets, regras com versionamento e historico de deploy

CREATE TABLE IF NOT EXISTS g1.firewall_ruleset (
    ruleset_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name TEXT NOT NULL,
    description TEXT NULL,
    device_id TEXT NULL,
    target_host TEXT NOT NULL,
    target_port INT NOT NULL DEFAULT 22,
    target_user TEXT NOT NULL DEFAULT 'root',
    backend TEXT NOT NULL DEFAULT 'iptables',
    credential_ref TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL DEFAULT 'system',
    CONSTRAINT firewall_backend_check CHECK (backend IN ('iptables', 'nftables', 'ufw'))
);

CREATE INDEX IF NOT EXISTS idx_firewall_ruleset_tenant ON g1.firewall_ruleset (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.firewall_ruleset TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.firewall_rule (
    rule_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    ruleset_id UUID NOT NULL REFERENCES g1.firewall_ruleset(ruleset_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    position INT NOT NULL DEFAULT 100,
    action TEXT NOT NULL DEFAULT 'ACCEPT',
    direction TEXT NOT NULL DEFAULT 'INPUT',
    protocol TEXT NULL,
    src_ip TEXT NULL,
    dst_ip TEXT NULL,
    src_port TEXT NULL,
    dst_port TEXT NULL,
    comment TEXT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT firewall_action_check CHECK (action IN ('ACCEPT', 'DROP', 'REJECT', 'LOG')),
    CONSTRAINT firewall_direction_check CHECK (direction IN ('INPUT', 'OUTPUT', 'FORWARD'))
);

CREATE INDEX IF NOT EXISTS idx_firewall_rule_ruleset ON g1.firewall_rule (ruleset_id, position);
CREATE INDEX IF NOT EXISTS idx_firewall_rule_tenant ON g1.firewall_rule (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.firewall_rule TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.firewall_rule_version (
    version_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    ruleset_id UUID NOT NULL REFERENCES g1.firewall_ruleset(ruleset_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    rules_snapshot JSONB NOT NULL DEFAULT '[]',
    comment TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_firewall_version_ruleset ON g1.firewall_rule_version (ruleset_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.firewall_rule_version TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.firewall_deployment (
    deployment_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    ruleset_id UUID NOT NULL REFERENCES g1.firewall_ruleset(ruleset_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    version_id UUID NULL REFERENCES g1.firewall_rule_version(version_id),
    status TEXT NOT NULL DEFAULT 'pending',
    triggered_by TEXT NOT NULL DEFAULT 'manual',
    output TEXT NULL,
    error_message TEXT NULL,
    started_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT firewall_deploy_status_check CHECK (status IN ('pending', 'running', 'success', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_firewall_deployment_ruleset ON g1.firewall_deployment (ruleset_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.firewall_deployment TO jlmirror_app;
