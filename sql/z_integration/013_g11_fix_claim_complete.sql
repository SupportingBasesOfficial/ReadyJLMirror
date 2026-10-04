-- G11 claim atomicity and complete ownership fix.
--
-- 1. g11_claim_action: return NULL when the UPDATE affects no rows instead of
--    always returning 'dispatching' — prevents false positive claim confirmations.
-- 2. g11_complete_action: add claimed_by = p_executor guard so only the owning
--    worker can write the result — prevents stale workers from corrupting active
--    action records.

BEGIN;

CREATE OR REPLACE FUNCTION incident_response.g11_claim_action(
  p_tenant TEXT, p_request_id TEXT, p_executor TEXT, p_claim_seconds INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_rows INTEGER;
BEGIN
  UPDATE incident_response.action_request SET
    status           = 'dispatching',
    claimed_by       = p_executor,
    claim_expires_at = transaction_timestamp() + (p_claim_seconds || ' seconds')::INTERVAL,
    attempts         = attempts + 1,
    updated_at       = transaction_timestamp()
  WHERE tenant_id=p_tenant AND request_id=p_request_id AND status='pending';
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('status','dispatching','request_id',p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_complete_action(
  p_tenant TEXT, p_request_id TEXT, p_executor TEXT,
  p_result_state TEXT, p_provider_ref TEXT, p_failure_class TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_rows INTEGER;
BEGIN
  UPDATE incident_response.action_request SET
    status        = p_result_state,
    result_state  = p_result_state,
    provider_ref  = p_provider_ref,
    failure_class = p_failure_class,
    updated_at    = transaction_timestamp()
  WHERE tenant_id=p_tenant AND request_id=p_request_id
    AND claimed_by = p_executor;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN jsonb_build_object('status','not_owner','request_id',p_request_id);
  END IF;
  -- Mark event processed when all its actions are settled
  UPDATE incident_response.application_error_event SET
    status     = 'processed',
    updated_at = transaction_timestamp()
  WHERE tenant_id=p_tenant
    AND event_id = (SELECT event_id FROM incident_response.action_request
                    WHERE request_id=p_request_id)
    AND NOT EXISTS (
      SELECT 1 FROM incident_response.action_request
       WHERE tenant_id=p_tenant
         AND event_id = (SELECT event_id FROM incident_response.action_request
                          WHERE request_id=p_request_id)
         AND status IN ('pending','dispatching')
    );
  RETURN jsonb_build_object('status',p_result_state,'request_id',p_request_id);
END;
$$;

COMMIT;
