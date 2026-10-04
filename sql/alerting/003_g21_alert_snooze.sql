-- G21 Alert Snooze — per-alert operator-controlled notification suppression.
-- A snooze is an overlay (not a lifecycle state): the alert stays visible and
-- active but notification dispatch skips delivery until expires_at.
-- Operators can cancel a snooze early (unsnooze).

BEGIN;

-- ─── Invoker roles ────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g21_snooze_app_invoker') THEN
        CREATE ROLE jlmirror_g21_snooze_app_invoker NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g21_snooze_worker_invoker') THEN
        CREATE ROLE jlmirror_g21_snooze_worker_invoker NOLOGIN;
    END IF;
END
$$;

GRANT jlmirror_g21_snooze_app_invoker    TO jlmirror_app;
GRANT jlmirror_g21_snooze_worker_invoker TO jlmirror_worker;
GRANT USAGE ON SCHEMA alerting TO jlmirror_g21_snooze_app_invoker;
GRANT USAGE ON SCHEMA alerting TO jlmirror_g21_snooze_worker_invoker;

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS alerting.alert_snooze (
    snooze_id    TEXT        NOT NULL DEFAULT 'snz:' || gen_random_uuid()::text,
    alert_id     TEXT        NOT NULL,
    tenant_id    TEXT        NOT NULL,
    expires_at   TIMESTAMPTZ NOT NULL,
    snoozed_by   TEXT        NOT NULL,
    reason       TEXT        NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at TIMESTAMPTZ NULL,

    CONSTRAINT alert_snooze_pk PRIMARY KEY (snooze_id)
);

CREATE INDEX IF NOT EXISTS alert_snooze_active_idx
    ON alerting.alert_snooze (tenant_id, alert_id)
    WHERE cancelled_at IS NULL;

-- RLS: tenant isolation
ALTER TABLE alerting.alert_snooze ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename='alert_snooze'
           AND schemaname='alerting'
           AND policyname='snooze_tenant_isolation')
    THEN
        CREATE POLICY snooze_tenant_isolation
            ON alerting.alert_snooze
            USING (tenant_id = current_setting('jlmirror.tenant_id', true));
    END IF;
END
$$;

-- Direct SELECT needed by list_alerts subquery (runs as jlmirror_app)
GRANT SELECT ON alerting.alert_snooze TO jlmirror_app;
GRANT SELECT ON alerting.alert_snooze TO jlmirror_g21_snooze_app_invoker;
GRANT SELECT ON alerting.alert_snooze TO jlmirror_g21_snooze_worker_invoker;

-- ─── SECURITY DEFINER functions ───────────────────────────────────────────────

-- Snooze an alert for duration_minutes minutes.
-- Cancels any existing active snooze first (only one active snooze per alert).
CREATE OR REPLACE FUNCTION alerting.g21_snooze_alert(
    p_tenant_id       TEXT,
    p_alert_id        TEXT,
    p_duration_minutes INT,
    p_snoozed_by      TEXT,
    p_reason          TEXT DEFAULT NULL
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
DECLARE
    v_expires_at TIMESTAMPTZ;
    v_id         TEXT;
BEGIN
    IF p_duration_minutes IS NULL OR p_duration_minutes <= 0 THEN
        RAISE EXCEPTION 'g21.invalid_duration: duration_minutes must be > 0';
    END IF;
    IF p_duration_minutes > 10080 THEN
        RAISE EXCEPTION 'g21.duration_too_long: max 10080 minutes (7 days)';
    END IF;

    -- Cancel any existing active snooze for this alert
    UPDATE alerting.alert_snooze
       SET cancelled_at = now()
     WHERE alert_id     = p_alert_id
       AND tenant_id    = p_tenant_id
       AND cancelled_at IS NULL
       AND expires_at   > now();

    v_expires_at := now() + (p_duration_minutes || ' minutes')::interval;

    INSERT INTO alerting.alert_snooze
        (alert_id, tenant_id, expires_at, snoozed_by, reason)
    VALUES
        (p_alert_id, p_tenant_id, v_expires_at, p_snoozed_by, p_reason)
    RETURNING snooze_id INTO v_id;

    RETURN jsonb_build_object(
        'snooze_id',   v_id,
        'alert_id',    p_alert_id,
        'expires_at',  v_expires_at,
        'snoozed_by',  p_snoozed_by,
        'reason',      p_reason
    );
END;
$$;

REVOKE ALL ON FUNCTION alerting.g21_snooze_alert(TEXT,TEXT,INT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g21_snooze_alert(TEXT,TEXT,INT,TEXT,TEXT)
    TO jlmirror_g21_snooze_app_invoker;

-- Cancel the active snooze on an alert (unsnooze).
CREATE OR REPLACE FUNCTION alerting.g21_unsnooze_alert(
    p_tenant_id TEXT,
    p_alert_id  TEXT,
    p_actor     TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
DECLARE v_id TEXT;
BEGIN
    UPDATE alerting.alert_snooze
       SET cancelled_at = now()
     WHERE alert_id     = p_alert_id
       AND tenant_id    = p_tenant_id
       AND cancelled_at IS NULL
       AND expires_at   > now()
    RETURNING snooze_id INTO v_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'g21.snooze_not_found: no active snooze for alert %', p_alert_id;
    END IF;

    RETURN jsonb_build_object('alert_id', p_alert_id, 'unsnoozed', true);
END;
$$;

REVOKE ALL ON FUNCTION alerting.g21_unsnooze_alert(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g21_unsnooze_alert(TEXT,TEXT,TEXT)
    TO jlmirror_g21_snooze_app_invoker;

-- Check if an alert is currently snoozed (active, non-cancelled, not expired).
-- Called by notification_dispatch before sending.
CREATE OR REPLACE FUNCTION alerting.g21_is_snoozed(
    p_tenant_id TEXT,
    p_alert_id  TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = alerting, pg_temp
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
          FROM alerting.alert_snooze
         WHERE alert_id     = p_alert_id
           AND tenant_id    = p_tenant_id
           AND cancelled_at IS NULL
           AND expires_at   > now()
    );
END;
$$;

REVOKE ALL ON FUNCTION alerting.g21_is_snoozed(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION alerting.g21_is_snoozed(TEXT,TEXT)
    TO jlmirror_g21_snooze_app_invoker;
GRANT EXECUTE ON FUNCTION alerting.g21_is_snoozed(TEXT,TEXT)
    TO jlmirror_g21_snooze_worker_invoker;

COMMIT;
