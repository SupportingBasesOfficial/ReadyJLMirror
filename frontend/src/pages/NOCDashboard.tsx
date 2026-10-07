import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Activity, Bell, Zap, ArrowRight } from "lucide-react";

interface RawAlert {
  alert_id: string;
  lifecycle_state: string;
  source_kind: string;
  monitoring_source_id: string;
  monitoring_resource_id: string;
  source_evidence_summary: { severity_class?: string; problem_id?: string; health_classes?: string[] };
  opened_at: string;
  resolved_at?: string;
}

interface RawSource {
  monitoring_source_id: string;
  display_name: string;
  operational_evidence_state: string;
}

interface Props { tenantId: string }

function sevVariant(cls?: string): "danger" | "warning" | "info" | "muted" {
  if (cls === "critical") return "danger";
  if (cls === "degraded" || cls === "warning") return "warning";
  if (cls === "informational") return "info";
  return "muted";
}

function sevLabel(cls?: string) {
  return cls?.toUpperCase() ?? "UNKNOWN";
}

function alertTitle(a: RawAlert): string {
  const ev = a.source_evidence_summary;
  if (ev?.problem_id) return ev.problem_id;
  if (ev?.health_classes?.length) return ev.health_classes.join(", ");
  return a.monitoring_resource_id || a.source_kind;
}

function healthVariant(state: string): "success" | "warning" | "danger" | "muted" {
  if (state === "current") return "success";
  if (state === "stale" || state === "incomplete" || state === "reconciliation_required") return "warning";
  if (state === "unavailable") return "danger";
  return "muted";
}

function fmtTs(iso?: string) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
      <span
        className={[
          "inline-block w-1.5 h-1.5 rounded-full",
          connected
            ? "bg-[var(--green)] shadow-[0_0_4px_var(--green)] animate-pulse"
            : "bg-[var(--text-muted)]",
        ].join(" ")}
      />
      {connected ? "live" : "reconnecting…"}
    </span>
  );
}

const DEFAULT_WIDGETS = { stats: true, alerts: true, sources: true };
type WidgetKey = keyof typeof DEFAULT_WIDGETS;

function loadWidgets(tenantId: string): typeof DEFAULT_WIDGETS {
  try {
    const raw = localStorage.getItem(`jlm_noc_widgets_${tenantId}`);
    if (!raw) return { ...DEFAULT_WIDGETS };
    return { ...DEFAULT_WIDGETS, ...JSON.parse(raw) };
  } catch {
    return { ...DEFAULT_WIDGETS };
  }
}

