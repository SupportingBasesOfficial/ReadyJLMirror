-- migration 059: backup jobs e snapshots

CREATE TABLE IF NOT EXISTS g1.backup_job (
    job_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name TEXT NOT NULL,
    description TEXT NULL,
    schedule_cron TEXT NULL,
    target_type TEXT NOT NULL DEFAULT 'local',
    target_path TEXT NOT NULL DEFAULT '',
    target_config JSONB NOT NULL DEFAULT '{}',
    pre_commands TEXT[] NOT NULL DEFAULT '{}',
    post_commands TEXT[] NOT NULL DEFAULT '{}',
    retention_days INT NOT NULL DEFAULT 30,
    max_snapshots INT NOT NULL DEFAULT 10,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL DEFAULT 'system',
    CONSTRAINT backup_target_type_check CHECK (target_type IN ('local', 's3', 'sftp', 'nfs', 'rsync'))
);

CREATE INDEX IF NOT EXISTS idx_backup_job_tenant ON g1.backup_job (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.backup_job TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.backup_snapshot (
    snapshot_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    job_id UUID NOT NULL REFERENCES g1.backup_job(job_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    triggered_by TEXT NOT NULL DEFAULT 'schedule',
    started_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL,
    size_bytes BIGINT NULL,
    checksum_sha256 TEXT NULL,
    snapshot_path TEXT NULL,
    output TEXT NULL,
    error_message TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT backup_snapshot_status_check CHECK (status IN ('pending', 'running', 'success', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_backup_snapshot_job ON g1.backup_snapshot (job_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_backup_snapshot_tenant ON g1.backup_snapshot (tenant_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.backup_snapshot TO jlmirror_app;
