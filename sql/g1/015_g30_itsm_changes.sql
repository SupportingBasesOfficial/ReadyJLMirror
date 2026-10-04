-- G30 ITSM Change Management
-- RFC (Request for Change), change tasks, and approval records.
-- Tenant isolation via tenant-scoped connection (no RLS needed).

CREATE TABLE IF NOT EXISTS g1.change_request (
    rfc_id          TEXT PRIMARY KEY,           -- 'rfc:<uuid>'
    tenant_id       TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    title           TEXT NOT NULL,
    description     TEXT NOT NULL DEFAULT '',
    category        TEXT NOT NULL DEFAULT 'normal'
                        CHECK (category IN ('standard', 'normal', 'emergency')),
    risk            TEXT NOT NULL DEFAULT 'medium'
                        CHECK (risk IN ('low', 'medium', 'high', 'critical')),
    state           TEXT NOT NULL DEFAULT 'draft'
                        CHECK (state IN ('draft', 'review', 'approved',
                                         'scheduled', 'implementing',
                                         'complete', 'cancelled')),
    planned_start   TIMESTAMPTZ,
    planned_end     TIMESTAMPTZ,
    incident_id     TEXT,
    created_by      TEXT NOT NULL,              -- principal_id
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.change_task (
    task_id         TEXT PRIMARY KEY,           -- 'ctask:<uuid>'
    rfc_id          TEXT NOT NULL REFERENCES g1.change_request(rfc_id),
    tenant_id       TEXT NOT NULL,
    title           TEXT NOT NULL,
    assignee_ref    TEXT,                       -- principal_id or free text
    state           TEXT NOT NULL DEFAULT 'open'
                        CHECK (state IN ('open', 'in_progress', 'done', 'skipped')),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS g1.change_approval (
    approval_id     TEXT PRIMARY KEY,           -- 'capproval:<uuid>'
    rfc_id          TEXT NOT NULL REFERENCES g1.change_request(rfc_id),
    tenant_id       TEXT NOT NULL,
    approver_ref    TEXT NOT NULL,              -- principal_id or display name
    decision        TEXT NOT NULL DEFAULT 'pending'
                        CHECK (decision IN ('pending', 'approved', 'rejected')),
    notes           TEXT,
    decided_at      TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes for common queries
CREATE INDEX IF NOT EXISTS idx_change_request_tenant
    ON g1.change_request (tenant_id, state, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_change_task_rfc
    ON g1.change_task (rfc_id);
CREATE INDEX IF NOT EXISTS idx_change_approval_rfc
    ON g1.change_approval (rfc_id);

-- Grants
GRANT SELECT, INSERT, UPDATE ON g1.change_request  TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.change_task     TO jlmirror_app;
GRANT SELECT, INSERT, UPDATE ON g1.change_approval TO jlmirror_app;

GRANT SELECT ON g1.change_request  TO jlmirror_owner;
GRANT SELECT ON g1.change_task     TO jlmirror_owner;
GRANT SELECT ON g1.change_approval TO jlmirror_owner;
