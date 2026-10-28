-- G31 Feature Flags per tenant
-- Allows tenant admins to enable/disable optional platform modules.

CREATE TABLE IF NOT EXISTS g1.feature_flag (
    flag_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    TEXT NOT NULL REFERENCES g1.tenants(tenant_id) ON DELETE CASCADE,
    flag_key     TEXT NOT NULL,
    enabled      BOOLEAN NOT NULL DEFAULT FALSE,
    description  TEXT,
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by   TEXT,
    UNIQUE (tenant_id, flag_key)
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_tenant ON g1.feature_flag(tenant_id);

-- Seed default flags for all existing tenants
INSERT INTO g1.feature_flag (tenant_id, flag_key, enabled, description)
SELECT t.tenant_id, f.flag_key, f.enabled, f.description
FROM g1.tenants t
CROSS JOIN (VALUES
    ('module_aiops',         true,  'AIOps e análise inteligente'),
    ('module_finops',        true,  'FinOps e gestão de custos'),
    ('module_synthetic',     true,  'Monitoramento sintético'),
    ('module_oncall',        true,  'Gestão de plantão'),
    ('module_kb',            true,  'Base de conhecimento'),
    ('module_drift',         true,  'Config drift detection'),
    ('module_executive',     true,  'Executive dashboard'),
    ('module_reports',       true,  'Relatórios agendados'),
    ('module_automation',    true,  'Automação e scripts'),
    ('module_sla',           true,  'SLA e serviços'),
    ('module_maintenance',   true,  'Janelas de manutenção'),
    ('module_chatops',       false, 'Integração Slack/Teams (beta)'),
    ('module_push',          false, 'Notificações push (beta)'),
    ('module_client_portal', false, 'Portal do cliente (beta)')
) AS f(flag_key, enabled, description)
ON CONFLICT (tenant_id, flag_key) DO NOTHING;
