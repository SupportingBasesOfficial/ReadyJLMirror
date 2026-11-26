-- G-SecAudit: Security Audit — rules, scan, findings com remediation.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.security_rule (
    rule_id        UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id      TEXT        NOT NULL,
    name           TEXT        NOT NULL,
    description    TEXT        NOT NULL DEFAULT '',
    severity       TEXT        NOT NULL DEFAULT 'medium'
                               CHECK (severity IN ('critical','high','medium','low')),
    condition_type TEXT        NOT NULL DEFAULT 'manual'
                               CHECK (condition_type IN ('metric_threshold','manual')),
    condition_config JSONB     NOT NULL DEFAULT '{}',
    enabled        BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by     TEXT        NOT NULL DEFAULT 'system',
    UNIQUE (tenant_id, name)
);

CREATE INDEX IF NOT EXISTS sec_rule_tenant
    ON g1.security_rule (tenant_id)
    WHERE enabled = TRUE;

CREATE TABLE IF NOT EXISTS g1.security_finding (
    finding_id     UUID        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id      TEXT        NOT NULL,
    rule_id        UUID        NOT NULL REFERENCES g1.security_rule (rule_id)
                               ON DELETE CASCADE,
    resource_ref   TEXT,
    status         TEXT        NOT NULL DEFAULT 'open'
                               CHECK (status IN ('open','resolved','false_positive')),
    detail         TEXT        NOT NULL DEFAULT '',
    remediation    TEXT,
    found_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS sec_finding_tenant_status
    ON g1.security_finding (tenant_id, status);

CREATE INDEX IF NOT EXISTS sec_finding_rule
    ON g1.security_finding (rule_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.security_rule    TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.security_finding TO jlmirror_app;

COMMIT;
