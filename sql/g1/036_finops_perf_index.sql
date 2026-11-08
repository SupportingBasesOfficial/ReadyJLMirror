-- Migration 036: performance index for FinOps usage_meters queries.
-- Queries in finops.py filter by tenant_id and window_end (time range scans).
-- Without this index, every FinOps query was a full sequential scan.

BEGIN;

CREATE INDEX IF NOT EXISTS idx_usage_meters_tenant_window
    ON g1.usage_meters (tenant_id, window_end DESC);

CREATE INDEX IF NOT EXISTS idx_usage_meters_window_end
    ON g1.usage_meters (window_end DESC);

COMMIT;
