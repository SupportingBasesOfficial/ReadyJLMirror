-- G1: Identity + Tenant + Protected Shell
-- Minimal durable schema for the G1 slice.
--
-- This schema implements the persistence required by
-- g1.identity-tenant-protected-shell@1:
--   - tenants, principals, memberships (durable authority inputs)
--   - browser sessions (opaque server-side session capability)
--   - OIDC pending states (PKCE transaction integrity)
--
-- Key invariants honored:
--   - Browser never holds a long-lived platform credential (opaque handle only).
--   - Session handle stored as SHA-256 digest — raw value never persisted.
--   - External IdP `sub` is an external reference (idp_subject_ref), never
--     a platform principal_id.
--   - Revocation is durable: `retired` / membership `state` / tenant `state`
--     are checked on every authority resolution.

BEGIN;

CREATE SCHEMA IF NOT EXISTS g1;

-- -------------------------------------------------------------------------
-- Tenants
-- -------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS g1.tenants (
    tenant_id           TEXT PRIMARY KEY,
    display_name        TEXT NOT NULL,
    state               TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'suspended')),
    isolation_class     TEXT NOT NULL DEFAULT 'pooled',
    cell_id             TEXT NOT NULL DEFAULT 'cell:dev-1',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- Principals
-- -------------------------------------------------------------------------
-- idp_subject_ref is the external provider reference (OIDC `sub`), stored
-- as an opaque external binding. It is never used as principal_id.

CREATE TABLE IF NOT EXISTS g1.principals (
    principal_id                TEXT PRIMARY KEY,
    kind                        TEXT NOT NULL DEFAULT 'human_browser_session'
                                CHECK (kind IN ('human_browser_session', 'platform_admin_principal')),
    credential_generation       TEXT NOT NULL,
    idp_subject_ref             TEXT UNIQUE,          -- external OIDC sub binding
    idp_issuer                  TEXT,                 -- external issuer binding
    active                      BOOLEAN NOT NULL DEFAULT TRUE,
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -------------------------------------------------------------------------
-- Tenant memberships
-- -------------------------------------------------------------------------
-- Membership is the platform-owned authorization link between a principal
-- and a tenant. IdP groups/roles never become membership truth.

CREATE TABLE IF NOT EXISTS g1.tenant_memberships (
    membership_id       TEXT PRIMARY KEY,
    tenant_id           TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    principal_id        TEXT NOT NULL REFERENCES g1.principals(principal_id),
    role                TEXT NOT NULL DEFAULT 'member'
                        CHECK (role IN ('member', 'tenant_admin')),
    state               TEXT NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'suspended', 'revoked')),
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, principal_id)
);

-- -------------------------------------------------------------------------
-- Browser sessions
-- -------------------------------------------------------------------------
-- Only the SHA-256 digest of the opaque handle is stored. The raw handle is
-- delivered to the browser once and never persisted. Session generation is
-- bound to the principal's credential generation at issuance.

CREATE TABLE IF NOT EXISTS g1.browser_sessions (
    handle_digest           TEXT PRIMARY KEY,         -- sha256 hex of opaque handle
    principal_id            TEXT NOT NULL REFERENCES g1.principals(principal_id),
    session_generation      TEXT NOT NULL,
    credential_generation   TEXT NOT NULL,            -- snapshot at issuance
    idp_session_ref         TEXT,                     -- external IdP session (sid)
    csrf_digest             TEXT NOT NULL,            -- sha256 hex of CSRF token
    bound_tenant_id         TEXT REFERENCES g1.tenants(tenant_id),
    authenticated_at        TIMESTAMPTZ NOT NULL,     -- ID token auth_time
    created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at              TIMESTAMPTZ NOT NULL,
    retired                 BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_browser_sessions_principal
    ON g1.browser_sessions (principal_id);
CREATE INDEX IF NOT EXISTS idx_browser_sessions_idp_session
    ON g1.browser_sessions (idp_session_ref) WHERE idp_session_ref IS NOT NULL;

-- -------------------------------------------------------------------------
-- OIDC pending states
-- -------------------------------------------------------------------------
-- One-shot OIDC transaction state. Each login attempt stores state, nonce,
-- PKCE verifier, and the post-login redirect. Consumed (deleted) on use and
-- expired by timestamp.

CREATE TABLE IF NOT EXISTS g1.oidc_pending_states (
    state_digest        TEXT PRIMARY KEY,             -- sha256 hex of state param
    nonce               TEXT NOT NULL,
    code_verifier       TEXT NOT NULL,
    post_login_redirect TEXT NOT NULL DEFAULT '/',
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at          TIMESTAMPTZ NOT NULL
);

COMMIT;
