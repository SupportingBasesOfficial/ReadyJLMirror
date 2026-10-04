-- G25 Tenant Self-Service Onboarding.
-- New principals with no tenant membership call this function to
-- create their first workspace and receive admin membership.

BEGIN;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'jlmirror_g25_onboarding_app_invoker'
    ) THEN
        CREATE ROLE jlmirror_g25_onboarding_app_invoker;
    END IF;
END$$;

GRANT jlmirror_g25_onboarding_app_invoker TO jlmirror_app;

CREATE OR REPLACE FUNCTION g1.g25_register_tenant(
    p_principal_id TEXT,
    p_display_name TEXT
) RETURNS TABLE (tenant_id TEXT, membership_id TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = g1, public
AS $$
DECLARE
    v_tenant_id     TEXT := 'tnt:' || gen_random_uuid()::text;
    v_membership_id TEXT := 'mem_' || encode(gen_random_bytes(9), 'base64');
BEGIN
    -- Validate principal exists and is active
    IF NOT EXISTS (
        SELECT 1 FROM g1.principals
         WHERE principal_id = p_principal_id AND active = TRUE
    ) THEN
        RAISE EXCEPTION 'principal not found or inactive: %', p_principal_id;
    END IF;

    -- Validate display name
    IF trim(p_display_name) = '' THEN
        RAISE EXCEPTION 'display_name must not be empty';
    END IF;
    IF length(trim(p_display_name)) > 120 THEN
        RAISE EXCEPTION 'display_name too long (max 120 chars)';
    END IF;

    -- Create tenant
    INSERT INTO g1.tenants (tenant_id, display_name, state, isolation_class, cell_id)
    VALUES (v_tenant_id, trim(p_display_name), 'active', 'pooled', 'cell:dev-1');

    -- Grant admin membership
    INSERT INTO g1.tenant_memberships
        (membership_id, tenant_id, principal_id, role, state)
    VALUES (v_membership_id, v_tenant_id, p_principal_id, 'admin', 'active');

    RETURN QUERY SELECT v_tenant_id, v_membership_id;
END;
$$;

REVOKE ALL ON FUNCTION g1.g25_register_tenant(TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION g1.g25_register_tenant(TEXT, TEXT)
    TO jlmirror_g25_onboarding_app_invoker;

COMMIT;
