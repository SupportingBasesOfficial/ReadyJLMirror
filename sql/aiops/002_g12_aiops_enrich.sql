-- G12 AIOps — enrich findings schema for full context worker.
-- Adds recommended_action field and extends explanation capacity.

BEGIN;

-- Add recommended_action column (nullable — not all findings need an action).
ALTER TABLE aiops.finding
    ADD COLUMN IF NOT EXISTS recommended_action TEXT;

COMMIT;
