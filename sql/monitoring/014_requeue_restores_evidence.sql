-- Requeue gap fix: a requeued op was permanently unclaimable because
-- the claim gate requires monitoring_source.operational_evidence_state
-- = 'current', while the failed op had degraded it to
-- 'reconciliation_required'. The operator requeue IS the
-- reconciliation act — it restores claimable authority and lets the
-- retried op re-derive the evidence state on completion.

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
           started_at = NULL, completed_at = NULL
     WHERE tenant_id = p_tenant_id
       AND monitoring_source_id = p_source_id
       AND monitoring_sync_operation_id = p_operation_id
       AND state IN ('reconciliation_required', 'failed_terminal');
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n = 1 THEN
        -- Operator reconciliation restores claimable authority so
        -- claim-gated op kinds (problem_state) can run again.
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
