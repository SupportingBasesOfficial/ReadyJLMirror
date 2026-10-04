-- G12 AIOps — role grants.
-- jlmirror_worker (BYPASSRLS): INSERT + SELECT for analysis writes.
-- jlmirror_app: SELECT only — reads are tenant-scoped via RLS.

BEGIN;

GRANT USAGE ON SCHEMA aiops TO jlmirror_worker;
GRANT SELECT, INSERT ON aiops.analysis_run TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE ON aiops.finding TO jlmirror_worker;

GRANT USAGE ON SCHEMA aiops TO jlmirror_app;
GRANT SELECT ON aiops.analysis_run TO jlmirror_app;
GRANT SELECT, UPDATE ON aiops.finding TO jlmirror_app;

ALTER DEFAULT PRIVILEGES IN SCHEMA aiops
    GRANT SELECT, INSERT, UPDATE ON TABLES TO jlmirror_worker;
ALTER DEFAULT PRIVILEGES IN SCHEMA aiops
    GRANT SELECT ON TABLES TO jlmirror_app;

COMMIT;
