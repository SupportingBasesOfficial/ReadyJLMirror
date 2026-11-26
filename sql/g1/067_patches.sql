-- 067_patches.sql

CREATE TABLE g1.patch_scan (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    target_host     TEXT NOT NULL,
    target_type     TEXT NOT NULL DEFAULT 'host'
                        CHECK (target_type IN ('host', 'device_group', 'all')),
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed', 'failed')),
    patch_count     INT,
    critical_count  INT,
    error_message   TEXT,
    initiated_by    UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE TABLE g1.patch (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    scan_id             UUID REFERENCES g1.patch_scan(id) ON DELETE SET NULL,
    target_host         TEXT NOT NULL,
    package_name        TEXT NOT NULL,
    current_version     TEXT,
    available_version   TEXT NOT NULL,
    severity            TEXT NOT NULL DEFAULT 'medium'
                            CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
    category            TEXT,
    cve_ids             TEXT[] NOT NULL DEFAULT '{}',
    description         TEXT,
    requires_reboot     BOOLEAN NOT NULL DEFAULT false,
    status              TEXT NOT NULL DEFAULT 'available'
                            CHECK (status IN ('available', 'approved', 'rejected', 'installing', 'installed', 'failed', 'skipped')),
    approved_by         UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    approved_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE g1.patch_job (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       UUID NOT NULL REFERENCES g1.tenant(id) ON DELETE CASCADE,
    target_host     TEXT NOT NULL,
    patch_ids       UUID[] NOT NULL DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    scheduled_at    TIMESTAMPTZ,
    allow_reboot    BOOLEAN NOT NULL DEFAULT false,
    output          TEXT,
    error_message   TEXT,
    installed_count INT,
    failed_count    INT,
    created_by      UUID REFERENCES g1.user_account(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    started_at      TIMESTAMPTZ,
    completed_at    TIMESTAMPTZ
);

CREATE INDEX ON g1.patch_scan (tenant_id, created_at DESC);
CREATE INDEX ON g1.patch_scan (tenant_id, status);
CREATE INDEX ON g1.patch (tenant_id, status);
CREATE INDEX ON g1.patch (tenant_id, severity);
CREATE INDEX ON g1.patch (tenant_id, target_host);
CREATE INDEX ON g1.patch (scan_id);
CREATE INDEX ON g1.patch_job (tenant_id, created_at DESC);
CREATE INDEX ON g1.patch_job (tenant_id, status);
