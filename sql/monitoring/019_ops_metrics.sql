-- Ops metrics aggregation — SECURITY DEFINER so the least-privilege
-- app role can read cross-tenant pipeline aggregates without RLS
-- bypass on the underlying tables. Returns aggregate counts only;
-- no row content, tenant ids, or identifiers leave the function.

BEGIN;

CREATE OR REPLACE FUNCTION monitoring.ops_metrics()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_temp
AS $$
DECLARE
    result JSONB;
BEGIN
    SELECT jsonb_build_object(
        'sync_operations', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('state', state, 'n', n))
              FROM (SELECT state, count(*) AS n
                      FROM monitoring.monitoring_sync_operation
                     GROUP BY state) s), '[]'::jsonb),
        'oldest_pending_seconds', COALESCE((
            SELECT extract(epoch FROM
                           transaction_timestamp() - min(created_at))
              FROM monitoring.monitoring_sync_operation
             WHERE state = 'pending'), 0),
        'outbox', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('state', s.state,
                                                'n', n))
              FROM (SELECT dispatch_state AS state, count(*) AS n
                      FROM monitoring.monitoring_outbox
                     GROUP BY dispatch_state) s), '[]'::jsonb),
        'outbox_oldest_pending_seconds', COALESCE((
            SELECT extract(epoch FROM
                           transaction_timestamp() - min(created_at))
              FROM monitoring.monitoring_outbox
             WHERE dispatch_state = 'pending'), 0),
        'outbox_attempts_total', COALESCE((
            SELECT sum(attempt_count)
              FROM monitoring.monitoring_outbox), 0),
        'inbox_receipts', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('state', state, 'n', n))
              FROM (SELECT state, count(*) AS n
                      FROM alerting.inbox_receipt
                     GROUP BY state) s), '[]'::jsonb),
        'alerts', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('state', s.state,
                                                'n', n))
              FROM (SELECT lifecycle_state AS state, count(*) AS n
                      FROM alerting.alert
                     GROUP BY lifecycle_state) s), '[]'::jsonb),
        'notification_intents_total', COALESCE((
            SELECT count(*) FROM notification.notification_intent), 0),
        'sources', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                               'state', s.state,
                               'n', n))
              FROM (SELECT operational_evidence_state AS state,
                           count(*) AS n
                      FROM monitoring.monitoring_source
                     GROUP BY operational_evidence_state) s),
            '[]'::jsonb),
        'resources', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('state', s.state,
                                                'n', n))
              FROM (SELECT presence_state AS state, count(*) AS n
                      FROM monitoring.monitoring_resource
                     GROUP BY presence_state) s), '[]'::jsonb),
        'problems', COALESCE((
            SELECT jsonb_agg(jsonb_build_object('state', s.state,
                                                'n', n))
              FROM (SELECT problem_state AS state, count(*) AS n
                      FROM monitoring.monitoring_problem
                     GROUP BY problem_state) s), '[]'::jsonb),
        'worker_heartbeat_staleness_seconds', COALESCE((
            SELECT extract(epoch FROM
                           transaction_timestamp() - max(last_seen_at))
              FROM monitoring.worker_heartbeat), -1)
    ) INTO result;
    RETURN result;
END;
$$;

REVOKE ALL ON FUNCTION monitoring.ops_metrics() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION monitoring.ops_metrics()
    TO jlmirror_app, jlmirror_worker;

COMMIT;
