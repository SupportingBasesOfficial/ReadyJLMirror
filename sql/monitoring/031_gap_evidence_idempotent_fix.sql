-- Migration 031: re-apply 030 with correct syntax
-- Migration 030 failed: inline FK cannot reference composite PK.
-- This migration adds the column and partial unique index only —
-- sufficient for ON CONFLICT idempotency in complete_metric_history.

BEGIN;

ALTER TABLE monitoring.metric_history_gap_evidence
    ADD COLUMN IF NOT EXISTS monitoring_sync_operation_id TEXT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS
    metric_history_gap_evidence_op_stream_uniq
ON monitoring.metric_history_gap_evidence
    (tenant_id, monitoring_sync_operation_id,
     provider_external_ref, history_value_type)
WHERE monitoring_sync_operation_id IS NOT NULL;

COMMIT;
