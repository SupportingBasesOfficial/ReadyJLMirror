-- Performance indexes for alerting schema.
-- S2-A: inbox_receipt needs tenant_id in the index for multi-tenant selectivity.
--       The existing state-only index forces a full index scan per tenant.
-- S3-B: alert active-lifecycle index for dashboard / alert list queries.

CREATE INDEX IF NOT EXISTS inbox_receipt_state_tenant_idx
    ON alerting.inbox_receipt (tenant_id, state)
    WHERE state IN ('received', 'processing', 'reconciliation_required');

CREATE INDEX IF NOT EXISTS alert_active_tenant_idx
    ON alerting.alert (tenant_id, lifecycle_state)
    WHERE lifecycle_state = 'active';
