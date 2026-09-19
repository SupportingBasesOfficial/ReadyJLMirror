-- G9 notification delivery — canonical authorization
-- g9.notification-delivery@1. Exactly the six admitted relations.
--
-- Laws: intent != attempt != provider evidence; sent != accepted !=
-- delivered != external read != G8 authoritative view; provider IDs
-- are evidence refs, never platform identity; unknown stays unknown.

BEGIN;

CREATE SCHEMA IF NOT EXISTS notification;

-- Immutable intent — one alert, one destination, one reason.
CREATE TABLE notification.notification_intent (
    tenant_id TEXT NOT NULL,
    notification_intent_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    recipient_principal_id TEXT NULL,
    destination_ref TEXT NOT NULL,
    channel_class TEXT NOT NULL
        CHECK (channel_class = 'whatsapp_business@1'),
    reason TEXT NOT NULL CHECK (reason IN
        ('alert_requires_attention','alert_action_requested',
         'customer_awareness_required')),
    payload_ref TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    visibility_requirement_id TEXT NULL,
    authority_snapshot JSONB NOT NULL,
    logical_action_id TEXT NOT NULL,
    created_by_principal_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, notification_intent_id),
    UNIQUE (tenant_id, logical_action_id),
    FOREIGN KEY (tenant_id, alert_id)
        REFERENCES alerting.alert(tenant_id, alert_id),
    CHECK (jsonb_typeof(authority_snapshot)='object')
);

-- Immutable attempt history — retry = new attempt, never rewrite.
CREATE TABLE notification.notification_attempt (
    tenant_id TEXT NOT NULL,
    notification_attempt_id TEXT NOT NULL,
    notification_intent_id TEXT NOT NULL,
    attempt_number BIGINT NOT NULL CHECK (attempt_number > 0),
    dispatch_evidence JSONB NOT NULL,
    adapter_version TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN
        ('dispatching','sent','provider_accepted','delivered',
         'failed','unknown')),
    provider_message_ref TEXT NULL,
    failure_class TEXT NULL,
    dispatch_identity TEXT NOT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    completed_at TIMESTAMPTZ NULL,
    PRIMARY KEY (tenant_id, notification_attempt_id),
    UNIQUE (tenant_id, dispatch_identity),
    FOREIGN KEY (tenant_id, notification_intent_id)
        REFERENCES notification.notification_intent
            (tenant_id, notification_intent_id),
    CHECK (jsonb_typeof(dispatch_evidence)='object')
);

-- Append-only normalized provider evidence.
CREATE TABLE notification.notification_provider_evidence (
    tenant_id TEXT NOT NULL,
    notification_evidence_id TEXT NOT NULL,
    notification_intent_id TEXT NOT NULL,
    notification_attempt_id TEXT NULL,
    normalized_state TEXT NOT NULL CHECK (normalized_state IN
        ('provider_accepted','delivered','external_read_observed',
         'failed','unknown')),
    provider_callback_id TEXT NULL,
    provider_message_ref TEXT NULL,
    raw_envelope JSONB NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, notification_evidence_id),
    FOREIGN KEY (tenant_id, notification_intent_id)
        REFERENCES notification.notification_intent
            (tenant_id, notification_intent_id),
    CHECK (jsonb_typeof(raw_envelope)='object')
);
CREATE UNIQUE INDEX notification_evidence_dedup
ON notification.notification_provider_evidence
    (tenant_id, provider_callback_id)
WHERE provider_callback_id IS NOT NULL;

-- Durable dispatch outbox — at-least-once, worker-owned.
CREATE TABLE notification.notification_dispatch_outbox (
    tenant_id TEXT NOT NULL,
    dispatch_id TEXT NOT NULL,
    notification_intent_id TEXT NOT NULL,
    logical_dispatch_id TEXT NOT NULL,
    attempt_number BIGINT NOT NULL CHECK (attempt_number > 0),
    state TEXT NOT NULL DEFAULT 'pending'
        CHECK (state IN ('pending','claimed','done','dead')),
    claim_token TEXT NULL,
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, dispatch_id),
    UNIQUE (tenant_id, logical_dispatch_id),
    FOREIGN KEY (tenant_id, notification_intent_id)
        REFERENCES notification.notification_intent
            (tenant_id, notification_intent_id)
);

