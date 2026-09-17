-- Monitoring publication outbox — durable transactional outbox.
-- Domain events (problem opened/resolved, health changed) are appended
-- inside the same transaction as the projection mutation, so publication
-- can never diverge from platform truth. Dispatch is claim/publish/
-- quarantine with explicit ambiguity handling.

BEGIN;

CREATE TABLE IF NOT EXISTS monitoring.monitoring_outbox (
    tenant_id TEXT NOT NULL,
    record_id BIGINT GENERATED ALWAYS AS IDENTITY,
    message_id TEXT NOT NULL,
    producer_message_scope TEXT NOT NULL,
    message_class TEXT NOT NULL CHECK (message_class IN (
        'domain_event','integration_event','job_command',
        'process_signal','realtime_projection',
        'outbound_webhook_delivery')),
    contract_name TEXT NOT NULL,
    contract_version TEXT NOT NULL,
    producer TEXT NOT NULL,
    scope TEXT NOT NULL CHECK (scope IN ('tenant','global')),
    correlation_id TEXT NOT NULL,
    data_classification TEXT NOT NULL,
    serialization_profile_id TEXT NOT NULL,
    encoded_payload BYTEA NOT NULL,
    comparison_evidence BYTEA NOT NULL,
    comparison_profile_id TEXT NOT NULL,
    comparison_profile_version TEXT NOT NULL,
    subject_type TEXT NULL,
    subject_id TEXT NULL,
    occurred_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NULL,
    dispatch_state TEXT NOT NULL DEFAULT 'pending'
        CHECK (dispatch_state IN ('pending','claimed','published','quarantined')),
    claim_owner TEXT NULL,
    claim_expires_at TIMESTAMPTZ NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
    last_error_class TEXT NULL,
    published_receipt_id TEXT NULL,
    published_at TIMESTAMPTZ NULL,
    appended_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, record_id),
    UNIQUE (tenant_id, producer_message_scope, message_id),
    CHECK (
        (message_class IN ('domain_event','integration_event','realtime_projection')
            AND occurred_at IS NOT NULL AND created_at IS NULL)
        OR (message_class IN ('job_command','process_signal','outbound_webhook_delivery')
            AND created_at IS NOT NULL AND occurred_at IS NULL)
    )
);

DROP TRIGGER IF EXISTS monitoring_outbox_immutable
    ON monitoring.monitoring_outbox;

CREATE INDEX IF NOT EXISTS idx_monitoring_outbox_pending
    ON monitoring.monitoring_outbox (tenant_id, record_id)
    WHERE dispatch_state = 'pending';
CREATE INDEX IF NOT EXISTS idx_monitoring_outbox_contract
    ON monitoring.monitoring_outbox (tenant_id, contract_name);

COMMIT;
