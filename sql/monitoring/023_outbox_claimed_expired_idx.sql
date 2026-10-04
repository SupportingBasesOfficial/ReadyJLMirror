-- Performance index for the outbox lease-expiry recovery path.
-- The dispatcher queries WHERE dispatch_state = 'claimed' AND claim_expires_at < now
-- to reclaim rows whose lease expired. Without this index the check degrades to a
-- full scan of claimed rows as the outbox grows under high message volume.

CREATE INDEX IF NOT EXISTS idx_monitoring_outbox_claimed_expired
    ON monitoring.monitoring_outbox (claim_expires_at)
    WHERE dispatch_state = 'claimed';
