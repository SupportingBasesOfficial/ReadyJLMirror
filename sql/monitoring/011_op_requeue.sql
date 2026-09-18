-- Operator reconciliation path: a guarded SECURITY DEFINER function
-- owned by the domain authority (jlmirror_owner) that performs the
-- only mutation app/worker roles may request on a durable operation
-- — requeueing a failed op back to `pending`. The app role keeps its
-- no-UPDATE least-privilege posture; the state whitelist lives here.

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
    RETURN n = 1;
END;
$$;

REVOKE ALL ON FUNCTION monitoring.requeue_sync_operation(TEXT, TEXT, TEXT)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.requeue_sync_operation(TEXT, TEXT, TEXT)
    TO jlmirror_app, jlmirror_worker;
