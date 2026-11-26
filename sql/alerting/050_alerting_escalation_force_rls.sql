-- Migration 050: FORCE ROW LEVEL SECURITY on alerting escalation tables.
--
-- Without FORCE RLS, a table owner (superuser or the role that created the
-- table) can bypass the RLS policies.  Adding FORCE RLS means the policies
-- apply to ALL roles — including the table owner — which is the correct
-- posture for multi-tenant isolation.
--
-- This is a no-data-change migration: it only alters the RLS enforcement
-- setting on three existing tables.  It is safe to run while the application
-- is live and can be applied to both dev and production without downtime.

BEGIN;

ALTER TABLE alerting.escalation_policy   FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.escalation_step     FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_escalation    FORCE ROW LEVEL SECURITY;

COMMIT;
