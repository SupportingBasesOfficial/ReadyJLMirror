-- Migration 039: SSH credential store for automation (G32 extension).
-- Stores SSH private keys per tenant, referenced by ssh_command scripts.
-- key_pem is stored as-is; deploy-time encryption via pgcrypto is recommended
-- for production but left out of this migration to keep the schema portable.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.automation_credential (
    credential_id   TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    label           TEXT NOT NULL,
    credential_type TEXT NOT NULL DEFAULT 'ssh_key'
                    CHECK (credential_type IN ('ssh_key')),
    username        TEXT NOT NULL,              -- SSH login username
    key_pem         TEXT NOT NULL,             -- PEM-encoded private key
    known_hosts     TEXT,                       -- host fingerprint for strict checking
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, label)
);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.automation_credential TO jlmirror_app;
GRANT SELECT ON g1.automation_credential TO jlmirror_worker;

COMMIT;
