-- Audit actor-kind vocabulary widened for the access layer:
-- 'platform_admin' (privileged cross-tenant capability) and
-- 'delegated_principal' (service-provider authority acting on a
-- target tenant) are distinct, attributable actor classes.

BEGIN;

ALTER TABLE audit.audit_event
    DROP CONSTRAINT IF EXISTS audit_event_actor_kind_check;
ALTER TABLE audit.audit_event
    ADD CONSTRAINT audit_event_actor_kind_check
    CHECK (actor_kind IN (
        'principal', 'system', 'worker', 'operator',
        'platform_admin', 'delegated_principal'));

COMMIT;
