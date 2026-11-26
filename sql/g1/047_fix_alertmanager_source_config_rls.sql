-- Hotfix: alertmanager_source_config needs cross-tenant lookup for webhook auth.
-- The ingest endpoint receives webhooks without a tenant context and must look up
-- which tenant owns the source_id. FORCE RLS broke all alertmanager ingestion.
-- alertmanager_event stays protected (inserted via db_tenant_connection after lookup).

BEGIN;

DROP POLICY IF EXISTS alertmanager_source_config_tenant ON g1.alertmanager_source_config;
ALTER TABLE g1.alertmanager_source_config DISABLE ROW LEVEL SECURITY;

COMMIT;
