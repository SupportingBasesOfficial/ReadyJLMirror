-- G1-057: contratos por tenant — tipos, horas contratadas, fechamento mensal
CREATE TABLE IF NOT EXISTS g1.contract (
    contract_id      UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id        TEXT         NOT NULL REFERENCES g1.tenants(tenant_id),
    client_id        TEXT         NULL,
    name             TEXT         NOT NULL,
    contract_type    TEXT         NOT NULL DEFAULT 'recurring',
    status           TEXT         NOT NULL DEFAULT 'active',
    start_date       DATE         NOT NULL,
    end_date         DATE         NULL,
    monthly_hours    NUMERIC(8,2) NULL,
    hourly_rate      NUMERIC(10,2) NULL,
    currency         TEXT         NOT NULL DEFAULT 'BRL',
    notes            TEXT         NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by       TEXT         NOT NULL DEFAULT 'system',
    CONSTRAINT contract_type_check CHECK (contract_type IN ('recurring','project','sla','retainer')),
    CONSTRAINT contract_status_check CHECK (status IN ('draft','active','suspended','closed'))
);

CREATE TABLE IF NOT EXISTS g1.contract_hour_entry (
    entry_id         UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    contract_id      UUID         NOT NULL REFERENCES g1.contract(contract_id) ON DELETE CASCADE,
    tenant_id        TEXT         NOT NULL,
    description      TEXT         NOT NULL,
    hours            NUMERIC(6,2) NOT NULL CHECK (hours > 0),
    entry_date       DATE         NOT NULL DEFAULT CURRENT_DATE,
    recorded_by      TEXT         NOT NULL DEFAULT 'system',
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.contract_closure (
    closure_id       UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    contract_id      UUID         NOT NULL REFERENCES g1.contract(contract_id) ON DELETE CASCADE,
    tenant_id        TEXT         NOT NULL,
    period_start     DATE         NOT NULL,
    period_end       DATE         NOT NULL,
    contracted_hours NUMERIC(8,2) NULL,
    used_hours       NUMERIC(8,2) NOT NULL DEFAULT 0,
    total_amount     NUMERIC(12,2) NULL,
    status           TEXT         NOT NULL DEFAULT 'open',
    closed_at        TIMESTAMPTZ  NULL,
    closed_by        TEXT         NULL,
    notes            TEXT         NULL,
    created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
    CONSTRAINT closure_status_check CHECK (status IN ('open','closed','invoiced'))
);

CREATE INDEX IF NOT EXISTS contract_tenant ON g1.contract(tenant_id);
CREATE INDEX IF NOT EXISTS contract_status ON g1.contract(tenant_id, status);
CREATE INDEX IF NOT EXISTS contract_hour_entry_contract ON g1.contract_hour_entry(contract_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS contract_hour_entry_tenant ON g1.contract_hour_entry(tenant_id, entry_date DESC);
CREATE INDEX IF NOT EXISTS contract_closure_contract ON g1.contract_closure(contract_id, period_start DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.contract TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.contract_hour_entry TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.contract_closure TO jlmirror_app;
