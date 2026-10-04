BEGIN;

-- Fix: GET DIAGNOSTICS ROW_COUNT returns INTEGER, not BOOLEAN.
-- The original g11_claim_dedupe declared v_found BOOLEAN which caused
-- "operator does not exist: boolean > integer" at runtime.
CREATE OR REPLACE FUNCTION incident_response.g11_claim_dedupe(
  p_tenant TEXT, p_app_id TEXT, p_error_code TEXT, p_bucket_ts TIMESTAMPTZ,
  p_event_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_found INTEGER;
BEGIN
  DELETE FROM incident_response.dedupe_entry WHERE expires_at < transaction_timestamp();
  INSERT INTO incident_response.dedupe_entry
    (tenant_id, application_id, error_code, bucket_ts, event_id, expires_at)
  VALUES
    (p_tenant, p_app_id, p_error_code, p_bucket_ts, p_event_id,
     transaction_timestamp() + INTERVAL '5 minutes')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found > 0;
END;
$$;

COMMIT;
