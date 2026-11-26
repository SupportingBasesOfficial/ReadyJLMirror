-- G12 AIOps: lifecycle de predições (mitigated / occurred / false_positive)

BEGIN;

CREATE TABLE IF NOT EXISTS aiops.prediction_outcome (
    outcome_id    UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id     TEXT        NOT NULL,
    resource_id   TEXT        NOT NULL,
    metric_id     TEXT        NOT NULL,
    outcome       TEXT        NOT NULL
                             CHECK (outcome IN ('mitigated','occurred','false_positive')),
    note          TEXT        NOT NULL DEFAULT '',
    recorded_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    recorded_by   TEXT        NOT NULL DEFAULT 'system',
    UNIQUE (tenant_id, resource_id, metric_id)
);

CREATE INDEX IF NOT EXISTS pred_outcome_tenant
    ON aiops.prediction_outcome (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON aiops.prediction_outcome TO jlmirror_app;

COMMIT;
