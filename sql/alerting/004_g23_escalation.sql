-- G23 Escalation Policies — time-based multi-step notification escalation.
-- When an alert stays active without resolution, the escalation engine fires
-- successive steps (each with its own destination, channel, and delay).
-- Escalation stops when the alert resolves, is snoozed, or all steps fire.

BEGIN;

-- ─── Invoker roles ────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g23_esc_app_invoker') THEN
        CREATE ROLE jlmirror_g23_esc_app_invoker NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g23_esc_worker_invoker') THEN
        CREATE ROLE jlmirror_g23_esc_worker_invoker NOLOGIN;
    END IF;
END
$$;

GRANT jlmirror_g23_esc_app_invoker    TO jlmirror_app;
GRANT jlmirror_g23_esc_worker_invoker TO jlmirror_worker;
GRANT USAGE ON SCHEMA alerting TO jlmirror_g23_esc_app_invoker;
GRANT USAGE ON SCHEMA alerting TO jlmirror_g23_esc_worker_invoker;

-- ─── Tables ───────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alerting.escalation_policy (
    policy_id   TEXT        NOT NULL DEFAULT 'esc:' || gen_random_uuid()::text,
    tenant_id   TEXT        NOT NULL,
    name        TEXT        NOT NULL,
    description TEXT        NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at  TIMESTAMPTZ NULL,

    CONSTRAINT escalation_policy_pk PRIMARY KEY (policy_id)
);

ALTER TABLE alerting.escalation_policy ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename='escalation_policy' AND schemaname='alerting'
           AND policyname='esc_policy_tenant_isolation')
    THEN
        CREATE POLICY esc_policy_tenant_isolation
            ON alerting.escalation_policy
            USING (tenant_id = current_setting('jlmirror.tenant_id', true));
    END IF;
END
$$;

-- Ordered steps within a policy.
-- step_number starts at 1 (no zero-step). delay_minutes is relative to the
-- prior step firing (or to armed_at for step 1).
CREATE TABLE IF NOT EXISTS alerting.escalation_step (
    step_id         TEXT        NOT NULL DEFAULT 'estp:' || gen_random_uuid()::text,
    policy_id       TEXT        NOT NULL,
    tenant_id       TEXT        NOT NULL,
    step_number     INT         NOT NULL CHECK (step_number >= 1),
    delay_minutes   INT         NOT NULL CHECK (delay_minutes > 0),
    channel_class   TEXT        NOT NULL DEFAULT 'whatsapp_business@1'
                                CHECK (channel_class IN (
                                    'whatsapp_business@1','email_smtp@1','slack@1')),
    destination_ref TEXT        NOT NULL,
    payload_ref     TEXT        NOT NULL DEFAULT 'alert_notification',

    CONSTRAINT escalation_step_pk          PRIMARY KEY (step_id),
    CONSTRAINT escalation_step_policy_step UNIQUE (policy_id, tenant_id, step_number)
);

ALTER TABLE alerting.escalation_step ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename='escalation_step' AND schemaname='alerting'
           AND policyname='esc_step_tenant_isolation')
    THEN
        CREATE POLICY esc_step_tenant_isolation
            ON alerting.escalation_step
            USING (tenant_id = current_setting('jlmirror.tenant_id', true));
    END IF;
END
$$;

-- Per-alert escalation runtime state.
-- completed_at is set when all steps have fired or the alert resolved.
-- UNIQUE on (alert_id, tenant_id): only one active escalation per alert.
CREATE TABLE IF NOT EXISTS alerting.alert_escalation (
    escalation_id TEXT        NOT NULL DEFAULT 'aesc:' || gen_random_uuid()::text,
    alert_id      TEXT        NOT NULL,
    tenant_id     TEXT        NOT NULL,
    policy_id     TEXT        NOT NULL,
    current_step  INT         NOT NULL DEFAULT 1,
    armed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_fired_at TIMESTAMPTZ NULL,
    completed_at  TIMESTAMPTZ NULL,

    CONSTRAINT alert_escalation_pk         PRIMARY KEY (escalation_id),
    CONSTRAINT alert_escalation_alert_uniq UNIQUE (alert_id, tenant_id)
);

CREATE INDEX IF NOT EXISTS alert_escalation_pending_idx
    ON alerting.alert_escalation (tenant_id)
    WHERE completed_at IS NULL;

ALTER TABLE alerting.alert_escalation ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename='alert_escalation' AND schemaname='alerting'
           AND policyname='alert_esc_tenant_isolation')
    THEN
        CREATE POLICY alert_esc_tenant_isolation
            ON alerting.alert_escalation
            USING (tenant_id = current_setting('jlmirror.tenant_id', true));
    END IF;
