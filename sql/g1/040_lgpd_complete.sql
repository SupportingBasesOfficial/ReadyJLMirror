-- g1/040: LGPD schema completion.
-- g1/030_lgpd.sql created the table with UUID PK and no resolved_at/notes.
-- monitoring/026_prod_gap_grants.sql tried to CREATE TABLE with these columns
-- but was a no-op because the table already existed. Add them here.

BEGIN;

ALTER TABLE g1.lgpd_deletion_requests
    ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notes TEXT;

COMMIT;
