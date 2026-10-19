BEGIN;

-- Time entry table for G10 incidents
CREATE TABLE IF NOT EXISTS itsm.incident_time_entry (
    entry_id TEXT NOT NULL DEFAULT 'te_' || gen_random_uuid()::text,
    incident_id TEXT NOT NULL,
    tenant_id TEXT NOT NULL,
    logged_by_principal_id TEXT NOT NULL,
    minutes INTEGER NOT NULL CHECK (minutes > 0 AND minutes <= 1440),
    description TEXT,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT incident_time_entry_pkey PRIMARY KEY (entry_id),
    CONSTRAINT incident_time_entry_incident_fk
        FOREIGN KEY (incident_id, tenant_id)
        REFERENCES itsm.incident (incident_id, tenant_id)
        ON DELETE CASCADE
);

ALTER TABLE itsm.incident_time_entry OWNER TO jlmirror_g10_itsm_executor;

CREATE INDEX IF NOT EXISTS incident_time_entry_incident_idx
    ON itsm.incident_time_entry (incident_id, tenant_id);

-- Row-level security
ALTER TABLE itsm.incident_time_entry ENABLE ROW LEVEL SECURITY;

CREATE POLICY incident_time_entry_tenant_isolation ON itsm.incident_time_entry
    USING (tenant_id = current_setting('jlmirror.tenant_id', true));

-- Grant table access to executor role (used by SECURITY DEFINER functions)
GRANT SELECT, INSERT ON itsm.incident_time_entry TO jlmirror_g10_itsm_executor;

-- Function: log time entry
CREATE OR REPLACE FUNCTION itsm.g10_log_time(
    p_tenant_id TEXT,
    p_incident_id TEXT,
    p_minutes INTEGER,
    p_description TEXT,
    p_actor_principal_id TEXT,
    p_logical_action_id TEXT,
    p_authority_snapshot JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE
    v_entry_id TEXT;
BEGIN
    PERFORM set_config('jlmirror.tenant_id', p_tenant_id, true);

    -- Verify incident exists in this tenant
    IF NOT EXISTS (
        SELECT 1 FROM itsm.incident
         WHERE incident_id = p_incident_id AND tenant_id = p_tenant_id
           AND lifecycle_state NOT IN ('closed')
    ) THEN
        RAISE EXCEPTION 'g10.incident_missing' USING HINT = p_incident_id;
    END IF;

    v_entry_id := 'te_' || encode(gen_random_bytes(9), 'base64');
    v_entry_id := replace(replace(replace(v_entry_id, '+', '-'), '/', '_'), '=', '');

    INSERT INTO itsm.incident_time_entry
        (entry_id, incident_id, tenant_id, logged_by_principal_id, minutes, description)
    VALUES
        (v_entry_id, p_incident_id, p_tenant_id, p_actor_principal_id,
         p_minutes, p_description);

    RETURN jsonb_build_object(
        'entry_id', v_entry_id,
        'incident_id', p_incident_id,
        'minutes', p_minutes,
        'description', p_description,
        'logged_by_principal_id', p_actor_principal_id,
        'logged_at', to_char(NOW(), 'YYYY-MM-DD"T"HH24:MI:SS"Z"')
    );
END;
$$;

ALTER FUNCTION itsm.g10_log_time(TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,JSONB)
    OWNER TO jlmirror_g10_itsm_executor;

REVOKE ALL ON FUNCTION itsm.g10_log_time(TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION itsm.g10_log_time(TEXT,TEXT,INTEGER,TEXT,TEXT,TEXT,JSONB)
    TO jlmirror_g10_itsm_app_invoker;

-- Function: list time entries for an incident
CREATE OR REPLACE FUNCTION itsm.g10_list_time_entries(
    p_tenant_id TEXT,
    p_incident_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE v_result JSONB;
BEGIN
    PERFORM set_config('jlmirror.tenant_id', p_tenant_id, true);

    SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY x.logged_at DESC), '[]'::jsonb)
      INTO v_result
    FROM (
        SELECT entry_id, incident_id, minutes, description,
               logged_by_principal_id, logged_at
          FROM itsm.incident_time_entry
         WHERE tenant_id = p_tenant_id AND incident_id = p_incident_id
         ORDER BY logged_at DESC
    ) x;

    RETURN v_result;
END;
$$;

ALTER FUNCTION itsm.g10_list_time_entries(TEXT, TEXT)
    OWNER TO jlmirror_g10_itsm_executor;

REVOKE ALL ON FUNCTION itsm.g10_list_time_entries(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION itsm.g10_list_time_entries(TEXT, TEXT)
    TO jlmirror_g10_itsm_app_invoker;

COMMIT;
