-- Performance indexes for alerting schema.
-- S3-B: alert active-lifecycle index for dashboard / alert list queries.
-- NOTE: inbox_receipt_state_tenant_idx lives in z_integration/002_alerting_consumer.sql
--       because inbox_receipt is created there (lexical order dependency).

CREATE INDEX IF NOT EXISTS alert_active_tenant_idx
    ON alerting.alert (tenant_id, lifecycle_state)
    WHERE lifecycle_state = 'active';
