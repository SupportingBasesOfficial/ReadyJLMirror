BEGIN;

-- Close RLS gap: incident_time_entry was created with ENABLE but not FORCE.
-- Without FORCE, the table owner (jlmirror_g10_itsm_executor) can bypass RLS
-- when connecting directly, outside SECURITY DEFINER functions.
-- Also aligns the policy predicate with every other g10 table (NULLIF pattern).

ALTER TABLE itsm.incident_time_entry FORCE ROW LEVEL SECURITY;

-- Replace the policy: use NULLIF so an empty-string GUC returns NULL,
-- which makes the predicate false (no row matches) rather than
-- matching rows with tenant_id = '' (which don't exist but is inconsistent).
DROP POLICY IF EXISTS incident_time_entry_tenant_isolation ON itsm.incident_time_entry;

CREATE POLICY g10_time_entry_tenant ON itsm.incident_time_entry
USING (tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), ''))
WITH CHECK (tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), ''));

DO $$
BEGIN
  -- Verify FORCE is now set
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'itsm'
      AND c.relname = 'incident_time_entry'
      AND c.relrowsecurity = true
      AND c.relforcerowsecurity = true
  ) THEN
    RAISE EXCEPTION 'g10.time_entry_force_rls_not_applied';
  END IF;

  -- Verify correct policy exists
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies
    WHERE schemaname = 'itsm'
      AND tablename = 'incident_time_entry'
      AND policyname = 'g10_time_entry_tenant'
  ) THEN
    RAISE EXCEPTION 'g10.time_entry_policy_missing';
  END IF;
END;
$$;

COMMIT;
