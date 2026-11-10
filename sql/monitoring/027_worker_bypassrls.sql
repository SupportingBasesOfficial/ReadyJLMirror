-- monitoring/027: Fix jlmirror_worker BYPASSRLS.
-- monitoring/009 tried to CREATE ROLE jlmirror_worker WITH BYPASSRLS but the
-- role was already created in bootstrap (001-create-app-role.sql) WITHOUT it,
-- so the IF NOT EXISTS block skipped the BYPASSRLS flag. Workers are
-- cross-tenant system actors and must bypass all RLS policies.

ALTER ROLE jlmirror_worker BYPASSRLS;
