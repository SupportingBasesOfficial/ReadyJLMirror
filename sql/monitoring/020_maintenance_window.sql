-- G20 Maintenance Window — tenant-scoped suppression of alert notifications
-- for planned maintenance periods. Windows are soft-facts: creating/deleting
-- a window is auditable but the table itself is mutable (windows can be
-- cancelled). Notification dispatch (G9) checks is_in_maintenance() before
-- sending; alerts still fire — only notification delivery is suppressed.

BEGIN;

-- ─── Invoker roles (must exist before GRANT EXECUTE below) ───────────────────

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g20_mw_app_invoker') THEN
        CREATE ROLE jlmirror_g20_mw_app_invoker NOLOGIN;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g20_mw_worker_invoker') THEN
        CREATE ROLE jlmirror_g20_mw_worker_invoker NOLOGIN;
    END IF;
END
$$;

GRANT jlmirror_g20_mw_app_invoker    TO jlmirror_app;
GRANT jlmirror_g20_mw_worker_invoker TO jlmirror_worker;
GRANT USAGE ON SCHEMA monitoring TO jlmirror_g20_mw_app_invoker;
GRANT USAGE ON SCHEMA monitoring TO jlmirror_g20_mw_worker_invoker;

-- ─── Table ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS monitoring.maintenance_window (
    window_id       TEXT        NOT NULL DEFAULT 'mw:' || gen_random_uuid()::text,
    tenant_id       TEXT        NOT NULL,
    label           TEXT        NOT NULL CHECK (label <> ''),
    -- NULL source_ids = all sources for this tenant
    source_ids      TEXT[]      NULL,
    starts_at       TIMESTAMPTZ NOT NULL,
    ends_at         TIMESTAMPTZ NOT NULL,
    created_by      TEXT        NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    cancelled_at    TIMESTAMPTZ NULL,

    CONSTRAINT maintenance_window_pk PRIMARY KEY (window_id),
    CONSTRAINT maintenance_window_end_after_start CHECK (ends_at > starts_at)
);

CREATE INDEX IF NOT EXISTS maintenance_window_tenant_active_idx
    ON monitoring.maintenance_window (tenant_id, starts_at, ends_at)
    WHERE cancelled_at IS NULL;

-- RLS: tenant isolation
ALTER TABLE monitoring.maintenance_window ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_policies
         WHERE tablename='maintenance_window'
           AND schemaname='monitoring'
           AND policyname='mw_tenant_isolation')
    THEN
        CREATE POLICY mw_tenant_isolation
            ON monitoring.maintenance_window
            USING (tenant_id = current_setting('jlmirror.tenant_id', true));
    END IF;
END
$$;

-- ─── SECURITY DEFINER functions ──────────────────────────────────────────────

-- List active (non-cancelled, overlapping now) and upcoming windows.
CREATE OR REPLACE FUNCTION monitoring.g20_list_windows(
    p_tenant_id     TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_temp
AS $$
DECLARE result JSONB;
BEGIN
    SELECT coalesce(jsonb_agg(jsonb_build_object(
        'window_id',   w.window_id,
        'label',       w.label,
        'source_ids',  w.source_ids,
        'starts_at',   w.starts_at,
        'ends_at',     w.ends_at,
        'created_by',  w.created_by,
        'created_at',  w.created_at,
        'active',      (now() BETWEEN w.starts_at AND w.ends_at)
    ) ORDER BY w.starts_at), '[]'::jsonb)
      INTO result
      FROM monitoring.maintenance_window w
     WHERE w.tenant_id = p_tenant_id
       AND w.cancelled_at IS NULL
       AND w.ends_at >= now() - interval '1 hour';
    RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION monitoring.g20_list_windows(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.g20_list_windows(TEXT)
    TO jlmirror_g20_mw_app_invoker;

-- Create a maintenance window.
CREATE OR REPLACE FUNCTION monitoring.g20_create_window(
    p_tenant_id     TEXT,
    p_label         TEXT,
    p_source_ids    TEXT[],   -- NULL = all sources
    p_starts_at     TIMESTAMPTZ,
    p_ends_at       TIMESTAMPTZ,
    p_created_by    TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_temp
AS $$
DECLARE
    v_id    TEXT;
    v_row   monitoring.maintenance_window;
BEGIN
    IF p_ends_at <= p_starts_at THEN
        RAISE EXCEPTION 'g20.end_before_start: ends_at must be after starts_at';
    END IF;
    IF p_label IS NULL OR trim(p_label) = '' THEN
        RAISE EXCEPTION 'g20.label_required';
    END IF;

    INSERT INTO monitoring.maintenance_window
        (tenant_id, label, source_ids, starts_at, ends_at, created_by)
    VALUES
        (p_tenant_id, p_label, p_source_ids, p_starts_at, p_ends_at, p_created_by)
    RETURNING window_id INTO v_id;

    SELECT * INTO v_row FROM monitoring.maintenance_window WHERE window_id = v_id;

    RETURN jsonb_build_object(
        'window_id',  v_row.window_id,
        'label',      v_row.label,
        'source_ids', v_row.source_ids,
        'starts_at',  v_row.starts_at,
        'ends_at',    v_row.ends_at,
        'created_by', v_row.created_by,
        'created_at', v_row.created_at,
        'active',     (now() BETWEEN v_row.starts_at AND v_row.ends_at)
    );
END;
$$;

REVOKE ALL ON FUNCTION monitoring.g20_create_window(TEXT,TEXT,TEXT[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.g20_create_window(TEXT,TEXT,TEXT[],TIMESTAMPTZ,TIMESTAMPTZ,TEXT)
    TO jlmirror_g20_mw_app_invoker;

-- Cancel (soft-delete) a maintenance window.
CREATE OR REPLACE FUNCTION monitoring.g20_cancel_window(
    p_tenant_id     TEXT,
    p_window_id     TEXT,
    p_actor         TEXT
) RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_temp
AS $$
DECLARE v_row monitoring.maintenance_window;
BEGIN
    UPDATE monitoring.maintenance_window
       SET cancelled_at = now()
     WHERE window_id  = p_window_id
       AND tenant_id  = p_tenant_id
       AND cancelled_at IS NULL
    RETURNING * INTO v_row;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'g20.window_not_found: %', p_window_id;
    END IF;

    RETURN jsonb_build_object('window_id', v_row.window_id, 'cancelled', true);
END;
$$;

REVOKE ALL ON FUNCTION monitoring.g20_cancel_window(TEXT,TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.g20_cancel_window(TEXT,TEXT,TEXT)
    TO jlmirror_g20_mw_app_invoker;

-- Check if a source is currently in a maintenance window.
-- Called by notification_dispatch before sending.
CREATE OR REPLACE FUNCTION monitoring.g20_is_in_maintenance(
    p_tenant_id     TEXT,
    p_source_id     TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_temp
AS $$
BEGIN
    RETURN EXISTS (
        SELECT 1
          FROM monitoring.maintenance_window
         WHERE tenant_id    = p_tenant_id
           AND cancelled_at IS NULL
           AND now() BETWEEN starts_at AND ends_at
           AND (source_ids IS NULL OR p_source_id = ANY(source_ids))
    );
END;
$$;

REVOKE ALL ON FUNCTION monitoring.g20_is_in_maintenance(TEXT,TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.g20_is_in_maintenance(TEXT,TEXT)
    TO jlmirror_g20_mw_app_invoker;
GRANT EXECUTE ON FUNCTION monitoring.g20_is_in_maintenance(TEXT,TEXT)
    TO jlmirror_g20_mw_worker_invoker;

COMMIT;
