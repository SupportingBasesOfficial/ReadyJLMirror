-- G10 invoker wiring — ReadyJLMirror service roles assume the
-- canonical invoker roles via SET ROLE (invokers are NOINHERIT, so
-- membership alone confers nothing; the app must explicitly SET
-- LOCAL ROLE inside the transaction that calls the g10 functions).
-- Worker additionally reads g1.tenants to enumerate tenant sync
-- queues — read-only, no itsm.* table access (canonical boundary).

BEGIN;

GRANT jlmirror_g10_itsm_app_invoker TO jlmirror_app;
GRANT jlmirror_g10_itsm_worker_invoker TO jlmirror_worker;
GRANT SELECT ON g1.tenants TO jlmirror_worker;

COMMIT;
