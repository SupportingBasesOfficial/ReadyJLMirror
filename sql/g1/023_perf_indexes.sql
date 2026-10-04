-- Performance indexes for g1 schema.
-- S2-C: session cleanup queries scan expires_at; without this index,
--       finding expired non-retired sessions requires a full table scan.

CREATE INDEX IF NOT EXISTS idx_browser_session_expires
    ON g1_identity.browser_session (expires_at)
    WHERE retired_at IS NULL;
