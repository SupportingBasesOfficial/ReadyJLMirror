-- G13 Phase 3: Quota enforcement audit log
-- Records every quota.exceeded event with tenant, key, counts and limit.
-- The g1.audit_event also captures these (action='quota.exceeded'),
-- but this table gives a fast time-series read without jsonb parsing.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.quota_events (
    quota_event_id   TEXT         PRIMARY KEY,
    tenant_id        TEXT         NOT NULL
                                  REFERENCES g1.tenants (tenant_id),
    quota_key        TEXT         NOT NULL,
    current_count    INTEGER      NOT NULL,
    quota_limit      INTEGER      NOT NULL,
    notified_at      TIMESTAMPTZ,            -- set by bg task after contacts fetched
    created_at       TIMESTAMPTZ  NOT NULL
                                  DEFAULT transaction_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_quota_events_tenant_ts
    ON g1.quota_events (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE ON g1.quota_events TO jlmirror_owner;
GRANT SELECT, INSERT, UPDATE ON g1.quota_events TO jlmirror_app;

COMMIT;
