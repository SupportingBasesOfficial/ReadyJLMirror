-- Align the publication bridge with the canonical g6 envelope
-- contract (contracts/g6-monitoring-alerting-transport/envelope.schema.json):
--   producer                 = 'Monitoring'            (was 'monitoring-transition-bridge')
--   subject_type             = monitoring_problem | monitoring_resource
--   subject_id               = canonical problem/resource id (was transition id)
--   data_classification      = 'confidential_tenant'   (was 'internal')
--   serialization_profile_id = 'jsonb-text-utf8@1'     (was 'canonical-json-utf8')
-- causation_id keeps binding to the exact owning transition; the wire
-- envelope composes the remaining contract fields (producer_generation,
-- operation_id, not_before, deadline, created_at — all null) at dispatch.

BEGIN;

CREATE OR REPLACE FUNCTION monitoring.publish_invalidation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_contract TEXT;
    v_transition_id TEXT;
    v_subject_type TEXT;
    v_subject_id TEXT;
    v_payload JSONB;
    v_message_id TEXT;
    v_correlation_id TEXT;
    v_scope TEXT := 'monitoring.alerting-bridge';
    v_existing BYTEA;
    v_evidence BYTEA;
BEGIN
    IF TG_TABLE_NAME = 'monitoring_problem_transition' THEN
        v_contract := 'monitoring.problem-state.changed';
        v_transition_id := NEW.problem_transition_id;
        v_subject_type := 'monitoring_problem';
        v_subject_id := NEW.problem_id;
        v_payload := jsonb_build_object(
            'problem_id', NEW.problem_id,
            'monitoring_source_id', NEW.monitoring_source_id,
            'source_instance_generation', NEW.source_instance_generation,
            'monitoring_resource_id', NEW.monitoring_resource_id,
            'projection_revision', NEW.projection_revision,
            'problem_transition_id', NEW.problem_transition_id);
    ELSIF TG_TABLE_NAME = 'health_projection_transition' THEN
        v_contract := 'monitoring.health-projection.changed';
        v_transition_id := NEW.health_transition_id;
        v_subject_type := 'monitoring_resource';
        v_subject_id := NEW.monitoring_resource_id;
        v_payload := jsonb_build_object(
            'monitoring_source_id', NEW.monitoring_source_id,
            'source_instance_generation', NEW.source_instance_generation,
            'monitoring_resource_id', NEW.monitoring_resource_id,
            'projection_revision', NEW.projection_revision,
            'health_transition_id', NEW.health_transition_id);
    ELSE
        RAISE EXCEPTION 'publication bridge: unsupported table %', TG_TABLE_NAME;
    END IF;

    -- Deterministic compaction — never used as security evidence.
    v_message_id := 'msg_' || md5(
        NEW.tenant_id || '|' || v_contract || '|' || v_transition_id);
    v_correlation_id := 'corr_' || md5(
        NEW.tenant_id || '|' || v_contract || '|ctx|' || v_transition_id);
    v_evidence := digest(v_payload::text, 'sha256');

    -- Identity-conflict check: same scoped message_id with different
    -- immutable meaning is an integrity failure, not a dedupe.
    SELECT o.comparison_evidence INTO v_existing
      FROM monitoring.monitoring_outbox o
     WHERE o.tenant_id = NEW.tenant_id
       AND o.producer_message_scope = v_scope
       AND o.message_id = v_message_id;
    IF FOUND AND v_existing <> v_evidence THEN
        RAISE EXCEPTION 'monitoring.publication_identity_conflict: %', v_message_id;
    END IF;

    INSERT INTO monitoring.monitoring_outbox
        (tenant_id, message_id, producer_message_scope, message_class,
         contract_name, contract_version, producer, scope,
         correlation_id, causation_id, data_classification,
         serialization_profile_id, encoded_payload,
         comparison_evidence, comparison_profile_id,
         comparison_profile_version, subject_type, subject_id,
         occurred_at)
    VALUES
        (NEW.tenant_id, v_message_id, v_scope, 'integration_event',
         v_contract, '1', 'Monitoring', 'tenant',
         v_correlation_id, v_transition_id, 'confidential_tenant',
         'jsonb-text-utf8@1', convert_to(v_payload::text, 'UTF8'),
         v_evidence, 'sha256-canonical-json', '1',
         v_subject_type, v_subject_id,
         transaction_timestamp())
    ON CONFLICT (tenant_id, producer_message_scope, message_id) DO NOTHING;

    RETURN NULL;
END;
$fn$;

COMMIT;