export function NOCDashboard({ tenantId }: Props) {
  const [alerts, setAlerts] = useState<RawAlert[]>([]);
  const [sources, setSources] = useState<RawSource[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(5000);
  const [widgets, setWidgets] = useState<typeof DEFAULT_WIDGETS>(() => loadWidgets(tenantId));
  const [showCustomize, setShowCustomize] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const toggleWidget = (key: WidgetKey) => {
    setWidgets((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem(`jlm_noc_widgets_${tenantId}`, JSON.stringify(next)); } catch { /* */ }
      return next;
    });
  };

  useEffect(() => {
    if (!showCustomize) return;
    function handleOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setShowCustomize(false);
      }
    }
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShowCustomize(false);
    }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showCustomize]);

  // Maintenance windows — determine which source IDs are currently in maintenance
  const { data: maintenanceWindows = [] } = useQuery<
    { window_id: string; source_ids: string[] | null; active: boolean }[]
  >({
    queryKey: ["maintenance-windows", tenantId],
    queryFn: () =>
      api.get<{ window_id: string; source_ids: string[] | null; active: boolean }[]>(
        `/api/v1/maintenance/windows`
      ),
    refetchInterval: 60_000,
  });
  const maintenanceSources = new Set<string>(
    maintenanceWindows
      .filter((w) => w.active)
      .flatMap((w) => w.source_ids ?? [])
  );
  const allSourcesMaintenance = maintenanceWindows.some(
    (w) => w.active && w.source_ids === null
  );

  useEffect(() => {
    let cancelled = false;

    // Bootstrap data immediately via REST — don't wait for SSE first message
    void Promise.all([
      api.get<RawAlert[]>("/api/v1/alerting/alerts?lifecycle_state=active&limit=50"),
      api.get<RawSource[]>("/api/v1/monitoring/sources"),
    ]).then(([alertData, sourceData]) => {
      if (cancelled) return;
      setAlerts(alertData);
      setSources(sourceData);
      setLoading(false);
    }).catch(() => {
      if (!cancelled) setLoading(false); // show empty state, not endless spinner
    });

    function connect() {
      if (cancelled) return;

      const es = new EventSource(`/api/v1/noc/stream`);
      esRef.current = es;

      es.onopen = () => {
        if (cancelled) { es.close(); return; }
        setConnected(true);
        setError(false);
        retryDelayRef.current = 5000;
      };

      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const snap = JSON.parse(ev.data) as { alerts: RawAlert[]; sources: RawSource[] };
          setAlerts(snap.alerts);
          setSources(snap.sources);
          setLoading(false);
          setError(false);
        } catch {
          // ignore parse error
        }
      };

      es.onerror = () => {
        if (cancelled) return;
        es.close();
        esRef.current = null;
        setConnected(false);
        // Fall back to REST poll immediately, then retry SSE in 10 s
        void api
          .get<RawAlert[]>(`/api/v1/alerting/alerts?lifecycle_state=active&limit=50`)
          .then((data) => { if (!cancelled) { setAlerts(data); setLoading(false); } })
          .catch(() => { if (!cancelled) setError(true); });
        void api
          .get<RawSource[]>(`/api/v1/monitoring/sources`)
          .then((data) => { if (!cancelled) setSources(data); })
          .catch(() => null);
        const delay = retryDelayRef.current * (0.8 + Math.random() * 0.4);
        retryDelayRef.current = Math.min(retryDelayRef.current * 2, 60_000);
        retryRef.current = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      cancelled = true;
      esRef.current?.close();
      esRef.current = null;
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [tenantId]);

  const criticalCount = alerts.filter(
    (a) => a.source_evidence_summary?.severity_class === "critical"
  ).length;
  const degradedCount = alerts.filter((a) => {
    const s = a.source_evidence_summary?.severity_class;
    return s === "degraded" || s === "warning";
  }).length;
  const sourcesOk = sources.filter(
    (s) => healthVariant(s.operational_evidence_state) === "success"
  ).length;

  const WIDGET_LABELS: Record<WidgetKey, string> = {
    stats: "Resumo de contadores",
    alerts: "Alertas ativos",
    sources: "Fontes de monitoramento",
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">NOC Overview</h2>
          <LiveDot connected={connected} />
        </div>
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowCustomize((v) => !v)}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] transition-colors"
            title="Personalizar dashboard"
          >
            ⚙ Personalizar
          </button>
          {showCustomize && (
            <div className="absolute right-0 top-8 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-lg p-3 min-w-[220px]">
              <div className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Widgets visíveis
              </div>
              {(Object.keys(DEFAULT_WIDGETS) as WidgetKey[]).map((key) => (
                <label key={key} className="flex items-center gap-2 py-1.5 cursor-pointer select-none">
                  <input
                    type="checkbox"
                    checked={widgets[key]}
                    onChange={() => toggleWidget(key)}
                    className="accent-[var(--brand)]"
                  />
                  <span className="text-sm">{WIDGET_LABELS[key]}</span>
                </label>
              ))}
              <button
                onClick={() => setShowCustomize(false)}
                className="mt-2 w-full text-xs text-[var(--text-muted)] hover:text-[var(--text)] text-center py-1"
              >
                Fechar
              </button>
            </div>
          )}
        </div>
      </div>

      {widgets.stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <StatCard label="Alertas ativos" value={alerts.length} color={alerts.length > 0 ? "var(--yellow)" : "var(--green)"} />
          <StatCard label="Críticos" value={criticalCount} color={criticalCount > 0 ? "var(--red)" : "var(--text-muted)"} />
          <StatCard label="Degradados" value={degradedCount} color={degradedCount > 0 ? "var(--yellow)" : "var(--text-muted)"} />
          <StatCard label="Fontes ativas" value={`${sourcesOk}/${sources.length}`} color="var(--text-muted)" />
        </div>
      )}

      {/* Getting started — shown only when no sources configured yet */}
      {!loading && sources.length === 0 && (
        <div
          style={{
            border: "1px solid var(--border)",
            borderRadius: 14,
            padding: "28px 24px",
            background: "color-mix(in srgb, var(--brand) 4%, var(--surface))",
          }}
        >
          <div className="text-sm font-semibold mb-1" style={{ color: "var(--text)" }}>
            Bem-vindo ao JLMirror 👋
          </div>
          <p className="text-xs mb-5" style={{ color: "var(--text-muted)" }}>
            Nenhuma fonte de monitoramento conectada ainda. Configure sua primeira fonte para começar a receber alertas.
          </p>
          <div className="grid gap-3 sm:grid-cols-3 mb-5">
            {[
              { Icon: Activity, label: "1. Adicionar fonte", desc: "Conecte Zabbix ao JLMirror", page: "/monitoring" },
              { Icon: Bell, label: "2. Definir políticas", desc: "Configure as regras de alerta e escalonamento", page: "/policies" },
              { Icon: Zap, label: "3. Configurar automação", desc: "Crie respostas automáticas a incidentes", page: "/automation" },
            ].map(({ Icon, label, desc, page }) => (
              <Link
                key={label}
                to={page}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 12,
                  padding: "14px 14px",
                  background: "var(--surface-2)",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  textDecoration: "none",
                  color: "inherit",
                  transition: "border-color 0.15s",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--brand)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}
              >
                <div
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 7,
                    background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon size={14} style={{ color: "var(--brand)" }} />
                </div>
                <div>
                  <div className="text-xs font-semibold mb-0.5" style={{ color: "var(--text)" }}>{label}</div>
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{desc}</div>
                </div>
              </Link>
            ))}
          </div>
          <Link
            to="/monitoring"
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 12,
              fontWeight: 500,
              color: "var(--brand)",
              textDecoration: "none",
            }}
          >
            Ir para Monitoramento <ArrowRight size={13} />
          </Link>
        </div>
      )}

      {widgets.alerts && (
        <Card>
          <CardHeader>
            <span className="text-sm font-medium">Alertas ativos</span>
            {!connected && !loading && <Spinner className="w-3 h-3" />}
          </CardHeader>
          {loading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : error ? (
            <p className="text-xs text-[var(--red)]">Falha ao carregar alertas.</p>
          ) : alerts.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] py-2">Nenhum alerta ativo.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="pb-2 pr-3 font-medium">Severidade</th>
                  <th className="pb-2 pr-3 font-medium">Evento / Recurso</th>
                  <th className="pb-2 pr-3 font-medium">Fonte</th>
                  <th className="pb-2 font-medium">Aberto em</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {alerts.map((a) => (
                  <tr
                    key={a.alert_id}
                    className="cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
                    onClick={() => navigate(`/alerts?highlight=${a.alert_id}`)}
                  >
                    <td className="py-1.5 pr-3">
                      <Badge variant={sevVariant(a.source_evidence_summary?.severity_class)}>
                        {sevLabel(a.source_evidence_summary?.severity_class)}
                      </Badge>
                    </td>
                    <td className="py-1.5 pr-3 text-[var(--text)] max-w-[200px] truncate font-mono text-[10px]">
                      {alertTitle(a)}
                    </td>
                    <td className="py-1.5 pr-3 text-[var(--text-muted)] max-w-[120px] truncate font-mono text-[10px]">
                      {a.monitoring_source_id}
                    </td>
                    <td className="py-1.5 text-[var(--text-muted)] whitespace-nowrap">{fmtTs(a.opened_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {widgets.sources && (
        <Card>
          <CardHeader>
            <span className="text-sm font-medium">Fontes de monitoramento</span>
          </CardHeader>
          {loading ? (
            <div className="flex justify-center py-6"><Spinner /></div>
          ) : sources.length === 0 ? (
            <div className="py-3 flex items-center justify-between">
              <p className="text-xs text-[var(--text-muted)]">Nenhuma fonte configurada.</p>
              <Link to="/monitoring" className="text-xs" style={{ color: "var(--brand)", textDecoration: "none" }}>
                Adicionar fonte →
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
              {sources.map((s) => {
                const inMaintenance =
                  allSourcesMaintenance ||
                  maintenanceSources.has(s.monitoring_source_id);
                return (
                  <div
                    key={s.monitoring_source_id}
                    className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-3 cursor-pointer hover:border-[var(--brand)] transition-colors"
                    onClick={() => navigate("/monitoring")}
                    role="button"
                    tabIndex={0}
                    onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") navigate("/monitoring"); }}
                  >
                    <div className="flex items-center justify-between mb-1 gap-1 flex-wrap">
                      <span className="text-sm font-medium truncate">{s.display_name}</span>
                      <div className="flex gap-1 flex-shrink-0">
                        {inMaintenance && (
                          <Badge variant="warning">manutenção</Badge>
                        )}
                        <Badge variant={healthVariant(s.operational_evidence_state)}>
                          {s.operational_evidence_state}
                        </Badge>
                      </div>
                    </div>
                    <p className="text-[10px] text-[var(--text-muted)] font-mono truncate">{s.monitoring_source_id}</p>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      )}

      {!widgets.stats && !widgets.alerts && !widgets.sources && (
        <div className="text-center py-16 text-[var(--text-muted)] text-sm">
          Nenhum widget visível. Clique em ⚙ Personalizar para reativar.
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl p-3">
      <div className="text-xl font-semibold" style={{ color }}>{value}</div>
      <div className="text-xs text-[var(--text-muted)] mt-0.5">{label}</div>
    </div>
  );
}
