-- G24 Public Status Page configuration.
-- Tenants opt-in to a public status page via a chosen slug.
-- The status page is served by the BFF at /status/{slug} without auth.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.tenant_status_config (
    tenant_id   TEXT        NOT NULL,
    status_slug TEXT        NOT NULL UNIQUE,
    public_name TEXT        NOT NULL,
    enabled     BOOLEAN     NOT NULL DEFAULT true,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT tenant_status_config_pk PRIMARY KEY (tenant_id)
);

-- Allow jlmirror_app to read (for the settings API)
GRANT SELECT, INSERT, UPDATE ON g1.tenant_status_config TO jlmirror_app;

-- Allow the BFF DB user (jlmirror_owner) to read public data
-- (BFF queries this directly for the public endpoint, no tenant context set)
GRANT SELECT ON g1.tenant_status_config TO jlmirror_owner;

COMMIT;
