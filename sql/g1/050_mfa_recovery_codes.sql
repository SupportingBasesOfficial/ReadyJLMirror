-- 050: MFA recovery codes.
-- 8 single-use codes per principal; stored as SHA-256 hex hashes.
-- Used via the public /api/mfa/recover endpoint when user loses TOTP device.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.mfa_recovery_codes (
    code_id      UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    principal_id TEXT        NOT NULL,
    code_hash    TEXT        NOT NULL,  -- SHA-256(plaintext_code), hex
    used_at      TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mfa_recovery_principal
    ON g1.mfa_recovery_codes (principal_id)
    WHERE used_at IS NULL;

GRANT SELECT, INSERT, UPDATE ON g1.mfa_recovery_codes TO jlmirror_app;

COMMIT;
