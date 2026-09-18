-- Readiness probe for the worker pipeline (ADR-017): a guarded
-- SECURITY DEFINER function owned by the domain authority that
-- reports whether any worker heartbeat is fresh. The app role only
-- gets EXECUTE — it cannot read or write the heartbeat table's
-- 'system' rows directly.

CREATE OR REPLACE FUNCTION monitoring.worker_alive(p_max_age_seconds INT)
RETURNS TABLE (
    worker_id TEXT,
    last_seen_at TIMESTAMPTZ,
    seconds_stale INT,
    alive BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_temp
AS $$
BEGIN
    RETURN QUERY
        SELECT h.worker_id, h.last_seen_at,
               GREATEST(0, EXTRACT(EPOCH FROM
                   (statement_timestamp() - h.last_seen_at)))::INT,
               (statement_timestamp() - h.last_seen_at)
                   <= make_interval(secs => p_max_age_seconds)
          FROM monitoring.worker_heartbeat h
         WHERE h.tenant_id = 'system';
END;
$$;

REVOKE ALL ON FUNCTION monitoring.worker_alive(INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.worker_alive(INT)
    TO jlmirror_app, jlmirror_worker;
