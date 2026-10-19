BEGIN;

CREATE OR REPLACE FUNCTION itsm.g10_list_incidents(
  p_tenant_id TEXT,
  p_lifecycle_state TEXT DEFAULT NULL,
  p_limit INTEGER DEFAULT 100
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm,alerting
AS $$
DECLARE v_result JSONB;
BEGIN
  PERFORM set_config('jlmirror.tenant_id', p_tenant_id, true);
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.updated_at DESC), '[]'::jsonb)
    INTO v_result
  FROM (
    SELECT i.incident_id,
           i.alert_id,
           i.title,
           i.lifecycle_state,
           i.created_by_principal_id,
           i.created_at,
           i.updated_at,
           a.lifecycle_state AS alert_state,
           a.source_evidence_summary->>'severity_class' AS severity_class
      FROM itsm.incident i
      JOIN alerting.alert a
        ON a.tenant_id = i.tenant_id AND a.alert_id = i.alert_id
     WHERE i.tenant_id = p_tenant_id
       AND (p_lifecycle_state IS NULL OR i.lifecycle_state = p_lifecycle_state)
     ORDER BY i.updated_at DESC
     LIMIT LEAST(COALESCE(p_limit, 100), 200)
  ) x;
  RETURN v_result;
END;
$$;

ALTER FUNCTION itsm.g10_list_incidents(TEXT, TEXT, INTEGER)
  OWNER TO jlmirror_g10_itsm_executor;

REVOKE ALL ON FUNCTION itsm.g10_list_incidents(TEXT, TEXT, INTEGER) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION itsm.g10_list_incidents(TEXT, TEXT, INTEGER)
  TO jlmirror_g10_itsm_app_invoker;

COMMIT;
