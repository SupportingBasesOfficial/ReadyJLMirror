import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { AlertTriangle, CheckCircle, Users, Ticket, Bell } from "lucide-react";

interface TenantRow {
  tenant_id: string;
  display_name: string;
  org_display_name?: string;
  state: string;
  active_alerts: number;
  critical_alerts: number;
  degraded_alerts: number;
  open_incidents: number;
  in_progress_incidents: number;
}

interface MspOverview {
  tenants: TenantRow[];
  totals: {
    tenant_count: number;
    active_alerts: number;
    critical_alerts: number;
    open_incidents: number;
    in_progress_incidents: number;
  };
}

function healthVariant(row: TenantRow): "danger" | "warning" | "success" | "muted" {
  if (row.critical_alerts > 0) return "danger";
  if (row.degraded_alerts > 0 || row.active_alerts > 0) return "warning";
  if (row.open_incidents > 0 || row.in_progress_incidents > 0) return "warning";
  return "success";
}

function healthLabel(row: TenantRow): string {
  if (row.critical_alerts > 0) return "Crítico";
  if (row.active_alerts > 0) return "Alerta";
  if (row.open_incidents > 0) return "Incidente";
  return "OK";
}

function HealthDot({ row }: { row: TenantRow }) {
  const v = healthVariant(row);
  const colors: Record<string, string> = {
    danger: "bg-[var(--red)]",
    warning: "bg-[var(--yellow,#f59e0b)]",
    success: "bg-[var(--green,#22c55e)]",
    muted: "bg-[var(--text-muted)]",
  };
  const pulse = v === "danger" ? "animate-pulse" : "";
  return (
    <span className={`inline-block w-2.5 h-2.5 rounded-full flex-shrink-0 ${colors[v]} ${pulse}`} />
  );
}

function StatTile({
  label, value, sub, variant,
}: {
  label: string; value: number; sub?: string; variant?: "danger" | "warning" | "muted";
}) {
  const colors: Record<string, string> = {
    danger: "text-[var(--red)]",
    warning: "text-[var(--yellow,#f59e0b)]",
    muted: "text-[var(--text-muted)]",
  };
  return (
    <div className="flex flex-col gap-0.5 px-4 py-3 border border-[var(--border)] rounded-xl bg-[var(--surface)]">
      <span className={`text-2xl font-bold tabular-nums ${variant ? colors[variant] : "text-[var(--text)]"}`}>
        {value}
      </span>
      <span className="text-xs text-[var(--text-muted)]">{label}</span>
      {sub && <span className="text-[10px] text-[var(--text-muted)]">{sub}</span>}
    </div>
  );
}

export function MSPOverviewPage({ tenantId: _tenantId, onSelectTenant }: {
  tenantId?: string;
  onSelectTenant?: (tenantId: string) => void;
}) {
  const q = useQuery({
    queryKey: ["msp-overview"],
    queryFn: () => api.get<MspOverview>("/api/v1/msp/overview"),
    refetchInterval: 30_000,
  });

  if (q.isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }

  if (q.isError) {
    return (
      <p className="text-xs text-[var(--red)] py-8 text-center">
        Falha ao carregar visão MSP.
      </p>
    );
  }

  const data = q.data!;
  const { totals, tenants } = data;

  return (
    <div className="space-y-5">
      {/* Header */}
      <div>
        <h1 className="text-base font-semibold">Visão MSP — Clientes</h1>
        <p className="text-xs text-[var(--text-muted)]">
          Resumo agregado de todos os tenants sob gestão
        </p>
      </div>

      {/* Summary tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatTile label="Clientes" value={totals.tenant_count} />
        <StatTile
          label="Alertas ativos"
          value={totals.active_alerts}
          sub={`${totals.critical_alerts} críticos`}
          variant={totals.critical_alerts > 0 ? "danger" : totals.active_alerts > 0 ? "warning" : undefined}
        />
        <StatTile
          label="Incidentes abertos"
          value={totals.open_incidents}
          variant={totals.open_incidents > 0 ? "warning" : undefined}
        />
        <StatTile
          label="Em andamento"
          value={totals.in_progress_incidents}
          variant={totals.in_progress_incidents > 0 ? "muted" : undefined}
        />
      </div>

      {/* Tenant list */}
      {tenants.length === 0 ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] px-4 py-8 text-center">
            Nenhum cliente MSP configurado. Crie relacionamentos MSP em Plataforma → MSP / Grants.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {tenants.map(t => (
            <button
              key={t.tenant_id}
              onClick={() => onSelectTenant?.(t.tenant_id)}
              className="w-full text-left bg-[var(--surface)] border border-[var(--border)] rounded-xl px-4 py-3 hover:border-[var(--brand)] transition-colors group"
            >
              <div className="flex items-center gap-3">
                <HealthDot row={t} />

                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{t.display_name}</p>
                  {t.org_display_name && (
                    <p className="text-xs text-[var(--text-muted)] truncate">{t.org_display_name}</p>
                  )}
                </div>

                <div className="flex items-center gap-3 flex-shrink-0">
                  {/* Alerts */}
                  {t.active_alerts > 0 && (
                    <span className="flex items-center gap-1 text-xs">
                      <Bell className={`w-3.5 h-3.5 ${t.critical_alerts > 0 ? "text-[var(--red)]" : "text-[var(--yellow,#f59e0b)]"}`} />
                      <span className="tabular-nums font-medium">{t.active_alerts}</span>
                      {t.critical_alerts > 0 && (
                        <Badge variant="danger">{t.critical_alerts} crit</Badge>
                      )}
                    </span>
                  )}

                  {/* Incidents */}
                  {(t.open_incidents + t.in_progress_incidents) > 0 && (
                    <span className="flex items-center gap-1 text-xs">
                      <Ticket className="w-3.5 h-3.5 text-[var(--brand)]" />
                      <span className="tabular-nums font-medium">
                        {t.open_incidents + t.in_progress_incidents}
                      </span>
                    </span>
                  )}

                  {/* Health badge */}
                  <Badge variant={healthVariant(t)}>
                    {t.active_alerts === 0 && t.open_incidents === 0 && t.in_progress_incidents === 0
                      ? <><CheckCircle className="w-3 h-3 mr-1 inline-block" />OK</>
                      : <><AlertTriangle className="w-3 h-3 mr-1 inline-block" />{healthLabel(t)}</>
                    }
                  </Badge>

                  {onSelectTenant && (
                    <span className="text-[10px] text-[var(--brand)] opacity-0 group-hover:opacity-100 transition-opacity">
                      Ver →
                    </span>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Users icon legend */}
      <p className="text-[10px] text-[var(--text-muted)] flex items-center gap-1">
        <Users className="w-3 h-3" />
        {tenants.length} cliente{tenants.length !== 1 ? "s" : ""} — atualiza automaticamente a cada 30 s
      </p>
    </div>
  );
}
