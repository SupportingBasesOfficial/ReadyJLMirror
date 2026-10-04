-- Performance indexes for monitoring schema.
-- S2-B: active problem lookup by resource (alert dashboard, problem list).
--       Without this, queries filter active problems by scanning all problems.

CREATE INDEX IF NOT EXISTS idx_problem_active_by_resource
    ON monitoring.monitoring_problem (tenant_id, monitoring_resource_id)
    WHERE problem_state = 'active';
