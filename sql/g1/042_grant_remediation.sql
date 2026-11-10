-- g1/042: Grant remediation for three g1 tables created without role grants.
--
-- g1/031_feature_flags.sql  — g1.feature_flag          (no grants at all)
-- g1/033_apm.sql            — g1.apm_request_log       (no grants at all)
-- g1/034_push_subscriptions — g1.push_subscription     (no grants at all)
--
-- All three tables are owned by jlmirror_owner (superuser) so they are
-- accessible to that role already; this migration fixes access for the
-- application roles that need to read/write them at runtime.

BEGIN;

-- ─── g1.feature_flag ──────────────────────────────────────────────────────────
-- jlmirror_app: full CRUD for the feature-flag management API.
-- jlmirror_worker: SELECT only — workers check whether modules are enabled
--                  before performing optional work (e.g. push dispatch, aiops).

GRANT SELECT, INSERT, UPDATE, DELETE
    ON g1.feature_flag
    TO jlmirror_app;

GRANT SELECT
    ON g1.feature_flag
    TO jlmirror_worker;

-- ─── g1.apm_request_log ───────────────────────────────────────────────────────
-- jlmirror_app: INSERT per request (APMMiddleware), SELECT + DELETE for the
--               purge/stats endpoint.  No worker access needed.
-- Note: tenant_id is nullable (unauthenticated requests); no RLS on this table.

GRANT SELECT, INSERT, DELETE
    ON g1.apm_request_log
    TO jlmirror_app;

GRANT USAGE, SELECT
    ON SEQUENCE g1.apm_request_log_id_seq
    TO jlmirror_app;

-- ─── g1.push_subscription ─────────────────────────────────────────────────────
-- jlmirror_app: full CRUD — subscribe, update, unsubscribe.
-- jlmirror_worker: SELECT only — notification worker resolves endpoint + keys
--                  before dispatching Web Push payloads.

GRANT SELECT, INSERT, UPDATE, DELETE
    ON g1.push_subscription
    TO jlmirror_app;

GRANT SELECT
    ON g1.push_subscription
    TO jlmirror_worker;

COMMIT;
