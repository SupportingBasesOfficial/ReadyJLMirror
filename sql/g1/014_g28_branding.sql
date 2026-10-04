-- G28 White-label Branding — per-tenant visual identity.
-- brand_color is a CSS hex value applied to --brand CSS variable.
-- logo_url is a URL the shell loads as the header logo.
-- brand_name replaces "JLMirror" in the header.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.tenant_branding (
    tenant_id    TEXT PRIMARY KEY REFERENCES g1.tenants(tenant_id),
    brand_name   TEXT,                              -- e.g. "Acme Operations"
    brand_color  TEXT                               -- CSS hex e.g. "#6366f1"
                 CHECK (brand_color IS NULL OR brand_color ~ '^#[0-9a-fA-F]{6}$'),
    logo_url     TEXT,                              -- absolute or data: URL
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE ON g1.tenant_branding TO jlmirror_app;
GRANT SELECT ON g1.tenant_branding TO jlmirror_owner;

COMMIT;
