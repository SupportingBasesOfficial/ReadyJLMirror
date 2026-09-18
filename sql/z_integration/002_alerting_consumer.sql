-- G6 Monitoring -> Alerting consumer (authorization:
-- g6.monitoring-alerting-transport@1)
--
-- Durable create-or-observe inbox receipt for the two accepted
-- integration events. This is the consumer-side resync
-- responsibility state — NEVER Alert state. The only consumer
-- effect authorized is durable_invalidation_resync_responsibility:
--   receive -> validate envelope -> create-or-observe receipt
--   -> duplicate/equivalence classify -> re-read Monitoring owner
--   -> complete resync durably.
--
-- SAME scoped message_id + equivalent meaning => ONE receipt.
-- SAME scoped message_id + different meaning  => quarantined.

CREATE TABLE IF NOT EXISTS alerting.inbox_receipt (
    tenant_id TEXT NOT NULL,
    producer_message_scope TEXT NOT NULL,
    message_id TEXT NOT NULL,
    contract_name TEXT NOT NULL CHECK (contract_name IN (
        'monitoring.problem-state.changed',
        'monitoring.health-projection.changed')),
    contract_version TEXT NOT NULL,
    producer TEXT NOT NULL,
    correlation_id TEXT NOT NULL,
    causation_id TEXT NOT NULL,
    -- Immutable equivalence evidence of the accepted envelope —
    -- redelivery compares this, never trusts broker order.
    payload_hash BYTEA NOT NULL,
    payload JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'received' CHECK (state IN (
        'received', 'processing', 'completed',
        'reconciliation_required', 'quarantined')),
    resync_result_class TEXT NULL CHECK (resync_result_class IS NULL
        OR resync_result_class IN (
            'current', 'stale_generation', 'source_missing',
            'projection_missing')),
    source_revision_current BIGINT NULL,
    claim_token TEXT NULL,
    claimed_at TIMESTAMPTZ NULL,
    last_error_class TEXT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    completed_at TIMESTAMPTZ NULL,
    PRIMARY KEY (tenant_id, producer_message_scope, message_id)
);
CREATE INDEX IF NOT EXISTS inbox_receipt_state_idx
    ON alerting.inbox_receipt (state)
    WHERE state IN ('received', 'processing', 'reconciliation_required');

ALTER TABLE alerting.inbox_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerting.inbox_receipt FORCE ROW LEVEL SECURITY;

CREATE POLICY inbox_receipt_tenant ON alerting.inbox_receipt
    USING (tenant_id = current_setting('jlmirror.tenant_id', true))
    WITH CHECK (tenant_id = current_setting('jlmirror.tenant_id', true));

GRANT SELECT ON alerting.inbox_receipt TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON alerting.inbox_receipt
    TO jlmirror_worker;
