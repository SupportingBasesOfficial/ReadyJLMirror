-- Migration 037: Helpdesk ticket system (G40).
-- Separate from G10 ITSM (change management / incidents).
-- Helpdesk = client-facing support: categories, SLA, comments, internal notes.

BEGIN;

CREATE TABLE IF NOT EXISTS g1.helpdesk_category (
    category_id     TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name            TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    response_secs   INTEGER,            -- SLA: first response target
    resolve_secs    INTEGER,            -- SLA: resolution target
    enabled         BOOLEAN NOT NULL DEFAULT true,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.helpdesk_ticket (
    ticket_id       TEXT PRIMARY KEY,
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    category_id     TEXT REFERENCES g1.helpdesk_category(category_id),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    priority        TEXT NOT NULL DEFAULT 'medium'
                        CHECK (priority IN ('low', 'medium', 'high', 'critical')),
    status          TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'in_progress', 'waiting', 'resolved', 'closed')),
    requester_id    TEXT,               -- principal_id of the person who opened the ticket
    assignee_id     TEXT,               -- principal_id of the assigned technician
    response_sla_deadline_at  TIMESTAMPTZ,
    resolve_sla_deadline_at   TIMESTAMPTZ,
    first_response_at         TIMESTAMPTZ,
    resolved_at     TIMESTAMPTZ,
    closed_at       TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.helpdesk_comment (
    comment_id      TEXT PRIMARY KEY,
    ticket_id       TEXT NOT NULL REFERENCES g1.helpdesk_ticket(ticket_id) ON DELETE CASCADE,
    tenant_id       TEXT NOT NULL,
    author_id       TEXT NOT NULL,
    body            TEXT NOT NULL,
    is_internal     BOOLEAN NOT NULL DEFAULT false,  -- internal notes vs public comments
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for the most common access patterns
CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_tenant_status
    ON g1.helpdesk_ticket (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_helpdesk_ticket_assignee
    ON g1.helpdesk_ticket (tenant_id, assignee_id)
    WHERE assignee_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_helpdesk_comment_ticket
    ON g1.helpdesk_comment (ticket_id, created_at);

-- Grants
GRANT SELECT, INSERT, UPDATE ON g1.helpdesk_category TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.helpdesk_ticket TO jlmirror_app;
GRANT SELECT, INSERT ON g1.helpdesk_comment TO jlmirror_app;

COMMIT;
