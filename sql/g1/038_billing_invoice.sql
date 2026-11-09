-- Migration 038: Billing invoice table (G26 extension).
-- Invoices are tenant-scoped and reference a commercial account.
-- Line items stored as JSONB array for flexibility.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.billing_invoice (
    invoice_id      TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    account_id      TEXT REFERENCES g1.commercial_accounts(account_id),
    period_start    TIMESTAMPTZ NOT NULL,
    period_end      TIMESTAMPTZ NOT NULL,
    amount_cents    BIGINT NOT NULL DEFAULT 0,
    currency        TEXT NOT NULL DEFAULT 'BRL',
    status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'open', 'paid', 'void')),
    line_items      JSONB NOT NULL DEFAULT '[]'::jsonb,
    due_at          TIMESTAMPTZ,
    paid_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_tenant_status
    ON g1.billing_invoice (tenant_id, status, period_end DESC);

GRANT SELECT, INSERT, UPDATE ON g1.billing_invoice TO jlmirror_app;

COMMIT;
