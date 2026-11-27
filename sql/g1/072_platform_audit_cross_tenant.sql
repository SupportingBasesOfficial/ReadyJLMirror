-- Migration 072: SECURITY DEFINER function for cross-tenant audit reads.
-- audit.audit_event has FORCE RLS; platform admin needs to query it
-- across all tenants without being bound to a single tenant_id.
-- This function runs as jlmirror_owner (BYPASSRLS) and is callable
-- by jlmirror_app via GRANT EXECUTE.

CREATE OR REPLACE FUNCTION audit.list_all_events(
    p_limit     INTEGER     DEFAULT 100,
    p_tenant_id TEXT        DEFAULT NULL,
    p_action    TEXT        DEFAULT NULL,
    p_actor_id  TEXT        DEFAULT NULL,
    p_since     TIMESTAMPTZ DEFAULT NULL
)
RETURNS TABLE (
    audit_event_id TEXT,
    tenant_id      TEXT,
    action         TEXT,
    actor_kind     TEXT,
    actor_id       TEXT,
    subject_type   TEXT,
    subject_id     TEXT,
    detail         JSONB,
    correlation_id TEXT,
    occurred_at    TIMESTAMPTZ
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = audit, pg_catalog, public
AS $$
BEGIN
    RETURN QUERY
    SELECT
        ae.audit_event_id,
        ae.tenant_id,
        ae.action,
        ae.actor_kind,
        ae.actor_id,
        ae.subject_type,
        ae.subject_id,
        ae.detail,
        ae.correlation_id,
        ae.occurred_at
    FROM audit.audit_event ae
    WHERE (p_tenant_id IS NULL OR ae.tenant_id = p_tenant_id)
      AND (p_action    IS NULL OR ae.action    = p_action)
      AND (p_actor_id  IS NULL OR ae.actor_id  = p_actor_id)
      AND (p_since     IS NULL OR ae.occurred_at >= p_since)
    ORDER BY ae.occurred_at DESC
    LIMIT p_limit;
END;
$$;

ALTER FUNCTION audit.list_all_events(INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ)
    OWNER TO jlmirror_owner;

GRANT EXECUTE ON FUNCTION audit.list_all_events(INTEGER, TEXT, TEXT, TEXT, TIMESTAMPTZ)
    TO jlmirror_app;
