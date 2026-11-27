-- G13-adjacent: Marketplace of integrations
-- marketplace_integration: global catalog (managed by JL)
-- tenant_integration: per-tenant installations

CREATE TABLE g1.marketplace_integration (
    integration_id  TEXT        PRIMARY KEY,  -- e.g. "int:slack", "int:pagerduty"
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    category        TEXT        NOT NULL DEFAULT 'other' CHECK (category IN (
                        'monitoring', 'alerting', 'itsm', 'chatops',
                        'security', 'automation', 'storage', 'other')),
    icon_emoji      TEXT        NOT NULL DEFAULT '🔌',
    vendor          TEXT        NOT NULL DEFAULT '',
    website_url     TEXT,
    config_schema   JSONB       NOT NULL DEFAULT '{}',
    is_enabled      BOOLEAN     NOT NULL DEFAULT TRUE,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE g1.tenant_integration (
    id              BIGSERIAL   PRIMARY KEY,
    tenant_id       TEXT        NOT NULL REFERENCES g1.tenants(tenant_id) ON DELETE CASCADE,
    integration_id  TEXT        NOT NULL REFERENCES g1.marketplace_integration(integration_id),
    config          JSONB       NOT NULL DEFAULT '{}',
    state           TEXT        NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'inactive', 'error')),
    error_detail    TEXT,
    installed_by    TEXT        NOT NULL,
    installed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, integration_id)
);

CREATE INDEX ON g1.tenant_integration (tenant_id);
CREATE INDEX ON g1.tenant_integration (integration_id);

GRANT SELECT ON g1.marketplace_integration TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON g1.tenant_integration TO jlmirror_app;
GRANT USAGE, SELECT ON SEQUENCE g1.tenant_integration_id_seq TO jlmirror_app;

-- Seed catalog with common integrations
INSERT INTO g1.marketplace_integration (integration_id, name, description, category, icon_emoji, vendor, website_url) VALUES
    ('int:slack',       'Slack',           'Send alerts and notifications to Slack channels.',           'chatops',    '💬', 'Salesforce',   'https://slack.com'),
    ('int:teams',       'Microsoft Teams', 'Send alerts and notifications to Teams channels.',           'chatops',    '🟦', 'Microsoft',    'https://teams.microsoft.com'),
    ('int:pagerduty',   'PagerDuty',       'Route critical alerts to on-call engineers via PagerDuty.', 'alerting',   '🔔', 'PagerDuty',    'https://pagerduty.com'),
    ('int:opsgenie',    'Opsgenie',        'Atlassian on-call and alert routing platform.',              'alerting',   '🚨', 'Atlassian',    'https://atlassian.com/software/opsgenie'),
    ('int:jira',        'Jira',            'Create Jira issues from incidents automatically.',           'itsm',       '🗂️', 'Atlassian',    'https://atlassian.com/software/jira'),
    ('int:servicenow',  'ServiceNow',      'Sync incidents and changes with ServiceNow ITSM.',          'itsm',       '🏢', 'ServiceNow',   'https://servicenow.com'),
    ('int:grafana',     'Grafana',         'Embed Grafana dashboards and sync alert states.',            'monitoring', '📊', 'Grafana Labs', 'https://grafana.com'),
    ('int:prometheus',  'Prometheus',      'Ingest Prometheus metrics and alerts via remote-write.',     'monitoring', '🔥', 'CNCF',         'https://prometheus.io'),
    ('int:s3',          'Amazon S3',       'Store backup snapshots and exports in S3-compatible storage.','storage',  '🪣', 'Amazon',       'https://aws.amazon.com/s3'),
    ('int:telegram',    'Telegram Bot',    'Send alert notifications via a Telegram bot.',               'chatops',    '✈️', 'Telegram',     'https://telegram.org'),
    ('int:webhook',     'Generic Webhook', 'Send events to any HTTP endpoint with HMAC signing.',        'automation', '🔗', 'Open',         NULL),
    ('int:ansible',     'Ansible AWX',     'Trigger Ansible playbooks from automation rules.',           'automation', '⚙️', 'Red Hat',      'https://ansible.com')
ON CONFLICT DO NOTHING;
