-- G13 Plan Catalog — catálogo de planos JL (§G13 Record #69, 2026-11-25)
-- Planos que a JL oferece para MSPs, clientes e empresas parceiras.
-- g1.contracts.plan_ref é um soft-link para plan_id aqui (sem FK para
-- não quebrar contratos existentes criados antes desta migration).

BEGIN;

CREATE TABLE IF NOT EXISTS g1.plans (
    plan_id        TEXT PRIMARY KEY
                   CHECK (plan_id ~ '^[a-z0-9][a-z0-9\-]{0,48}[a-z0-9]$'),
    display_name   TEXT NOT NULL,
    description    TEXT,
    visible        BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order     INTEGER NOT NULL DEFAULT 0,
    price_monthly  NUMERIC CHECK (price_monthly IS NULL OR price_monthly >= 0),
    price_currency TEXT NOT NULL DEFAULT 'BRL',
    state          TEXT NOT NULL DEFAULT 'active'
                   CHECK (state IN ('active', 'archived')),
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Capabilities incluídas no plano (lista aberta — novos módulos podem ser
-- adicionados sem migration, apenas via API).
CREATE TABLE IF NOT EXISTS g1.plan_capabilities (
    plan_id    TEXT NOT NULL REFERENCES g1.plans(plan_id),
    capability TEXT NOT NULL
               CHECK (capability != '' AND length(capability) <= 100),
    PRIMARY KEY (plan_id, capability)
);

-- Quotas numéricas por plano.
-- quota_key: 'max_devices', 'max_agents', 'max_users', 'max_tenants',
--            'data_retention_days', 'max_monitors', 'max_oncall_schedules'
-- quota_value: -1 = ilimitado, >= 0 = limite exato.
CREATE TABLE IF NOT EXISTS g1.plan_quotas (
    plan_id     TEXT NOT NULL REFERENCES g1.plans(plan_id),
    quota_key   TEXT NOT NULL
                CHECK (quota_key != '' AND length(quota_key) <= 100),
    quota_value INTEGER NOT NULL DEFAULT -1
                CHECK (quota_value = -1 OR quota_value >= 0),
    PRIMARY KEY (plan_id, quota_key)
);

GRANT SELECT, INSERT, UPDATE ON g1.plans TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.plan_capabilities TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.plan_quotas TO jlmirror_app;

COMMIT;
