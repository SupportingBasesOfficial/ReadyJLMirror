-- Migration 029: add UNIQUE (tenant_id, monitoring_sync_operation_id) to
-- monitoring_source_validation_evidence so that retried validation ops
-- (requeued by the reaper after a mid-commit crash) cannot insert a second
-- evidence row for the same op.  The INSERT in complete_initial_validation
-- will use ON CONFLICT DO NOTHING after this migration.

BEGIN;

-- Remove any duplicate rows that may already exist, keeping the oldest
-- (lowest validation_evidence_id lexicographically as a tiebreak).
DELETE FROM monitoring.monitoring_source_validation_evidence
 WHERE validation_evidence_id NOT IN (
     SELECT MIN(validation_evidence_id)
       FROM monitoring.monitoring_source_validation_evidence
      GROUP BY tenant_id, monitoring_sync_operation_id
 );

ALTER TABLE monitoring.monitoring_source_validation_evidence
    ADD CONSTRAINT monitoring_source_validation_evidence_op_uniq
    UNIQUE (tenant_id, monitoring_sync_operation_id);

COMMIT;
