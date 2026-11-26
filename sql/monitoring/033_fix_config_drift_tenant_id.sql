-- 033: corrigir tipo tenant_id em config_baseline e config_drift_event.
-- g1.tenants.tenant_id é TEXT; as demais tabelas monitoring também usam TEXT.
-- As duas tabelas em 025_config_drift.sql foram criadas com UUID por engano.
-- Idempotente — ALTER TYPE TEXT é no-op se a coluna já for TEXT.

ALTER TABLE monitoring.config_baseline
    ALTER COLUMN tenant_id TYPE TEXT;

ALTER TABLE monitoring.config_drift_event
    ALTER COLUMN tenant_id TYPE TEXT;
