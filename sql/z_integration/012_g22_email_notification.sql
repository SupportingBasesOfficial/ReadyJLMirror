-- G22 Email Notifications — multi-channel delivery infrastructure.
-- 1. Relax the channel_class CHECK on notification_intent to also accept
--    email_smtp@1 (and slack@1 reserved for G29).
-- 2. Create notification.notification_destination_config for per-tenant
--    named delivery destinations (email addresses, WhatsApp refs, etc.).
-- Invoker roles created inline for the destinations CRUD API.

BEGIN;

-- ─── Relax channel_class constraint ─────────────────────────────────────────

ALTER TABLE notification.notification_intent
    DROP CONSTRAINT IF EXISTS notification_intent_channel_class_check;

ALTER TABLE notification.notification_intent
    ADD CONSTRAINT notification_intent_channel_class_check
    CHECK (channel_class IN (
        'whatsapp_business@1',
        'email_smtp@1',
        'slack@1'
    ));

-- ─── Invoker roles ────────────────────────────────────────────────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g22_dest_app_invoker') THEN
        CREATE ROLE jlmirror_g22_dest_app_invoker NOLOGIN;
    END IF;
END
$$;

GRANT jlmirror_g22_dest_app_invoker TO jlmirror_app;
GRANT USAGE ON SCHEMA notification TO jlmirror_g22_dest_app_invoker;

-- ─── Destination config table ─────────────────────────────────────────────────
-- Stores named delivery endpoints per tenant.
-- destination_ref: email address for email_smtp@1,
--                  phone/ref for whatsapp_business@1,
--                  webhook URL for slack@1.

CREATE TABLE IF NOT EXISTS notification.notification_destination_config (
    destination_config_id TEXT        NOT NULL DEFAULT 'dst:' || gen_random_uuid()::text,
    tenant_id             TEXT        NOT NULL,
    channel_class         TEXT        NOT NULL CHECK (channel_class IN (
                              'whatsapp_business@1', 'email_smtp@1', 'slack@1')),
    destination_ref       TEXT        NOT NULL,
    label                 TEXT        NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at            TIMESTAMPTZ NULL,

    CONSTRAINT notification_destination_config_pk
        PRIMARY KEY (destination_config_id)
);

CREATE INDEX IF NOT EXISTS ndc_tenant_active_idx
    ON notification.notification_destination_config (tenant_id)
    WHERE deleted_at IS NULL;

ALTER TABLE notification.notification_destination_config ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename='notification_destination_config'
           AND schemaname='notification'
           AND policyname='ndc_tenant_isolation')
    THEN
        CREATE POLICY ndc_tenant_isolation
            ON notification.notification_destination_config
            USING (tenant_id = current_setting('jlmirror.tenant_id', true));
    END IF;
END
$$;

-- ─── SECURITY DEFINER functions ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION notification.g22_add_destination(
    p_tenant_id   TEXT,
    p_channel     TEXT,
    p_dest_ref    TEXT,
    p_label       TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = notification, pg_temp
AS $$
DECLARE
    v_id TEXT;
BEGIN
    IF p_channel NOT IN ('whatsapp_business@1', 'email_smtp@1', 'slack@1') THEN
        RAISE EXCEPTION 'g22.invalid_channel: unsupported channel_class %', p_channel;
    END IF;
    IF p_dest_ref IS NULL OR trim(p_dest_ref) = '' THEN
        RAISE EXCEPTION 'g22.empty_dest_ref: destination_ref must not be empty';
    END IF;
    IF p_label IS NULL OR trim(p_label) = '' THEN
        RAISE EXCEPTION 'g22.empty_label: label must not be empty';
    END IF;

    INSERT INTO notification.notification_destination_config
        (tenant_id, channel_class, destination_ref, label)
    VALUES (p_tenant_id, p_channel, p_dest_ref, p_label)
    RETURNING destination_config_id INTO v_id;

    RETURN jsonb_build_object(
        'destination_config_id', v_id,
        'channel_class',         p_channel,
        'destination_ref',       p_dest_ref,
        'label',                 p_label
    );
END;
$$;

REVOKE ALL ON FUNCTION notification.g22_add_destination(TEXT,TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notification.g22_add_destination(TEXT,TEXT,TEXT,TEXT)
    TO jlmirror_g22_dest_app_invoker;

CREATE OR REPLACE FUNCTION notification.g22_delete_destination(
    p_tenant_id TEXT,
    p_dest_id   TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = notification, pg_temp
AS $$
BEGIN
    UPDATE notification.notification_destination_config
       SET deleted_at = now()
     WHERE destination_config_id = p_dest_id
       AND tenant_id              = p_tenant_id
       AND deleted_at             IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'g22.dest_not_found: destination % not found', p_dest_id;
    END IF;

    RETURN jsonb_build_object('destination_config_id', p_dest_id, 'deleted', true);
END;
$$;

REVOKE ALL ON FUNCTION notification.g22_delete_destination(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION notification.g22_delete_destination(TEXT,TEXT)
    TO jlmirror_g22_dest_app_invoker;

-- Direct SELECT for list endpoint (runs as jlmirror_app, gated by RLS)
GRANT SELECT ON notification.notification_destination_config TO jlmirror_app;
GRANT SELECT ON notification.notification_destination_config
    TO jlmirror_g22_dest_app_invoker;

COMMIT;
