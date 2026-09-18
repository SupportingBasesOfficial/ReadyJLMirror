-- Wave 4 Monitoring -> Alerting publication bridge
-- (authorization: wave4.monitoring-alerting-publication@1)
--
-- AFTER INSERT triggers on the immutable Monitoring transition tables
-- create an outbox obligation IN THE SAME TRANSACTION:
--   TRANSITION ROLLBACK => OUTBOX ROLLBACK
--   TRANSITION COMMIT   => OUTBOX OBLIGATION COMMIT
--
-- Deterministic identities per the envelope law:
--   message_id     = immutable integration-event identity
--   correlation_id = distinct correlation identity bound to the
--                    owning transition context
--   causation_id   = the exact owning Monitoring transition
-- Payloads carry ONLY canonical identities/revisions — never
-- lifecycle values, severity or health classes.

-- Envelope law: causation_id identifies the exact owning transition;
-- it is never the same value as message_id or correlation_id.
ALTER TABLE monitoring.monitoring_outbox
    ADD COLUMN IF NOT EXISTS causation_id TEXT NULL;

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION monitoring.publish_invalidation()
RETURNS trigger
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_contract TEXT;
    v_transition_id TEXT;
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
         v_contract, '1', 'monitoring-transition-bridge', 'tenant',
         v_correlation_id, v_transition_id, 'internal',
         'canonical-json-utf8', convert_to(v_payload::text, 'UTF8'),
         v_evidence, 'sha256-canonical-json', '1',
         'monitoring_transition', v_transition_id,
         transaction_timestamp())
    ON CONFLICT (tenant_id, producer_message_scope, message_id) DO NOTHING;

    RETURN NULL;
END;
$fn$;

DROP TRIGGER IF EXISTS problem_transition_publication
    ON monitoring.monitoring_problem_transition;
CREATE TRIGGER problem_transition_publication
    AFTER INSERT ON monitoring.monitoring_problem_transition
    FOR EACH ROW EXECUTE FUNCTION monitoring.publish_invalidation();

DROP TRIGGER IF EXISTS health_transition_publication
    ON monitoring.health_projection_transition;
CREATE TRIGGER health_transition_publication
    AFTER INSERT ON monitoring.health_projection_transition
    FOR EACH ROW EXECUTE FUNCTION monitoring.publish_invalidation();
