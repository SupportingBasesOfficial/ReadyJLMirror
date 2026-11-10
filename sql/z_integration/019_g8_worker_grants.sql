-- z_integration/019: jlmirror_worker grants on human_operations schema.
-- z_integration/003_g8_human_operations.sql granted only jlmirror_app.
-- Workers processing alert lifecycle, escalation, and incident response
-- need access to these tables. BYPASSRLS on the worker role (monitoring/027)
-- ensures RLS FORCE policies are bypassed correctly.

BEGIN;

GRANT USAGE ON SCHEMA human_operations TO jlmirror_worker;

GRANT SELECT, INSERT, UPDATE ON
    human_operations.resource_responsibility_assignment,
    human_operations.alert_action_assignment,
    human_operations.alert_acknowledgement,
    human_operations.visibility_requirement,
    human_operations.visibility_receipt,
    human_operations.current_action_projection
TO jlmirror_worker;

ALTER DEFAULT PRIVILEGES IN SCHEMA human_operations
    GRANT SELECT, INSERT, UPDATE ON TABLES TO jlmirror_worker;

COMMIT;
