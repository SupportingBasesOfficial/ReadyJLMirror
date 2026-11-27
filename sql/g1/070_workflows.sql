-- migration 070: workflows — sequenced steps with approval gates + clone entre tenants

CREATE TABLE g1.workflow (
    id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID        NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    name            TEXT        NOT NULL,
    description     TEXT        NOT NULL DEFAULT '',
    status          TEXT        NOT NULL DEFAULT 'active'
                                CHECK (status IN ('active', 'archived')),
    cloned_from     UUID        REFERENCES g1.workflow(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON g1.workflow (tenant_id, status);

CREATE TABLE g1.workflow_step (
    id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id       UUID        NOT NULL REFERENCES g1.workflow(id) ON DELETE CASCADE,
    tenant_id         UUID        NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    position          INT         NOT NULL,
    name              TEXT        NOT NULL,
    description       TEXT        NOT NULL DEFAULT '',
    step_type         TEXT        NOT NULL DEFAULT 'manual'
                                  CHECK (step_type IN ('manual', 'noop', 'webhook')),
    config            JSONB       NOT NULL DEFAULT '{}',
    approval_required BOOLEAN     NOT NULL DEFAULT false,
    UNIQUE (workflow_id, position)
);

CREATE INDEX ON g1.workflow_step (workflow_id, position);

CREATE TABLE g1.workflow_run (
    id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_id           UUID        NOT NULL REFERENCES g1.workflow(id) ON DELETE CASCADE,
    tenant_id             UUID        NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    status                TEXT        NOT NULL DEFAULT 'running'
                                      CHECK (status IN ('running', 'waiting_approval', 'completed', 'failed', 'cancelled')),
    current_step_position INT,
    triggered_by          UUID        REFERENCES g1.user_account(id) ON DELETE SET NULL,
    started_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    finished_at           TIMESTAMPTZ,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON g1.workflow_run (tenant_id, status);
CREATE INDEX ON g1.workflow_run (workflow_id, created_at DESC);

CREATE TABLE g1.workflow_step_run (
    id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    run_id           UUID        NOT NULL REFERENCES g1.workflow_run(id) ON DELETE CASCADE,
    step_id          UUID        NOT NULL REFERENCES g1.workflow_step(id) ON DELETE CASCADE,
    tenant_id        UUID        NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    position         INT         NOT NULL,
    status           TEXT        NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending', 'running', 'waiting_approval', 'approved', 'completed', 'rejected', 'failed')),
    approved_by      UUID        REFERENCES g1.user_account(id) ON DELETE SET NULL,
    approved_at      TIMESTAMPTZ,
    rejection_reason TEXT,
    output           TEXT,
    started_at       TIMESTAMPTZ,
    finished_at      TIMESTAMPTZ,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX ON g1.workflow_step_run (run_id, position);
CREATE INDEX ON g1.workflow_step_run (tenant_id, status);
