-- G11 operator action: mark an application-error-event as processed.
--
-- Adds incident_response.g11_mark_event_processed(TEXT, TEXT, TEXT) which:
--   - raises g11.event_missing (→ HTTP 404 via _G11_ERRORS) when the event does
--     not belong to the tenant;
--   - returns the event unchanged when already processed (idempotent);
--   - otherwise sets status = 'processed' and returns the updated row.
--
-- Called by the API router via SET LOCAL ROLE jlmirror_g11_ir_app_invoker.

BEGIN;

CREATE OR REPLACE FUNCTION incident_response.g11_mark_event_processed(
    p_tenant_id TEXT,
    p_event_id  TEXT,
    p_actor_id  TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_row RECORD;
BEGIN
    SELECT * INTO v_row
    FROM incident_response.application_error_event
    WHERE tenant_id = p_tenant_id
      AND event_id  = p_event_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'g11.event_missing:%', p_event_id;
    END IF;

    -- Idempotent: event is already processed, return it unchanged.
    IF v_row.status = 'processed' THEN
        RETURN to_jsonb(v_row);
    END IF;

    UPDATE incident_response.application_error_event SET
        status     = 'processed',
        updated_at = transaction_timestamp()
    WHERE tenant_id = p_tenant_id
      AND event_id  = p_event_id;

    SELECT * INTO v_row
    FROM incident_response.application_error_event
    WHERE tenant_id = p_tenant_id
      AND event_id  = p_event_id;

    RETURN to_jsonb(v_row);
END;
$$;

GRANT EXECUTE ON FUNCTION incident_response.g11_mark_event_processed(TEXT, TEXT, TEXT)
    TO jlmirror_g11_ir_app_invoker;
REVOKE EXECUTE ON FUNCTION incident_response.g11_mark_event_processed(TEXT, TEXT, TEXT)
    FROM PUBLIC;

COMMIT;
