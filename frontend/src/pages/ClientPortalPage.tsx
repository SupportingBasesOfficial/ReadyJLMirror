import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useEffect, useState } from "react";
import { CheckCircle, AlertTriangle, XCircle, RefreshCw } from "lucide-react";

const SEVERITY_COLOR: Record<string, string> = {
  critical: "var(--red, #ef4444)",
  high: "#f97316",
  medium: "#eab308",
  low: "#6b7280",
  info: "#6b7280",
};

function StatusBadge({ status }: { status: string }) {
  const cfg = {
    operational: { icon: CheckCircle, color: "var(--green, #22c55e)", label: "Operacional" },
    degraded: { icon: AlertTriangle, color: "#f97316", label: "Degradado" },
    outage: { icon: XCircle, color: "var(--red, #ef4444)", label: "Interrupção" },
  }[status] ?? { icon: CheckCircle, color: "#6b7280", label: status };
  const Icon = cfg.icon;
  return (
    <span className="inline-flex items-center gap-1.5 text-sm font-semibold" style={{ color: cfg.color }}>
      <Icon size={16} />
      {cfg.label}
    </span>
  );
}

function SeverityPill({ severity }: { severity: string }) {
  return (
    <span
      className="inline-block px-2 py-0.5 rounded-full text-[11px] font-semibold uppercase"
      style={{
        background: `color-mix(in srgb, ${SEVERITY_COLOR[severity] ?? "#6b7280"} 15%, transparent)`,
        color: SEVERITY_COLOR[severity] ?? "#6b7280",
      }}
    >
      {severity}
    </span>
  );
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

function fmtDuration(secs: number) {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}min`;
  return `${Math.round(secs / 3600)}h`;
}

export function ClientPortalPage() {
  const [lastRefresh, setLastRefresh] = useState(new Date());

  const overview = useQuery({
    queryKey: ["portal-overview"],
    queryFn: () => api.get<{
      tenant_name: string;
      alerts: { active: number; critical: number; resolved_24h: number };
      open_incidents: number;
      sla_compliance_pct: number | null;
    }>("/api/v1/portal/overview"),
    refetchInterval: 120_000,
  });

  const statusQ = useQuery({
    queryKey: ["portal-status"],
    queryFn: () => api.get<{ status: string; label: string }>("/api/v1/portal/status"),
    refetchInterval: 120_000,
  });

  const alertsQ = useQuery({
    queryKey: ["portal-alerts"],
    queryFn: () => api.get<{ alert_id: string; title: string; severity: string; state: string; fired_at: string | null }[]>(
      "/api/v1/portal/alerts?state=active"
    ),
    refetchInterval: 120_000,
  });

  const incidentsQ = useQuery({
    queryKey: ["portal-incidents"],
    queryFn: () => api.get<{ incident_id: string; title: string; severity: string; state: string; detected_at: string | null }[]>(
      "/api/v1/portal/incidents?state=open"
    ),
    refetchInterval: 120_000,
  });

  const slaQ = useQuery({
    queryKey: ["portal-sla"],
    queryFn: () => api.get<{ sla_id: string; name: string; severity_match: string | null; response_secs: number; resolve_secs: number; compliance_pct: number | null }[]>(
      "/api/v1/portal/sla"
    ),
    refetchInterval: 120_000,
  });

  // Track refresh time
  useEffect(() => {
    if (overview.isFetching) setLastRefresh(new Date());
  }, [overview.isFetching]);

  const ov = overview.data;
  const st = statusQ.data;

  return (
    <div className="min-h-screen bg-[var(--bg)]">
      {/* Header */}
      <header
        className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]"
        style={{ background: "var(--surface)" }}
      >
        <div className="flex items-center gap-3">
          <span className="text-lg font-bold">
            <span style={{ color: "var(--brand)" }}>Argos</span>
          </span>
          {ov?.tenant_name && (
            <>
              <span style={{ color: "var(--text-dim)" }}>·</span>
              <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
                {ov.tenant_name}
              </span>
            </>
          )}
        </div>
        <div className="flex items-center gap-4">
          {st && <StatusBadge status={st.status} />}
          <span className="text-[11px]" style={{ color: "var(--text-dim)" }}>
            Atualizado {lastRefresh.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
          </span>
          <button
            onClick={() => { overview.refetch(); statusQ.refetch(); alertsQ.refetch(); incidentsQ.refetch(); slaQ.refetch(); }}
            title="Atualizar agora"
            className="p-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            <RefreshCw size={14} className={overview.isFetching ? "animate-spin" : ""} />
          </button>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-8 space-y-8">
        {/* KPI tiles */}
        <div className="grid grid-cols-3 gap-4">
          <div
            className="rounded-xl p-5 border"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
              Alertas Ativos
            </div>
            <div className="text-3xl font-bold" style={{ color: "var(--text)" }}>
              {ov?.alerts.active ?? "—"}
            </div>
            {ov && ov.alerts.critical > 0 && (
              <div className="text-xs mt-1" style={{ color: "var(--red, #ef4444)" }}>
                {ov.alerts.critical} crítico{ov.alerts.critical > 1 ? "s" : ""}
              </div>
            )}
            {ov && ov.alerts.resolved_24h > 0 && (
              <div className="text-[11px] mt-1" style={{ color: "var(--text-dim)" }}>
                {ov.alerts.resolved_24h} resolvido{ov.alerts.resolved_24h > 1 ? "s" : ""} nas últimas 24h
              </div>
            )}
          </div>

          <div
            className="rounded-xl p-5 border"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
              Incidentes Abertos
            </div>
            <div className="text-3xl font-bold" style={{ color: "var(--text)" }}>
              {ov?.open_incidents ?? "—"}
            </div>
            <div className="text-[11px] mt-1" style={{ color: "var(--text-dim)" }}>
              em andamento
            </div>
          </div>

          <div
            className="rounded-xl p-5 border"
            style={{ background: "var(--surface)", borderColor: "var(--border)" }}
          >
            <div className="text-xs font-semibold uppercase tracking-wider mb-2" style={{ color: "var(--text-muted)" }}>
              Conformidade SLA (30d)
            </div>
            <div
              className="text-3xl font-bold"
              style={{
                color: ov?.sla_compliance_pct == null
                  ? "var(--text-dim)"
                  : ov.sla_compliance_pct >= 95
                  ? "var(--green, #22c55e)"
                  : ov.sla_compliance_pct >= 80
                  ? "#f97316"
                  : "var(--red, #ef4444)",
              }}
            >
              {ov?.sla_compliance_pct != null ? `${ov.sla_compliance_pct}%` : "—"}
            </div>
            <div className="text-[11px] mt-1" style={{ color: "var(--text-dim)" }}>
              últimos 30 dias
            </div>
          </div>
        </div>

        {/* Active alerts table */}
        <section>
          <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--text)" }}>
            Alertas Ativos
          </h2>
          <div
            className="rounded-xl border overflow-hidden"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            {alertsQ.isLoading ? (
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-dim)" }}>Carregando…</div>
            ) : !alertsQ.data?.length ? (
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-dim)" }}>
                <CheckCircle size={20} className="mx-auto mb-2" style={{ color: "var(--green, #22c55e)" }} />
                Nenhum alerta ativo
              </div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Título", "Severidade", "Ativo desde"].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {alertsQ.data.map((a, i) => (
                    <tr
                      key={a.alert_id}
                      style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined }}
                    >
                      <td className="px-4 py-3" style={{ color: "var(--text)" }}>{a.title}</td>
                      <td className="px-4 py-3"><SeverityPill severity={a.severity} /></td>
                      <td className="px-4 py-3 text-[12px]" style={{ color: "var(--text-muted)" }}>{fmtDate(a.fired_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* Open incidents */}
        <section>
          <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--text)" }}>
            Incidentes em Aberto
          </h2>
          <div
            className="rounded-xl border overflow-hidden"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            {incidentsQ.isLoading ? (
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-dim)" }}>Carregando…</div>
            ) : !incidentsQ.data?.length ? (
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-dim)" }}>
                <CheckCircle size={20} className="mx-auto mb-2" style={{ color: "var(--green, #22c55e)" }} />
                Nenhum incidente aberto
              </div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Título", "Severidade", "Detectado em", "Estado"].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {incidentsQ.data.map((inc, i) => (
                    <tr
                      key={inc.incident_id}
                      style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined }}
                    >
                      <td className="px-4 py-3" style={{ color: "var(--text)" }}>{inc.title}</td>
                      <td className="px-4 py-3"><SeverityPill severity={inc.severity} /></td>
                      <td className="px-4 py-3 text-[12px]" style={{ color: "var(--text-muted)" }}>{fmtDate(inc.detected_at)}</td>
                      <td className="px-4 py-3 text-[12px]" style={{ color: "var(--text-muted)" }}>{inc.state}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        {/* SLA table */}
        <section>
          <h2 className="text-sm font-semibold mb-3" style={{ color: "var(--text)" }}>
            Acordos de Nível de Serviço
          </h2>
          <div
            className="rounded-xl border overflow-hidden"
            style={{ borderColor: "var(--border)", background: "var(--surface)" }}
          >
            {slaQ.isLoading ? (
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-dim)" }}>Carregando…</div>
            ) : !slaQ.data?.length ? (
              <div className="p-6 text-center text-sm" style={{ color: "var(--text-dim)" }}>
                Nenhuma política de SLA configurada
              </div>
            ) : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)" }}>
                    {["Política", "Severidade", "Resposta", "Resolução", "Conformidade (30d)"].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left text-[11px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-muted)" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {slaQ.data.map((s, i) => (
                    <tr
                      key={s.sla_id}
                      style={{ borderTop: i > 0 ? "1px solid var(--border)" : undefined }}
                    >
                      <td className="px-4 py-3 font-medium" style={{ color: "var(--text)" }}>{s.name}</td>
                      <td className="px-4 py-3">
                        {s.severity_match ? <SeverityPill severity={s.severity_match} /> : <span style={{ color: "var(--text-dim)" }}>todos</span>}
                      </td>
                      <td className="px-4 py-3 text-[12px]" style={{ color: "var(--text-muted)" }}>{fmtDuration(s.response_secs)}</td>
                      <td className="px-4 py-3 text-[12px]" style={{ color: "var(--text-muted)" }}>{fmtDuration(s.resolve_secs)}</td>
                      <td className="px-4 py-3">
                        {s.compliance_pct != null ? (
                          <span
                            className="font-semibold text-sm"
                            style={{
                              color: s.compliance_pct >= 95
                                ? "var(--green, #22c55e)"
                                : s.compliance_pct >= 80
                                ? "#f97316"
                                : "var(--red, #ef4444)",
                            }}
                          >
                            {s.compliance_pct}%
                          </span>
                        ) : (
                          <span style={{ color: "var(--text-dim)" }}>—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </section>

        <p className="text-center text-[11px] pb-4" style={{ color: "var(--text-dim)" }}>
          Atualização automática a cada 2 minutos · Portal do Cliente Argos
        </p>
      </main>
    </div>
  );
}
