-- migration 063: auto-discovery de dispositivos — sessoes de scan e resultados

CREATE TABLE IF NOT EXISTS g1.discovery_session (
    session_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    tenant_id TEXT NOT NULL REFERENCES g1.tenants(tenant_id),
    name TEXT NOT NULL,
    description TEXT NULL,
    scan_type TEXT NOT NULL DEFAULT 'ping',
    -- target range
    cidr_ranges TEXT[] NOT NULL DEFAULT '{}',
    -- SNMP config
    snmp_community TEXT NOT NULL DEFAULT 'public',
    snmp_version TEXT NOT NULL DEFAULT 'v2c',
    snmp_port INT NOT NULL DEFAULT 161,
    snmp_timeout_ms INT NOT NULL DEFAULT 2000,
    snmp_retries INT NOT NULL DEFAULT 1,
    -- ports to probe
    probe_ports INT[] NOT NULL DEFAULT '{}',
    -- scan state
    status TEXT NOT NULL DEFAULT 'idle',
    last_scan_at TIMESTAMPTZ NULL,
    last_scan_duration_s INT NULL,
    discovered_count INT NOT NULL DEFAULT 0,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_by TEXT NOT NULL DEFAULT 'system',
    CONSTRAINT discovery_scan_type_check CHECK (scan_type IN ('ping', 'snmp', 'ping+snmp', 'port')),
    CONSTRAINT discovery_snmp_version_check CHECK (snmp_version IN ('v1', 'v2c', 'v3')),
    CONSTRAINT discovery_status_check CHECK (status IN ('idle', 'running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_discovery_session_tenant ON g1.discovery_session (tenant_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.discovery_session TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.discovery_scan_log (
    log_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES g1.discovery_session(session_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'running',
    triggered_by TEXT NOT NULL DEFAULT 'manual',
    cidr_ranges TEXT[] NOT NULL DEFAULT '{}',
    total_scanned INT NULL,
    new_devices INT NULL,
    updated_devices INT NULL,
    error_message TEXT NULL,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT discovery_scan_log_status_check CHECK (status IN ('running', 'completed', 'failed', 'cancelled'))
);

CREATE INDEX IF NOT EXISTS idx_discovery_scan_log_session ON g1.discovery_scan_log (session_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.discovery_scan_log TO jlmirror_app;

CREATE TABLE IF NOT EXISTS g1.discovery_result (
    result_id UUID NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
    session_id UUID NOT NULL REFERENCES g1.discovery_session(session_id) ON DELETE CASCADE,
    tenant_id TEXT NOT NULL,
    scan_log_id UUID NULL REFERENCES g1.discovery_scan_log(log_id) ON DELETE SET NULL,
    -- device info
    ip_address TEXT NOT NULL,
    mac_address TEXT NULL,
    hostname TEXT NULL,
    -- SNMP info
    sys_name TEXT NULL,
    sys_descr TEXT NULL,
    sys_object_id TEXT NULL,
    sys_location TEXT NULL,
    sys_contact TEXT NULL,
    -- Detection
    device_type TEXT NULL,
    os_hint TEXT NULL,
    open_ports INT[] NOT NULL DEFAULT '{}',
    snmp_reachable BOOLEAN NOT NULL DEFAULT FALSE,
    ping_rtt_ms FLOAT NULL,
    -- Status
    is_new BOOLEAN NOT NULL DEFAULT TRUE,
    imported_to_inventory BOOLEAN NOT NULL DEFAULT FALSE,
    first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, ip_address)
);

CREATE INDEX IF NOT EXISTS idx_discovery_result_session ON g1.discovery_result (session_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_discovery_result_tenant ON g1.discovery_result (tenant_id);
CREATE INDEX IF NOT EXISTS idx_discovery_result_ip ON g1.discovery_result (tenant_id, ip_address);

GRANT SELECT, INSERT, UPDATE, DELETE ON g1.discovery_result TO jlmirror_app;
