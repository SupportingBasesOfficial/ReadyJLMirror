-- Outbox quarantine redrive (DLQ recovery path).
--
-- Quarantined messages are dead-lettered: publication failed past
-- the attempt cap. Without an operator path they sit forever. This
-- function is that path — quarantined -> pending with a fresh
-- attempt budget, bounded by redrive_count so a permanently
-- poisoned message cannot be redriven forever.
--
-- The operator redrive is authoritative: it clears the claim fields,
-- resets attempt_count, stamps last_error_class = 'operator_redrive'
-- for audit, and returns FALSE unless the row is quarantined.

BEGIN;

ALTER TABLE monitoring.monitoring_outbox
    ADD COLUMN IF NOT EXISTS redrive_count INTEGER NOT NULL DEFAULT 0;

CREATE OR REPLACE FUNCTION monitoring.redrive_outbox_message(
    p_tenant_id TEXT,
    p_record_id BIGINT,
    p_max_redrives INTEGER DEFAULT 5)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_temp
AS $$
DECLARE
    n INTEGER;
BEGIN
    UPDATE monitoring.monitoring_outbox
       SET dispatch_state = 'pending',
           claim_owner = NULL, claim_expires_at = NULL,
           attempt_count = 0,
           redrive_count = redrive_count + 1,
           last_error_class = 'operator_redrive'
     WHERE tenant_id = p_tenant_id
       AND record_id = p_record_id
       AND dispatch_state = 'quarantined'
       AND redrive_count < p_max_redrives;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n = 1;
END;
$$;

REVOKE ALL ON FUNCTION monitoring.redrive_outbox_message(TEXT, BIGINT, INTEGER)
    FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.redrive_outbox_message(TEXT, BIGINT, INTEGER)
    TO jlmirror_app;

COMMIT;
