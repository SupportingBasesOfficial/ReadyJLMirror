BEGIN;

GRANT jlmirror_g11_ir_app_invoker    TO jlmirror_app;
GRANT jlmirror_g11_ir_worker_invoker TO jlmirror_worker;

-- Worker needs to read tenants to drive per-tenant polling
GRANT SELECT ON g1.tenants TO jlmirror_g11_ir_worker_invoker;

COMMIT;
