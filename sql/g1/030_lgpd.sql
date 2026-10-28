-- G-LGPD: Data subject deletion request log
-- Applied 2026-10-28

CREATE TABLE IF NOT EXISTS g1.lgpd_deletion_requests (
    request_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    principal_id TEXT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    status       TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'processing', 'completed', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_lgpd_requests_principal
    ON g1.lgpd_deletion_requests (principal_id);
