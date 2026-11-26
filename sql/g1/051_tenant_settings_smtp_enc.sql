-- Migration 051: Add smtp_password_encrypted flag to g1.tenant_settings.
--
-- Existing rows get FALSE (plaintext — no data change).
-- New rows written by the API will carry the encrypted ciphertext and TRUE.
-- The API reads this flag at decrypt time; workers do the same.

ALTER TABLE g1.tenant_settings
    ADD COLUMN IF NOT EXISTS smtp_password_encrypted BOOLEAN NOT NULL DEFAULT FALSE;
