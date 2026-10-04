-- G27 API Keys — programmatic access to the platform API.
-- Raw key is shown ONCE to the creator; only the SHA-256 digest is stored.
-- Key format: jlm_<base64url(32 random bytes)>

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'jlmirror_g27_apikey_app_invoker'
    ) THEN
        CREATE ROLE jlmirror_g27_apikey_app_invoker;
    END IF;
END$$;

GRANT jlmirror_g27_apikey_app_invoker TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.api_keys (
    key_id          TEXT PRIMARY KEY,           -- 'apikey:<uuid>'
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    principal_id    TEXT NOT NULL REFERENCES g1.principals(principal_id),
    key_digest      TEXT NOT NULL UNIQUE,       -- sha256 hex of raw key
    label           TEXT NOT NULL,
    scopes          TEXT[] NOT NULL DEFAULT ARRAY['read'],
    state           TEXT NOT NULL DEFAULT 'active'
                    CHECK (state IN ('active', 'revoked')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at      TIMESTAMPTZ,
    last_used_at    TIMESTAMPTZ,
    revoked_at      TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_api_keys_tenant
    ON g1.api_keys (tenant_id) WHERE state = 'active';
CREATE INDEX IF NOT EXISTS idx_api_keys_digest
    ON g1.api_keys (key_digest) WHERE state = 'active';

GRANT SELECT, INSERT, UPDATE ON g1.api_keys TO jlmirror_app;

-- SECURITY DEFINER functions for key management

CREATE OR REPLACE FUNCTION g1.g27_create_api_key(
    p_tenant_id     TEXT,
    p_principal_id  TEXT,
    p_key_digest    TEXT,
    p_label         TEXT,
    p_scopes        TEXT[],
    p_expires_at    TIMESTAMPTZ DEFAULT NULL
) RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = g1, public
AS $$
DECLARE
    v_key_id TEXT := 'apikey:' || gen_random_uuid()::text;
BEGIN
    IF trim(p_label) = '' THEN
        RAISE EXCEPTION 'label must not be empty';
    END IF;
    IF array_length(p_scopes, 1) IS NULL THEN
        RAISE EXCEPTION 'at least one scope required';
    END IF;

    INSERT INTO g1.api_keys
        (key_id, tenant_id, principal_id, key_digest, label, scopes, expires_at)
    VALUES
        (v_key_id, p_tenant_id, p_principal_id, p_key_digest, trim(p_label),
         p_scopes, p_expires_at);

    RETURN v_key_id;
END;
$$;

CREATE OR REPLACE FUNCTION g1.g27_revoke_api_key(
    p_tenant_id TEXT,
    p_key_id    TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = g1, public
AS $$
BEGIN
    UPDATE g1.api_keys
       SET state = 'revoked', revoked_at = now()
     WHERE key_id = p_key_id AND tenant_id = p_tenant_id AND state = 'active';
    RETURN FOUND;
END;
$$;

CREATE OR REPLACE FUNCTION g1.g27_record_key_use(p_key_digest TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = g1, public
AS $$
BEGIN
    UPDATE g1.api_keys SET last_used_at = now()
     WHERE key_digest = p_key_digest AND state = 'active';
END;
$$;

REVOKE ALL ON FUNCTION g1.g27_create_api_key(TEXT,TEXT,TEXT,TEXT,TEXT[],TIMESTAMPTZ) FROM PUBLIC;
REVOKE ALL ON FUNCTION g1.g27_revoke_api_key(TEXT,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION g1.g27_record_key_use(TEXT) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION g1.g27_create_api_key(TEXT,TEXT,TEXT,TEXT,TEXT[],TIMESTAMPTZ)
    TO jlmirror_g27_apikey_app_invoker;
GRANT EXECUTE ON FUNCTION g1.g27_revoke_api_key(TEXT,TEXT)
    TO jlmirror_g27_apikey_app_invoker;
GRANT EXECUTE ON FUNCTION g1.g27_record_key_use(TEXT)
    TO jlmirror_g27_apikey_app_invoker;

COMMIT;