-- Callback inbox — durable dedup + poison path before effects.
CREATE TABLE notification.notification_callback_inbox (
    tenant_id TEXT NOT NULL,
    callback_inbox_id TEXT NOT NULL,
    callback_digest TEXT NOT NULL,
    notification_intent_id TEXT NULL,
    provider_callback_id TEXT NULL,
    normalized_state TEXT NOT NULL DEFAULT 'unknown'
        CHECK (normalized_state IN
            ('provider_accepted','delivered','external_read_observed',
             'failed','unknown')),
    state TEXT NOT NULL DEFAULT 'received'
        CHECK (state IN ('received','processed','poisoned')),
    raw_envelope JSONB NOT NULL,
    last_error_class TEXT NULL,
    received_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    processed_at TIMESTAMPTZ NULL,
    PRIMARY KEY (tenant_id, callback_inbox_id),
    UNIQUE (tenant_id, callback_digest),
    CHECK (jsonb_typeof(raw_envelope)='object')
);

-- Derived delivery projection — recomputable from intent+attempt+
-- evidence; never authoritative for alert lifecycle.
CREATE TABLE notification.notification_projection (
    tenant_id TEXT NOT NULL,
    notification_intent_id TEXT NOT NULL,
    current_state TEXT NOT NULL CHECK (current_state IN
        ('dispatching','sent','provider_accepted','delivered',
         'external_read_observed','failed','unknown')),
    last_attempt_id TEXT NULL,
    last_evidence_id TEXT NULL,
    attempt_count BIGINT NOT NULL DEFAULT 0,
    delivered_at TIMESTAMPTZ NULL,
    external_read_observed_at TIMESTAMPTZ NULL,
    retry_required BOOLEAN NOT NULL DEFAULT FALSE,
    fallback_action_required BOOLEAN NOT NULL DEFAULT FALSE,
    projection_revision BIGINT NOT NULL CHECK (projection_revision>0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, notification_intent_id),
    FOREIGN KEY (tenant_id, notification_intent_id)
        REFERENCES notification.notification_intent
            (tenant_id, notification_intent_id)
);

ALTER TABLE notification.notification_intent
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_intent
    FORCE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_attempt
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_attempt
    FORCE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_provider_evidence
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_provider_evidence
    FORCE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_dispatch_outbox
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_dispatch_outbox
    FORCE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_callback_inbox
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_callback_inbox
    FORCE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_projection
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification.notification_projection
    FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'notification_intent','notification_attempt',
        'notification_provider_evidence',
        'notification_dispatch_outbox','notification_callback_inbox',
        'notification_projection']
    LOOP
        EXECUTE format(
            'CREATE POLICY g9_%I_tenant ON notification.%I
             USING (tenant_id=NULLIF(current_setting(
                 ''jlmirror.tenant_id'',true),''''))
             WITH CHECK (tenant_id=NULLIF(current_setting(
                 ''jlmirror.tenant_id'',true),''''))', t, t);
    END LOOP;
END $$;

GRANT USAGE ON SCHEMA notification TO jlmirror_app;
GRANT USAGE ON SCHEMA notification TO jlmirror_worker;
GRANT SELECT, INSERT, UPDATE ON
    notification.notification_intent,
    notification.notification_attempt,
    notification.notification_provider_evidence,
    notification.notification_dispatch_outbox,
    notification.notification_callback_inbox,
    notification.notification_projection
TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON
    notification.notification_attempt,
    notification.notification_provider_evidence,
    notification.notification_dispatch_outbox,
    notification.notification_callback_inbox,
    notification.notification_projection
TO jlmirror_worker;
GRANT SELECT ON notification.notification_intent TO jlmirror_worker;

COMMIT;
