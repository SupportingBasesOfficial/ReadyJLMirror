-- migration 061: kubernetes clusters, cache de recursos e historico de sync

CREATE TABLE IF NOT EXISTS g1.k8s_cluster (
    cluster_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name TEXT NOT NULL,
    description TEXT NULL,
    api_server TEXT NOT NULL,
    kubeconfig_ref TEXT NULL,
    credential_ref TEXT NULL,
    default_namespace TEXT NOT NULL DEFAULT 'default',
    tls_verify BOOLEAN NOT NULL DEFAULT TRUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL DEFAULT 'system'
);

CREATE INDEX IF NOT EXISTS idx_k8s_cluster_tenant ON g1.k8s_cluster (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.k8s_cluster TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.k8s_resource (
    resource_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    cluster_id UUID NOT NULL REFERENCES g1.k8s_cluster(cluster_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    api_version TEXT NOT NULL DEFAULT 'v1',
    name TEXT NOT NULL,
    namespace TEXT NULL,
    labels JSONB NOT NULL DEFAULT '{}',
    phase TEXT NULL,
    ready TEXT NULL,
    status_summary TEXT NULL,
    spec_summary JSONB NOT NULL DEFAULT '{}',
    last_synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cluster_id, kind, name, namespace)
);

CREATE INDEX IF NOT EXISTS idx_k8s_resource_cluster ON g1.k8s_resource (cluster_id, kind, namespace);
CREATE INDEX IF NOT EXISTS idx_k8s_resource_tenant ON g1.k8s_resource (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.k8s_resource TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.k8s_sync_log (
    sync_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    cluster_id UUID NOT NULL REFERENCES g1.k8s_cluster(cluster_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    triggered_by TEXT NOT NULL DEFAULT 'manual',
    resource_count INT NULL,
    kinds_synced TEXT[] NULL,
    error_message TEXT NULL,
    started_at TIMESTAMPTZ NULL,
    finished_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT k8s_sync_status_check CHECK (status IN ('pending', 'running', 'success', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_k8s_sync_cluster ON g1.k8s_sync_log (cluster_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.k8s_sync_log TO jlmirror_app;
