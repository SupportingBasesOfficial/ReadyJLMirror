-- G9 provider-callback routing index — production hardening.
--
-- The provider callback carries only the provider's message ref; it
-- cannot assert a tenant (payload is untrusted) and no single env
-- tenant is correct in a multi-tenant deployment. This index maps
-- the provider ref to (tenant, intent) at dispatch-complete time.
-- It is deliberately NOT tenant-RLS'd: it is global routing
-- metadata, and the refs are opaque provider identifiers.
BEGIN;

CREATE TABLE notification.provider_ref_binding (
    provider_message_ref TEXT NOT NULL PRIMARY KEY,
    tenant_id TEXT NOT NULL,
    notification_intent_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    FOREIGN KEY (tenant_id, notification_intent_id)
        REFERENCES notification.notification_intent
            (tenant_id, notification_intent_id),
    CHECK (provider_message_ref <> '' AND tenant_id <> '')
);

-- Backfill: attempts that already recorded a provider ref.
INSERT INTO notification.provider_ref_binding
    (provider_message_ref, tenant_id, notification_intent_id)
SELECT DISTINCT ON (provider_message_ref)
    provider_message_ref, tenant_id, notification_intent_id
  FROM notification.notification_attempt
 WHERE provider_message_ref IS NOT NULL
 ORDER BY provider_message_ref, attempt_number DESC
ON CONFLICT DO NOTHING;

-- The callback reader (app) resolves the route; the dispatcher
-- (worker) writes bindings at attempt completion.
GRANT SELECT ON notification.provider_ref_binding TO jlmirror_app;
GRANT INSERT ON notification.provider_ref_binding TO jlmirror_worker;

COMMIT;
