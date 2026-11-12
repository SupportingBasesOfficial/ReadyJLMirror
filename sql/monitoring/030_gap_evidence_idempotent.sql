-- Migration 030: add monitoring_sync_operation_id to metric_history_gap_evidence
-- and a UNIQUE constraint so retried history ops don't insert duplicate gaps.
-- Existing rows (before this migration) have NULL operation_id and are not
-- affected by the constraint (NULLs don't match each other in UNIQUE).

BEGIN;

ALTER TABLE monitoring.metric_history_gap_evidence
    ADD COLUMN IF NOT EXISTS monitoring_sync_operation_id TEXT NULL
        REFERENCES monitoring.monitoring_sync_operation(
            tenant_id, monitoring_sync_operation_id)
        DEFERRABLE INITIALLY DEFERRED;

-- Partial unique index: only enforced when monitoring_sync_operation_id is set.
-- One gap row per (op, target stream) on retry.
CREATE UNIQUE INDEX IF NOT EXISTS
    metric_history_gap_evidence_op_stream_uniq
ON monitoring.metric_history_gap_evidence
    (tenant_id, monitoring_sync_operation_id,
     provider_external_ref, history_value_type)
WHERE monitoring_sync_operation_id IS NOT NULL;

COMMIT;
