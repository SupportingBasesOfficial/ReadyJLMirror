BEGIN;

ALTER TABLE g1.organizations
    ADD COLUMN IF NOT EXISTS org_kind TEXT NOT NULL DEFAULT 'client'
    CHECK (org_kind IN ('platform_operator', 'msp', 'client'));

-- Backfill known seed orgs; safe no-op on a fresh production DB.
UPDATE g1.organizations SET org_kind = 'platform_operator' WHERE organization_id = 'org:platform';
UPDATE g1.organizations SET org_kind = 'msp'               WHERE organization_id LIKE 'org:msp-%';

COMMIT;
