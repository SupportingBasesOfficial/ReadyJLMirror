-- Dev webhook sink: durable receipt evidence for real HTTP
-- deliveries from the outbox dispatcher. The worker posts the
-- canonical LogicalMessage envelope to /dev/outbox-sink on the
-- API; each row proves an actual HTTP round-trip (vs. the
-- dev-log simulated receipt when no webhook is configured).
-- Dev/verification only — production delivery is the broker.

CREATE TABLE IF NOT EXISTS g1.webhook_delivery (
    delivery_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    received_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    message_id TEXT NOT NULL,
    contract_name TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    envelope JSONB NOT NULL
);

GRANT SELECT, INSERT ON g1.webhook_delivery TO jlmirror_app;
