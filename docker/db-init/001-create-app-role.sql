-- Create the application role with least privilege.
-- This role is used by the API and workers for tenant-scoped access.
-- The owner role (jlmirror_owner) is used for migrations and bootstrap.

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'jlmirror_app') THEN
        CREATE ROLE jlmirror_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
    END IF;
END
$$;

-- Grant connect on the database
GRANT CONNECT ON DATABASE jlmirror TO jlmirror_app;

-- Grant usage on the public schema
GRANT USAGE ON SCHEMA public TO jlmirror_app;
GRANT USAGE ON SCHEMA monitoring TO jlmirror_app;
GRANT USAGE ON SCHEMA system TO jlmirror_app;
GRANT USAGE ON SCHEMA platform TO jlmirror_app;
