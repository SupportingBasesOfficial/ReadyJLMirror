-- G34 Alertmanager Source — per-tenant inbound webhook sources.
--
-- Each source has a pre-shared token (stored as SHA-256 hex) used to
-- authenticate inbound Alertmanager webhooks.  Events are stored in
-- alertmanager_event; the alerting.alert pipeline remains untouched.

BEGIN;

-- ── Source config ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS g1.alertmanager_source_config (
    source_id       TEXT        PRIMARY KEY,  -- 'amgr:<uuid>'
    tenant_id       TEXT        NOT NULL REFERENCES g1.tenants(tenant_id),
    display_name    TEXT        NOT NULL CHECK (display_name <> ''),
    token_hash      TEXT        NOT NULL,     -- SHA-256 hex of pre-shared token
    enabled         BOOLEAN     NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ── Inbound events ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS g1.alertmanager_event (
    event_id        TEXT        PRIMARY KEY,  -- 'amev:<uuid>'
    source_id       TEXT        NOT NULL REFERENCES g1.alertmanager_source_config(source_id),
    tenant_id       TEXT        NOT NULL,
    fingerprint     TEXT        NOT NULL,
    alert_name      TEXT        NOT NULL DEFAULT '',
    severity        TEXT        NOT NULL DEFAULT 'warning'
                        CHECK (severity IN ('critical','warning','info','ok')),
    status          TEXT        NOT NULL CHECK (status IN ('firing','resolved')),
    labels          JSONB       NOT NULL DEFAULT '{}',
    annotations     JSONB       NOT NULL DEFAULT '{}',
    starts_at       TIMESTAMPTZ,
    ends_at         TIMESTAMPTZ,
    received_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (source_id, fingerprint)
);

CREATE INDEX IF NOT EXISTS alertmanager_event_tenant_received
    ON g1.alertmanager_event (tenant_id, received_at DESC);

-- ── Grants ─────────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE ON g1.alertmanager_source_config TO jlmirror_app;
GRANT SELECT, INSERT ON g1.alertmanager_event TO jlmirror_app;

COMMIT;
