export type SessionState =
  | "unauthenticated"
  | "forbidden"
  | "needs_tenant"
  | "ready"
  | "unavailable";

export interface Session {
  state: SessionState;
  principal_id?: string;
  tenant_id?: string;
  display_name?: string;
  email?: string;
  permissions?: string[];
  memberships?: Tenant[];
  environment?: string;
}

export interface Tenant {
  tenant_id: string;
  display_name?: string;
  role?: string;
}

export interface MonitoringSource {
  source_id: string;
  display_name: string;
  provider: string;
  state: string;
  host_count?: number;
  last_synced_at?: string;
  created_at?: string;
}

export interface Resource {
  resource_id: string;
  display_name: string;
  source_id?: string;
  resource_type?: string;
  health_state: string;
  problem_count?: number;
  last_seen_at?: string;
}

export interface Alert {
  alert_id: string;
  severity: string;
  title: string;
  state: string;
  ack_state?: string;
  source_id?: string;
  resource_id?: string;
  resource_name?: string;
  opened_at: string;
  resolved_at?: string;
  policy_name?: string;
  itsm_ticket_ref?: string;
}

export interface AlertDetail extends Alert {
  description?: string;
  problem_event_ids?: string[];
  ack_history?: AckEntry[];
}

export interface AckEntry {
  ack_id: string;
  action: string;
  principal_id: string;
  note?: string;
  at: string;
}

export interface HealthStat {
  healthy: number;
  degraded: number;
  unhealthy: number;
  unknown: number;
}