END
$$;

-- ─── Grants for direct reads ──────────────────────────────────────────────────

GRANT SELECT ON alerting.escalation_policy TO jlmirror_app;
GRANT SELECT ON alerting.escalation_step   TO jlmirror_app;
GRANT SELECT ON alerting.alert_escalation  TO jlmirror_app;
GRANT SELECT ON alerting.escalation_policy TO jlmirror_g23_esc_app_invoker;
GRANT SELECT ON alerting.escalation_step   TO jlmirror_g23_esc_app_invoker;
GRANT SELECT ON alerting.alert_escalation  TO jlmirror_g23_esc_app_invoker;
GRANT SELECT ON alerting.escalation_policy TO jlmirror_g23_esc_worker_invoker;
GRANT SELECT ON alerting.escalation_step   TO jlmirror_g23_esc_worker_invoker;
GRANT SELECT ON alerting.alert_escalation  TO jlmirror_g23_esc_worker_invoker;

-- ─── SECURITY DEFINER functions ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION alerting.g23_create_policy(
    p_tenant_id   TEXT,
    p_name        TEXT,
    p_description TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
DECLARE v_id TEXT;
BEGIN
    IF trim(p_name) = '' OR p_name IS NULL THEN
        RAISE EXCEPTION 'g23.empty_name: name must not be empty';
    END IF;
    INSERT INTO alerting.escalation_policy (tenant_id, name, description)
    VALUES (p_tenant_id, p_name, p_description)
    RETURNING policy_id INTO v_id;
    RETURN jsonb_build_object('policy_id', v_id, 'name', p_name);
END;
$$;

REVOKE ALL ON FUNCTION alerting.g23_create_policy(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g23_create_policy(TEXT,TEXT,TEXT)
    TO jlmirror_g23_esc_app_invoker;


CREATE OR REPLACE FUNCTION alerting.g23_delete_policy(
    p_tenant_id TEXT,
    p_policy_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
BEGIN
    UPDATE alerting.escalation_policy
       SET deleted_at = now()
     WHERE policy_id = p_policy_id AND tenant_id = p_tenant_id
       AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'g23.policy_not_found: %', p_policy_id;
    END IF;
    RETURN jsonb_build_object('policy_id', p_policy_id, 'deleted', true);
END;
$$;

REVOKE ALL ON FUNCTION alerting.g23_delete_policy(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g23_delete_policy(TEXT,TEXT)
    TO jlmirror_g23_esc_app_invoker;


CREATE OR REPLACE FUNCTION alerting.g23_add_step(
    p_tenant_id     TEXT,
    p_policy_id     TEXT,
    p_step_number   INT,
    p_delay_minutes INT,
    p_channel_class TEXT,
    p_dest_ref      TEXT,
    p_payload_ref   TEXT DEFAULT 'alert_notification'
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
DECLARE v_id TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM alerting.escalation_policy
                    WHERE policy_id = p_policy_id AND tenant_id = p_tenant_id
                      AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'g23.policy_not_found: %', p_policy_id;
    END IF;
    IF p_delay_minutes <= 0 THEN
        RAISE EXCEPTION 'g23.invalid_delay: delay_minutes must be > 0';
    END IF;
    IF p_channel_class NOT IN ('whatsapp_business@1','email_smtp@1','slack@1') THEN
        RAISE EXCEPTION 'g23.invalid_channel: %', p_channel_class;
    END IF;
    INSERT INTO alerting.escalation_step
        (tenant_id, policy_id, step_number, delay_minutes,
         channel_class, destination_ref, payload_ref)
    VALUES (p_tenant_id, p_policy_id, p_step_number, p_delay_minutes,
            p_channel_class, p_dest_ref, p_payload_ref)
    RETURNING step_id INTO v_id;
    RETURN jsonb_build_object(
        'step_id', v_id, 'policy_id', p_policy_id,
        'step_number', p_step_number, 'delay_minutes', p_delay_minutes);
END;
$$;

REVOKE ALL ON FUNCTION alerting.g23_add_step(TEXT,TEXT,INT,INT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g23_add_step(TEXT,TEXT,INT,INT,TEXT,TEXT,TEXT)
    TO jlmirror_g23_esc_app_invoker;


CREATE OR REPLACE FUNCTION alerting.g23_delete_step(
    p_tenant_id   TEXT,
    p_policy_id   TEXT,
    p_step_number INT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
BEGIN
    DELETE FROM alerting.escalation_step
     WHERE policy_id = p_policy_id AND tenant_id = p_tenant_id
       AND step_number = p_step_number;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'g23.step_not_found: policy=% step=%',
            p_policy_id, p_step_number;
    END IF;
    RETURN jsonb_build_object('policy_id', p_policy_id,
                              'step_number', p_step_number, 'deleted', true);
END;
$$;

REVOKE ALL ON FUNCTION alerting.g23_delete_step(TEXT,TEXT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g23_delete_step(TEXT,TEXT,INT)
    TO jlmirror_g23_esc_app_invoker;


CREATE OR REPLACE FUNCTION alerting.g23_arm_alert(
    p_tenant_id TEXT,
    p_alert_id  TEXT,
    p_policy_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
DECLARE v_id TEXT;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM alerting.alert
                    WHERE alert_id = p_alert_id AND tenant_id = p_tenant_id
                      AND lifecycle_state = 'active') THEN
        RAISE EXCEPTION 'g23.alert_not_active: %', p_alert_id;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM alerting.escalation_policy
                    WHERE policy_id = p_policy_id AND tenant_id = p_tenant_id
                      AND deleted_at IS NULL) THEN
        RAISE EXCEPTION 'g23.policy_not_found: %', p_policy_id;
    END IF;
    INSERT INTO alerting.alert_escalation
        (alert_id, tenant_id, policy_id)
    VALUES (p_alert_id, p_tenant_id, p_policy_id)
    ON CONFLICT (alert_id, tenant_id) DO UPDATE
        SET policy_id    = EXCLUDED.policy_id,
            current_step = 1,
            armed_at     = now(),
            last_fired_at = NULL,
            completed_at  = NULL
    RETURNING escalation_id INTO v_id;
    RETURN jsonb_build_object(
        'escalation_id', v_id,
        'alert_id', p_alert_id,
        'policy_id', p_policy_id);
END;
$$;

REVOKE ALL ON FUNCTION alerting.g23_arm_alert(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g23_arm_alert(TEXT,TEXT,TEXT)
    TO jlmirror_g23_esc_app_invoker;


CREATE OR REPLACE FUNCTION alerting.g23_disarm_alert(
    p_tenant_id TEXT,
    p_alert_id  TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
BEGIN
    UPDATE alerting.alert_escalation
       SET completed_at = now()
     WHERE alert_id = p_alert_id AND tenant_id = p_tenant_id
       AND completed_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'g23.escalation_not_found: %', p_alert_id;
    END IF;
    RETURN jsonb_build_object('alert_id', p_alert_id, 'disarmed', true);
END;
$$;

REVOKE ALL ON FUNCTION alerting.g23_disarm_alert(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g23_disarm_alert(TEXT,TEXT)
    TO jlmirror_g23_esc_app_invoker;


-- Called by worker: advances current_step, sets last_fired_at.
-- Returns the next step if one exists, or marks escalation completed.
CREATE OR REPLACE FUNCTION alerting.g23_advance_step(
    p_tenant_id   TEXT,
    p_alert_id    TEXT,
    p_fired_step  INT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
DECLARE
    v_next_step INT;
    v_policy_id TEXT;
BEGIN
    SELECT policy_id INTO v_policy_id
      FROM alerting.alert_escalation
     WHERE alert_id = p_alert_id AND tenant_id = p_tenant_id
       AND completed_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'g23.escalation_not_found: %', p_alert_id;
    END IF;

    v_next_step := p_fired_step + 1;

    IF EXISTS (SELECT 1 FROM alerting.escalation_step
                WHERE policy_id = v_policy_id AND tenant_id = p_tenant_id
                  AND step_number = v_next_step) THEN
        UPDATE alerting.alert_escalation
           SET current_step = v_next_step,
               last_fired_at = now()
         WHERE alert_id = p_alert_id AND tenant_id = p_tenant_id;
        RETURN jsonb_build_object('alert_id', p_alert_id,
                                  'next_step', v_next_step,
                                  'completed', false);
    ELSE
        UPDATE alerting.alert_escalation
           SET last_fired_at = now(),
               completed_at  = now()
         WHERE alert_id = p_alert_id AND tenant_id = p_tenant_id;
        RETURN jsonb_build_object('alert_id', p_alert_id,
                                  'completed', true);
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION alerting.g23_advance_step(TEXT,TEXT,INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g23_advance_step(TEXT,TEXT,INT)
    TO jlmirror_g23_esc_worker_invoker;

COMMIT;
