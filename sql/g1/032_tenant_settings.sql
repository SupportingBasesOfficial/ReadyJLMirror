-- G29 Tenant Settings: SMTP, notification preferences, and timezone config.
-- Branding (brand_name, brand_color, logo_url) remains in g1.tenant_branding.

CREATE TABLE IF NOT EXISTS g1.tenant_settings (
    tenant_id                 TEXT PRIMARY KEY REFERENCES g1.tenants(tenant_id),
    smtp_host                 TEXT,
    smtp_port                 INT NOT NULL DEFAULT 587,
    smtp_user                 TEXT,
    smtp_password             TEXT,
    smtp_from_name            TEXT,
    smtp_from_email           TEXT,
    smtp_tls                  BOOLEAN NOT NULL DEFAULT TRUE,
    notify_on_alert_critical  BOOLEAN NOT NULL DEFAULT TRUE,
    notify_on_incident_open   BOOLEAN NOT NULL DEFAULT TRUE,
    notify_on_sla_breach      BOOLEAN NOT NULL DEFAULT TRUE,
    timezone                  TEXT NOT NULL DEFAULT 'America/Sao_Paulo',
    date_format               TEXT NOT NULL DEFAULT 'DD/MM/YYYY',
    updated_at                TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_by                TEXT
);

GRANT SELECT, INSERT, UPDATE ON g1.tenant_settings TO jlmirror_app;
GRANT SELECT ON g1.tenant_settings TO jlmirror_owner;
