-- Migration 049: Track encryption state for SSH private keys.
-- Adds a boolean column so the application layer can distinguish between
-- plaintext keys (legacy/dev) and Fernet-encrypted keys (production).
-- Actual encryption is performed in the application layer (shared/ssh_crypto.py)
-- using AUTOMATION_CRED_ENC_KEY. When the env var is unset (dev), keys are
-- stored plaintext and key_pem_encrypted remains FALSE.

BEGIN;

ALTER TABLE g1.automation_credential
  ADD COLUMN IF NOT EXISTS key_pem_encrypted BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN g1.automation_credential.key_pem_encrypted IS
  'TRUE when key_pem contains a Fernet-encrypted value (AUTOMATION_CRED_ENC_KEY). '
  'FALSE for plaintext keys stored before encryption was enabled.';

COMMIT;
