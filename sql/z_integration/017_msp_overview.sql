BEGIN;

-- MSP cross-tenant overview function.
-- p_tenant_ids is the caller-authorized list of tenant IDs (delegated grants).
-- This function bypasses RLS deliberately: access control is enforced by the
-- calling layer (accessible_tenants() in shared/access.py).
CREATE OR REPLACE FUNCTION g1.msp_tenant_overview(
    p_tenant_ids TEXT[]
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,g1,alerting,itsm
AS $$
DECLARE v_result JSONB;
BEGIN
    SELECT COALESCE(
        jsonb_agg(to_jsonb(x) ORDER BY x.critical_alerts DESC, x.active_alerts DESC),
        '[]'::jsonb
    )
    INTO v_result
    FROM (
        SELECT
            t.tenant_id,
            t.display_name,
            t.state,
            t.organization_id,
            o.display_name AS org_display_name,
            COALESCE(a.active_alerts,      0) AS active_alerts,
            COALESCE(a.critical_alerts,    0) AS critical_alerts,
            COALESCE(a.degraded_alerts,    0) AS degraded_alerts,
            COALESCE(i.open_incidents,     0) AS open_incidents,
            COALESCE(i.in_progress_incidents, 0) AS in_progress_incidents
        FROM g1.tenants t
        LEFT JOIN g1.organizations o
               ON o.organization_id = t.organization_id
        LEFT JOIN (
            SELECT
                tenant_id,
                count(*) FILTER (
                    WHERE lifecycle_state = 'active'
                ) AS active_alerts,
                count(*) FILTER (
                    WHERE lifecycle_state = 'active'
                      AND source_evidence_summary->>'severity_class' = 'critical'
                ) AS critical_alerts,
                count(*) FILTER (
                    WHERE lifecycle_state = 'active'
                      AND source_evidence_summary->>'severity_class' IN ('degraded','warning')
                ) AS degraded_alerts
            FROM alerting.alert
            WHERE tenant_id = ANY(p_tenant_ids)
            GROUP BY tenant_id
        ) a ON a.tenant_id = t.tenant_id
        LEFT JOIN (
            SELECT
                tenant_id,
                count(*) FILTER (WHERE lifecycle_state = 'open') AS open_incidents,
                count(*) FILTER (WHERE lifecycle_state = 'in_progress') AS in_progress_incidents
            FROM itsm.incident
            WHERE tenant_id = ANY(p_tenant_ids)
            GROUP BY tenant_id
        ) i ON i.tenant_id = t.tenant_id
        WHERE t.tenant_id = ANY(p_tenant_ids)
    ) x;

    RETURN v_result;
END;
$$;

ALTER FUNCTION g1.msp_tenant_overview(TEXT[]) OWNER TO jlmirror_owner;

REVOKE ALL ON FUNCTION g1.msp_tenant_overview(TEXT[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION g1.msp_tenant_overview(TEXT[]) TO jlmirror_app;

COMMIT;
