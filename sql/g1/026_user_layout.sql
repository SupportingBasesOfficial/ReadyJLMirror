-- G2-F2 User layout persistence.
--
-- Stores per-(tenant, principal, view) layout blobs so the UI state is
-- preserved across browsers and devices. view_key further qualifies the
-- context (e.g. a device ID for device panels; empty for global views).

BEGIN;

CREATE TABLE IF NOT EXISTS g1.user_layout (
    tenant_id    TEXT        NOT NULL,
    principal_id TEXT        NOT NULL,
    view_type    TEXT        NOT NULL,
    view_key     TEXT        NOT NULL DEFAULT '',
    layout       JSONB       NOT NULL DEFAULT '{}',
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT pk_user_layout
        PRIMARY KEY (tenant_id, principal_id, view_type, view_key)
);

CREATE INDEX IF NOT EXISTS idx_user_layout_tenant_principal
    ON g1.user_layout (tenant_id, principal_id);

COMMENT ON TABLE g1.user_layout IS
    'Per-user UI layout preferences (dashboard, tv_mode, device_panel, …). '
    'view_key qualifies sub-contexts (e.g. device ID). layout is an opaque '
    'JSON blob owned by the frontend.';

COMMIT;
