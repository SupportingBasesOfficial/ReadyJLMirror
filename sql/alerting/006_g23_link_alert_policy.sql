-- G23 extension: allow linking an escalation policy to an alert policy version.
-- Adds escalation_policy_id (nullable FK) to alert_policy_version so operators
-- can associate a named escalation chain with an alert policy from the UI.

BEGIN;

ALTER TABLE alerting.alert_policy_version
    ADD COLUMN IF NOT EXISTS escalation_policy_id TEXT
        REFERENCES alerting.escalation_policy(policy_id)
        ON DELETE SET NULL;

GRANT UPDATE (escalation_policy_id)
    ON alerting.alert_policy_version
    TO jlmirror_g23_esc_app_invoker;

COMMIT;
