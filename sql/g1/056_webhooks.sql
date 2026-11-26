-- G1-056: webhook_endpoint + webhook_delivery — webhooks de saida por tenant
CREATE TABLE IF NOT EXISTS g1.webhook_endpoint (
    endpoint_id  UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id    TEXT         NOT NULL REFERENCES g1.tenants(tenant_id),
    name         TEXT         NOT NULL,
    url          TEXT         NOT NULL,
    secret       TEXT         NOT NULL,
    event_types  TEXT[]       NOT NULL DEFAULT ARRAY['alert.triggered','alert.resolved'],
    enabled      BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
    created_by   TEXT         NOT NULL DEFAULT 'system'
);

CREATE TABLE IF NOT EXISTS g1.webhook_delivery (
    delivery_id    UUID         NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    endpoint_id    UUID         NOT NULL REFERENCES g1.webhook_endpoint(endpoint_id) ON DELETE CASCADE,
    tenant_id      TEXT         NOT NULL,
    event_type     TEXT         NOT NULL,
    payload        JSONB        NOT NULL,
    status         TEXT         NOT NULL DEFAULT 'pending',
    response_code  INT          NULL,
    response_body  TEXT         NULL,
    attempt_count  INT          NOT NULL DEFAULT 0,
    delivered_at   TIMESTAMPTZ  NULL,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS webhook_endpoint_tenant ON g1.webhook_endpoint(tenant_id);
CREATE INDEX IF NOT EXISTS webhook_delivery_endpoint ON g1.webhook_delivery(endpoint_id, created_at DESC);
CREATE INDEX IF NOT EXISTS webhook_delivery_tenant   ON g1.webhook_delivery(tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.webhook_endpoint TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.webhook_delivery TO jlmirror_app;
