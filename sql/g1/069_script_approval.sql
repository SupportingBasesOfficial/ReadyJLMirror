-- migration 069: approval flow + version history for automation scripts

ALTER TABLE g1.automation_script
    ADD COLUMN IF NOT EXISTS approval_required BOOLEAN     NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS approval_status   TEXT        NOT NULL DEFAULT 'draft'
        CHECK (approval_status IN ('draft', 'pending_approval', 'approved', 'rejected')),
    ADD COLUMN IF NOT EXISTS approved_by       TEXT,
    ADD COLUMN IF NOT EXISTS approved_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS rejection_reason  TEXT;

CREATE INDEX IF NOT EXISTS automation_script_approval_idx
    ON g1.automation_script (tenant_id, approval_status)
    WHERE approval_required = true;

CREATE TABLE IF NOT EXISTS g1.automation_script_version (
    id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    script_id      TEXT         NOT NULL REFERENCES g1.automation_script(script_id) ON DELETE CASCADE,
    tenant_id      TEXT         NOT NULL,
    version_number INT          NOT NULL,
    name           TEXT         NOT NULL,
    script_type    TEXT         NOT NULL,
    config         JSONB        NOT NULL,
    description    TEXT         NOT NULL DEFAULT '',
    change_note    TEXT,
    created_by     TEXT,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    UNIQUE (script_id, version_number)
);

CREATE INDEX IF NOT EXISTS automation_script_version_script_idx
    ON g1.automation_script_version (script_id, version_number DESC);
