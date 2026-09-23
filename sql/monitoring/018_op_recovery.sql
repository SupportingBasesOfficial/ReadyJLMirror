-- Op recovery: bounded requeue accounting.
--
-- recovery_count records how many times an op was returned to pending
-- from a non-pending state (orphan reaper, reconciliation requeue,
-- operator requeue). The reaper/reconciler cap auto-recovery against
-- it; the operator requeue path is authoritative and never capped.
--
-- requeue_sync_operation bumps the counter so the worker-side bound
-- sees every recovery act regardless of who initiated it.

BEGIN;

ALTER TABLE monitoring.monitoring_sync_operation
    ADD COLUMN IF NOT EXISTS recovery_count INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION monitoring.requeue_sync_operation(
    p_tenant_id TEXT,
    p_source_id TEXT,
    p_operation_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_temp
AS $$
DECLARE
    n INTEGER;
BEGIN
    UPDATE monitoring.monitoring_sync_operation
       SET state = 'pending', claim_token = NULL,
           started_at = NULL, completed_at = NULL,
           recovery_count = recovery_count + 1
     WHERE tenant_id = p_tenant_id
       AND monitoring_source_id = p_source_id
       AND monitoring_sync_operation_id = p_operation_id
       AND state IN ('reconciliation_required', 'failed_terminal');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 1 THEN
        -- Requeue IS the reconciliation act — it restores claimable
        -- authority so claim-gated op kinds (problem_state) can run.
        UPDATE monitoring.monitoring_source
           SET operational_evidence_state = 'current',
               updated_at = transaction_timestamp()
         WHERE tenant_id = p_tenant_id
           AND monitoring_source_id = p_source_id
           AND operational_evidence_state = 'reconciliation_required';
    END IF;
    RETURN n = 1;
END;
$$;

REVOKE ALL ON FUNCTION monitoring.requeue_sync_operation(TEXT, TEXT, TEXT)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.requeue_sync_operation(TEXT, TEXT, TEXT)
    TO jlmirror_app, jlmirror_worker;

COMMIT;
