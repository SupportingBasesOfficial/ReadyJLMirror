-- 066_chatops.sql

CREATE TABLE g1.chatops_workspace (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    name                TEXT NOT NULL,
    platform            TEXT NOT NULL CHECK (platform IN ('slack', 'teams')),
    webhook_url         TEXT,
    bot_token_ref       TEXT,
    inbound_secret      TEXT,
    status              TEXT NOT NULL DEFAULT 'inactive'
                            CHECK (status IN ('active', 'inactive', 'error')),
    error_message       TEXT,
    last_ping_at        TIMESTAMPTZ,
    created_by          UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE g1.chatops_channel_binding (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    workspace_id    UUID NOT NULL REFERENCES g1.chatops_workspace(id) ON DELETE CASCADE,
    channel_id      TEXT NOT NULL,
    channel_name    TEXT,
    entity_type     TEXT NOT NULL,
    event_types     TEXT[] NOT NULL DEFAULT '{}',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (workspace_id, channel_id, entity_type)
);

CREATE TABLE g1.chatops_outbound_message (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    workspace_id    UUID REFERENCES g1.chatops_workspace(id) ON DELETE SET NULL,
    channel_id      TEXT NOT NULL,
    entity_type     TEXT,
    entity_id       UUID,
    event_type      TEXT,
    payload         JSONB NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'sent', 'failed')),
    error_message   TEXT,
    sent_at         TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE g1.chatops_command_log (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    workspace_id    UUID REFERENCES g1.chatops_workspace(id) ON DELETE SET NULL,
    platform        TEXT NOT NULL,
    channel_id      TEXT,
    sender_id       TEXT,
    sender_name     TEXT,
    command         TEXT NOT NULL,
    args            TEXT,
    response        TEXT,
    status          TEXT NOT NULL DEFAULT 'ok'
                        CHECK (status IN ('ok', 'error', 'ignored')),
    received_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON g1.chatops_workspace (tenant_id);
CREATE INDEX ON g1.chatops_channel_binding (workspace_id);
CREATE INDEX ON g1.chatops_channel_binding (tenant_id, entity_type);
CREATE INDEX ON g1.chatops_outbound_message (tenant_id, created_at DESC);
CREATE INDEX ON g1.chatops_command_log (tenant_id, received_at DESC);
