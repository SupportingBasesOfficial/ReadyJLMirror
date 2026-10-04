-- G11 IR action extensions:
-- 1. Add 'incident_response' trigger type to g1.automation_run
-- 2. SECURITY DEFINER function to enqueue automation runs from IR
-- 3. SECURITY DEFINER function to resolve notify destinations from IR policy
-- Both functions callable by jlmirror_g11_ir_worker_invoker via SET LOCAL ROLE.

BEGIN;

-- ─── 1. Relax trigger_type constraint ────────────────────────────────────────

ALTER TABLE g1.automation_run
    DROP CONSTRAINT IF EXISTS automation_run_trigger_type_check;

ALTER TABLE g1.automation_run
    ADD CONSTRAINT automation_run_trigger_type_check
    CHECK (trigger_type IN ('manual', 'schedule', 'incident_response'));

-- ─── 2. Enqueue automation from IR ───────────────────────────────────────────

CREATE OR REPLACE FUNCTION incident_response.g11_enqueue_automation(
    p_tenant    TEXT,
    p_script_id TEXT,
    p_run_id    TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = g1, incident_response, pg_temp
AS $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM g1.automation_script
         WHERE script_id = p_script_id
           AND tenant_id = p_tenant
           AND enabled = true
    ) THEN
        RETURN jsonb_build_object(
            'status', 'skipped',
            'reason', 'script_not_found_or_disabled'
        );
    END IF;

    INSERT INTO g1.automation_run
        (run_id, tenant_id, script_id, trigger_type, outcome, started_at)
    VALUES
        (p_run_id, p_tenant, p_script_id, 'incident_response', 'pending', now());

    RETURN jsonb_build_object('status', 'enqueued', 'run_id', p_run_id);
END;
$$;

-- ─── 3. Resolve notify destinations from IR policy ───────────────────────────

CREATE OR REPLACE FUNCTION incident_response.g11_get_notify_destinations(
    p_tenant TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = notification, incident_response, g1, pg_temp
AS $$
DECLARE v_channels JSONB;
BEGIN
    SELECT notify_channels INTO v_channels
      FROM incident_response.policy
     WHERE tenant_id = p_tenant;

    IF NOT FOUND OR v_channels IS NULL OR v_channels = '[]'::jsonb THEN
        RETURN '[]'::jsonb;
    END IF;

    RETURN (
        SELECT COALESCE(jsonb_agg(
            jsonb_build_object(
                'destination_config_id', d.destination_config_id,
                'channel_class',         d.channel_class,
                'destination_ref',       d.destination_ref,
                'label',                 d.label
            )
        ), '[]'::jsonb)
          FROM notification.notification_destination_config d
         WHERE d.tenant_id = p_tenant
           AND d.deleted_at IS NULL
           AND d.destination_config_id = ANY (
               SELECT jsonb_array_elements_text(v_channels)
           )
    );
END;
$$;

-- ─── Grants ───────────────────────────────────────────────────────────────────

GRANT EXECUTE ON FUNCTION incident_response.g11_enqueue_automation(TEXT, TEXT, TEXT)
    TO jlmirror_g11_ir_worker_invoker;
REVOKE EXECUTE ON FUNCTION incident_response.g11_enqueue_automation(TEXT, TEXT, TEXT)
    FROM PUBLIC;

GRANT EXECUTE ON FUNCTION incident_response.g11_get_notify_destinations(TEXT)
    TO jlmirror_g11_ir_worker_invoker;
REVOKE EXECUTE ON FUNCTION incident_response.g11_get_notify_destinations(TEXT)
    FROM PUBLIC;

COMMIT;
