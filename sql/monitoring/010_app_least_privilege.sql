-- Wave 4 hardening — least-privilege monitoring grants for jlmirror_app.
--
-- The API's write authority is exactly the onboarding path:
--   source create  -> source, generation, create_idempotency, sync_operation
--   poll enqueue   -> sync_operation
--   idempotent replay -> UPDATE on source_create_idempotency
-- Everything else is read-only projection access. All lifecycle writes
-- (claim/complete, projections, transitions, outbox dispatch) belong to
-- jlmirror_worker — the single system-authority role (run_all executes
-- every responsibility loop in one process, so responsibility-level
-- roles cannot map to process boundaries).
--
-- Idempotent: safe to run on fresh and existing installs.

REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA monitoring
    FROM jlmirror_app;

GRANT SELECT ON ALL TABLES IN SCHEMA monitoring TO jlmirror_app;

GRANT INSERT ON
    monitoring.monitoring_source,
    monitoring.monitoring_source_generation,
    monitoring.monitoring_source_create_idempotency,
    monitoring.monitoring_sync_operation
    TO jlmirror_app;

GRANT UPDATE ON
    monitoring.monitoring_source_create_idempotency
    TO jlmirror_app;

-- Future monitoring tables default to read-only for the app role;
-- writes must be granted explicitly as new responsibilities land.
ALTER DEFAULT PRIVILEGES FOR ROLE jlmirror_owner IN SCHEMA monitoring
    GRANT SELECT ON TABLES TO jlmirror_app;
