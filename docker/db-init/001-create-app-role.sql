-- Create the application role with least privilege.
-- Used by BFF and API for identity/session/tenant-scoped access.
-- The owner role (jlmirror_owner) is used for migrations and bootstrap.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jlmirror_app') THEN
        CREATE ROLE jlmirror_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT NOBYPASSRLS
            PASSWORD 'jlmirror_dev';
    END IF;
END
$$;

GRANT CONNECT ON DATABASE jlmirror TO jlmirror_app;
GRANT USAGE ON SCHEMA public TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO jlmirror_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jlmirror_app;

-- G1 schema is created here so grants apply; migrations create its tables.
CREATE SCHEMA IF NOT EXISTS g1 AUTHORIZATION jlmirror_owner;
GRANT USAGE ON SCHEMA g1 TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA g1 TO jlmirror_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA g1
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO jlmirror_app;
