-- G12 AIOps — advisory findings schema.
-- INVARIANT: findings are advisory only. ALERT ≠ AIOPS FINDING.

BEGIN;

CREATE SCHEMA IF NOT EXISTS aiops;

-- One record per analysis run (tenant × time).
CREATE TABLE IF NOT EXISTS aiops.analysis_run (
    run_id                  TEXT        PRIMARY KEY,
    tenant_id               TEXT        NOT NULL,
    run_at                  TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    evidence_window_start   TIMESTAMPTZ,
    evidence_window_end     TIMESTAMPTZ,
    evidence_alert_count    INT         NOT NULL DEFAULT 0,
    findings_count          INT         NOT NULL DEFAULT 0,
    model_id                TEXT        NOT NULL,
    status                  TEXT        NOT NULL DEFAULT 'completed',
    error_detail            TEXT,
    CONSTRAINT analysis_run_status_check
        CHECK (status IN ('completed', 'failed', 'partial'))
);

CREATE INDEX IF NOT EXISTS idx_analysis_run_tenant
    ON aiops.analysis_run (tenant_id, run_at DESC);

-- Advisory findings emitted by the analysis worker.
-- expires_at: 7-day TTL — stale findings are excluded by the API.
-- dismissed_at: operator dismissal — excluded from active reads.
CREATE TABLE IF NOT EXISTS aiops.finding (
    tenant_id               TEXT        NOT NULL,
    finding_id              TEXT        NOT NULL,
    analysis_run_id         TEXT        NOT NULL
        REFERENCES aiops.analysis_run (run_id),
    finding_type            TEXT        NOT NULL,
    severity_hint           TEXT        NOT NULL DEFAULT 'medium',
    title                   TEXT        NOT NULL,
    explanation             TEXT        NOT NULL,
    evidence_refs           JSONB       NOT NULL DEFAULT '[]',
    confidence              NUMERIC(4,3),
    model_id                TEXT        NOT NULL,
    expires_at              TIMESTAMPTZ NOT NULL,
    dismissed_at            TIMESTAMPTZ,
    created_at              TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, finding_id),
    CONSTRAINT finding_type_check
        CHECK (finding_type IN ('anomaly', 'correlation', 'root_cause', 'prediction')),
    CONSTRAINT finding_severity_hint_check
        CHECK (severity_hint IN ('low', 'medium', 'high')),
    CONSTRAINT finding_confidence_check
        CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1))
);

CREATE INDEX IF NOT EXISTS idx_finding_tenant_created
    ON aiops.finding (tenant_id, created_at DESC)
    WHERE dismissed_at IS NULL;

-- RLS on finding: jlmirror_app reads only its own tenant's findings.
-- jlmirror_worker has BYPASSRLS so it can write cross-tenant.
ALTER TABLE aiops.finding ENABLE ROW LEVEL SECURITY;
ALTER TABLE aiops.finding FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS finding_tenant_policy ON aiops.finding;
CREATE POLICY finding_tenant_policy ON aiops.finding
    USING (
        tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), '')
        OR current_user IN ('jlmirror_owner', 'jlmirror_worker')
    )
    WITH CHECK (
        tenant_id = NULLIF(current_setting('jlmirror.tenant_id', true), '')
        OR current_user IN ('jlmirror_owner', 'jlmirror_worker')
    );

COMMIT;
