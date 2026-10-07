-- G24 addendum: configurable status page components.
-- Adds an optional JSONB array of custom service components to the
-- tenant_status_config table. Defaults to empty array so existing rows
-- are unaffected and no backfill is required.

BEGIN;

ALTER TABLE g1.tenant_status_config
  ADD COLUMN IF NOT EXISTS components JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN g1.tenant_status_config.components IS
  'Ordered list of custom service components shown on the public status '
  'page. Each element: {name, description?, '
  'status: operational|degraded|outage|maintenance}.';

COMMIT;
