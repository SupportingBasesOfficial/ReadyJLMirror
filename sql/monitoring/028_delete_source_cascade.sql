-- Migration 028: monitoring.delete_source_cascade(tenant_id, source_id)
--
-- Deletes every row in every monitoring table that belongs to a given source,
-- then deletes the source itself.  Called by the delete_source API endpoint.
--
-- Why a function instead of raw DELETEs in Python:
--   Many evidence tables carry BEFORE DELETE row triggers that call
--   monitoring.reject_evidence_mutation() to enforce immutability.  Those
--   triggers fire even for jlmirror_owner.  The only safe bypass is
--   session_replication_role = 'replica', which suppresses all non-ALWAYS /
--   non-REPLICA row triggers for the current session.  Only a superuser or
--   a role with the REPLICATION attribute may set that GUC, so we wrap the
--   operation in a SECURITY DEFINER function owned by jlmirror_owner and
--   grant EXECUTE to jlmirror_app.
--
-- Deletion order: leaf-to-root (mirrors purge_test_tenant.py).
-- All foreign keys in the monitoring schema are DEFERRABLE INITIALLY DEFERRED,
-- so FK checks fire only at COMMIT, not per-statement.  Deleting in
-- leaf-to-root order means that by COMMIT every referencing row is gone,
-- so no FK violation occurs.
--
-- RLS: jlmirror_owner is exempt from FORCE RLS; the function enforces
-- tenant isolation explicitly through the p_tenant_id parameter in every
-- WHERE clause.

CREATE OR REPLACE FUNCTION monitoring.delete_source_cascade(
    p_tenant_id  TEXT,
    p_source_id  TEXT
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = monitoring, pg_catalog
AS $$
DECLARE
    v_counts jsonb := '{}'::jsonb;
    v_n      integer;
BEGIN
    -- Bypass immutability row triggers for this transaction only.
    -- SET LOCAL reverts automatically when the transaction ends (or on rollback).
    -- Deferred FK constraint triggers still fire at the outer COMMIT, but all
    -- referencing rows are deleted below so no FK violation will occur.
    SET LOCAL session_replication_role = 'replica';

    -- ── metric current state ─────────────────────────────────────────────────
    DELETE FROM monitoring.monitoring_metric_current_state_transition
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_metric_current_state_transition', v_n);

    DELETE FROM monitoring.metric_current_state
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('metric_current_state', v_n);

    -- ── metric history ───────────────────────────────────────────────────────
    DELETE FROM monitoring.metric_observation
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('metric_observation', v_n);

    DELETE FROM monitoring.monitoring_metric_observation_acceptance
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_metric_observation_acceptance', v_n);

    DELETE FROM monitoring.metric_history_gap_evidence
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('metric_history_gap_evidence', v_n);

    DELETE FROM monitoring.metric_history_stream_state
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('metric_history_stream_state', v_n);

    -- ── metric definitions ───────────────────────────────────────────────────
    -- monitoring_metric_definition_provider_evidence has no direct
    -- monitoring_source_id — resolve via snapshot_evidence.
    DELETE FROM monitoring.monitoring_metric_definition_provider_evidence
        WHERE tenant_id = p_tenant_id
          AND metric_definition_snapshot_evidence_id IN (
              SELECT metric_definition_snapshot_evidence_id
              FROM   monitoring.monitoring_metric_definition_snapshot_evidence
              WHERE  tenant_id = p_tenant_id
                AND  monitoring_source_id = p_source_id
          );
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_metric_definition_provider_evidence', v_n);

    DELETE FROM monitoring.monitoring_metric_definition_snapshot_evidence
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_metric_definition_snapshot_evidence', v_n);

    DELETE FROM monitoring.metric_definition_provider_binding
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('metric_definition_provider_binding', v_n);

    DELETE FROM monitoring.metric_definition
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('metric_definition', v_n);

    -- ── problems and health ──────────────────────────────────────────────────
    DELETE FROM monitoring.monitoring_problem_transition
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_problem_transition', v_n);

    DELETE FROM monitoring.health_projection_transition
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('health_projection_transition', v_n);

    DELETE FROM monitoring.health_projection
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('health_projection', v_n);

    DELETE FROM monitoring.monitoring_problem
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_problem', v_n);

    DELETE FROM monitoring.monitoring_problem_snapshot_evidence
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_problem_snapshot_evidence', v_n);

    DELETE FROM monitoring.monitoring_problem_provider_binding
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_problem_provider_binding', v_n);

    -- ── bindings and runtime state ───────────────────────────────────────────
    DELETE FROM monitoring.monitoring_trigger_binding
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_trigger_binding', v_n);

    DELETE FROM monitoring.monitoring_problem_state_runtime_admission
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_problem_state_runtime_admission', v_n);

    -- ── resources and inventory ──────────────────────────────────────────────
    DELETE FROM monitoring.monitoring_resource
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_resource', v_n);

    DELETE FROM monitoring.monitoring_resource_provider_evidence
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_resource_provider_evidence', v_n);

    DELETE FROM monitoring.monitoring_host_inventory_snapshot_evidence
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_host_inventory_snapshot_evidence', v_n);

    -- ── validation evidence ──────────────────────────────────────────────────
    DELETE FROM monitoring.monitoring_source_validation_evidence
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_source_validation_evidence', v_n);

    -- monitoring_outbox has no FK to monitoring_source; skip per-source delete.

    -- ── sync operations (must be deleted before source / generation) ─────────
    DELETE FROM monitoring.monitoring_sync_operation
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_sync_operation', v_n);

    DELETE FROM monitoring.monitoring_source_create_idempotency
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_source_create_idempotency', v_n);

    -- ── source root (circular FKs — both absent at COMMIT) ──────────────────
    -- monitoring_source.active_source_instance_generation → monitoring_source_generation
    -- monitoring_source_generation.monitoring_source_id    → monitoring_source
    -- Both are DEFERRABLE INITIALLY DEFERRED; PostgreSQL checks them only
    -- at COMMIT, so deleting both here (without a SAVEPOINT between them)
    -- satisfies both constraints in a single commit boundary.
    DELETE FROM monitoring.monitoring_source_generation
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_source_generation', v_n);

    DELETE FROM monitoring.monitoring_source
        WHERE tenant_id = p_tenant_id AND monitoring_source_id = p_source_id;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    v_counts := v_counts || jsonb_build_object('monitoring_source', v_n);

    RETURN v_counts;
END;
$$;

-- jlmirror_app calls this; it executes with jlmirror_owner privileges.
GRANT EXECUTE ON FUNCTION monitoring.delete_source_cascade(TEXT, TEXT)
    TO jlmirror_app;
