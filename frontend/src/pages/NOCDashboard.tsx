import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Activity, Bell, Zap, ArrowRight, GripVertical, ChevronUp, ChevronDown } from "lucide-react";
import { useSession } from "@/hooks/useSession";

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

interface RawIncident {
  incident_id: string;
  title: string;
  lifecycle_state: string;
  severity_class?: string;
  created_at: string;
}

interface RawRfc {
  rfc_id: string;
  title: string;
  state: string;
  risk?: string;
}

interface Props { tenantId: string }

// ── Helpers ──────────────────────────────────────────────────────────────────
function sevVariant(cls?: string): "danger" | "warning" | "info" | "muted" {
  if (cls === "critical") return "danger";
  if (cls === "degraded" || cls === "warning") return "warning";
  if (cls === "informational") return "info";
  return "muted";
}

function sevLabel(cls?: string) { return cls?.toUpperCase() ?? "UNKNOWN"; }

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
  try { return new Date(iso).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }); } catch { return iso; }
}

function LiveDot({ connected }: { connected: boolean }) {
  return (
    <span className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
      <span className={[
        "inline-block w-1.5 h-1.5 rounded-full",
        connected
          ? "bg-[var(--green)] shadow-[0_0_4px_var(--green)] animate-pulse"
          : "bg-[var(--text-muted)]",
      ].join(" ")} />
      {connected ? "live" : "reconectando…"}
    </span>
  );
}

// ── Widget config ─────────────────────────────────────────────────────────────
const STAT_KEYS = ["stat_alerts", "stat_critical", "stat_degraded", "stat_sources"] as const;
const PANEL_KEYS = ["alerts", "sources", "incidents", "changes"] as const;
type StatKey = typeof STAT_KEYS[number];
type PanelKey = typeof PANEL_KEYS[number];
type WidgetKey = StatKey | PanelKey;

interface WidgetConfig {
  visible: Record<WidgetKey, boolean>;
  order: PanelKey[];
}

const DEFAULT_CONFIG: WidgetConfig = {
  visible: {
    stat_alerts: true,
    stat_critical: true,
    stat_degraded: true,
    stat_sources: true,
    alerts: true,
    sources: true,
    incidents: false,
    changes: false,
  },
  order: ["alerts", "sources", "incidents", "changes"],
};

const TEMPLATE_KEY = (tid: string) => `jlm_noc_template_${tid}`;
const USER_KEY = (tid: string) => `jlm_noc_v2_${tid}`;

function parseWidgetConfig(raw: string): WidgetConfig {
  const parsed = JSON.parse(raw) as Partial<WidgetConfig>;
  return { visible: { ...DEFAULT_CONFIG.visible, ...(parsed.visible ?? {}) }, order: parsed.order ?? DEFAULT_CONFIG.order };
}

function loadConfigWithSource(tenantId: string): [WidgetConfig, "user" | "template" | "default"] {
  try {
    const raw = localStorage.getItem(USER_KEY(tenantId));
    if (raw) return [parseWidgetConfig(raw), "user"];
  } catch { /* */ }
  try {
    const raw = localStorage.getItem(TEMPLATE_KEY(tenantId));
    if (raw) return [parseWidgetConfig(raw), "template"];
  } catch { /* */ }
  return [DEFAULT_CONFIG, "default"];
}

function saveUserConfig(tenantId: string, cfg: WidgetConfig) {
  try { localStorage.setItem(USER_KEY(tenantId), JSON.stringify(cfg)); } catch { /* */ }
}

function saveTemplate(tenantId: string, cfg: WidgetConfig) {
  try { localStorage.setItem(TEMPLATE_KEY(tenantId), JSON.stringify(cfg)); } catch { /* */ }
}

function loadTemplate(tenantId: string): WidgetConfig | null {
  try {
    const raw = localStorage.getItem(TEMPLATE_KEY(tenantId));
    if (!raw) return null;
    return parseWidgetConfig(raw);
  } catch { return null; }
}

const WIDGET_LABELS: Record<WidgetKey, string> = {
  stat_alerts: "Contador: alertas ativos",
  stat_critical: "Contador: críticos",
  stat_degraded: "Contador: degradados",
  stat_sources: "Contador: fontes ativas",
  alerts: "Painel de alertas",
  sources: "Fontes de monitoramento",
  incidents: "Incidentes abertos",
  changes: "Mudanças em andamento",
};

// ── Component ─────────────────────────────────────────────────────────────────
export function NOCDashboard({ tenantId }: Props) {
  const [alerts, setAlerts] = useState<RawAlert[]>([]);
  const [sources, setSources] = useState<RawSource[]>([]);
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const esRef = useRef<EventSource | null>(null);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef(5000);
  const [cfg, setCfg] = useState<WidgetConfig>(() => loadConfigWithSource(tenantId)[0]);
  const [configSource, setConfigSource] = useState<"user" | "template" | "default">(() => loadConfigWithSource(tenantId)[1]);
  const [templateSaved, setTemplateSaved] = useState(false);
  const [templateExists, setTemplateExists] = useState(() => loadTemplate(tenantId) !== null);
  const [showCustomize, setShowCustomize] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  const { data: session } = useSession();
  const isAdmin = session?.tenant?.role === "admin" || session?.is_platform_admin === true;

  const updateCfg = (next: WidgetConfig) => {
    setCfg(next);
    saveUserConfig(tenantId, next);
    setConfigSource("user");
  };

  function handleSaveTemplate() {
    saveTemplate(tenantId, cfg);
    setTemplateExists(true);
    setTemplateSaved(true);
    setTimeout(() => setTemplateSaved(false), 2000);
  }

  function handleRestoreTemplate() {
    const tpl = loadTemplate(tenantId);
    if (!tpl) return;
    try { localStorage.removeItem(USER_KEY(tenantId)); } catch { /* */ }
    setCfg(tpl);
    setConfigSource("template");
  }

  const toggleVisible = (key: WidgetKey) => {
    updateCfg({ ...cfg, visible: { ...cfg.visible, [key]: !cfg.visible[key] } });
  };

  const movePanel = (key: PanelKey, dir: -1 | 1) => {
    const order = [...cfg.order];
    const idx = order.indexOf(key);
    const next = idx + dir;
    if (next < 0 || next >= order.length) return;
    [order[idx], order[next]] = [order[next], order[idx]];
    updateCfg({ ...cfg, order });
  };

  useEffect(() => {
    if (!showCustomize) return;
    function handleOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node))
        setShowCustomize(false);
    }
    function handleKey(e: KeyboardEvent) { if (e.key === "Escape") setShowCustomize(false); }
    document.addEventListener("mousedown", handleOutside);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleOutside);
      document.removeEventListener("keydown", handleKey);
    };
  }, [showCustomize]);

  // Maintenance windows
  const { data: maintenanceWindows = [] } = useQuery<
    { window_id: string; source_ids: string[] | null; active: boolean }[]
  >({
    queryKey: ["maintenance-windows", tenantId],
    queryFn: () => api.get<{ window_id: string; source_ids: string[] | null; active: boolean }[]>(`/api/v1/maintenance/windows`),
    refetchInterval: 60_000,
  });
  const maintenanceSources = new Set<string>(
    maintenanceWindows.filter((w) => w.active).flatMap((w) => w.source_ids ?? [])
  );
  const allSourcesMaintenance = maintenanceWindows.some((w) => w.active && w.source_ids === null);

  // Incidents widget data
  const incidentsQ = useQuery<RawIncident[]>({
    queryKey: ["noc-incidents", tenantId],
    queryFn: () => api.get<RawIncident[]>("/api/v1/alerting/incidents?limit=20"),
    enabled: cfg.visible.incidents,
    refetchInterval: 30_000,
  });

  // Changes widget data
  const changesQ = useQuery<RawRfc[]>({
    queryKey: ["noc-changes", tenantId],
    queryFn: () => api.get<RawRfc[]>("/api/v1/itsm/changes?limit=10"),
    enabled: cfg.visible.changes,
    refetchInterval: 30_000,
  });

  const activeRfcs = (changesQ.data ?? []).filter(
    (r) => !["complete", "cancelled"].includes(r.state)
  );

  // SSE + bootstrap
  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api.get<RawAlert[]>("/api/v1/alerting/alerts?lifecycle_state=active&limit=50"),
      api.get<RawSource[]>("/api/v1/monitoring/sources"),
    ]).then(([alertData, sourceData]) => {
      if (cancelled) return;
      setAlerts(alertData);
      setSources(sourceData);
      setLoading(false);
    }).catch(() => { if (!cancelled) setLoading(false); });

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
        } catch { /* */ }
      };
      es.onerror = () => {
        if (cancelled) return;
        es.close();
        esRef.current = null;
        setConnected(false);
        void api.get<RawAlert[]>(`/api/v1/alerting/alerts?lifecycle_state=active&limit=50`)
          .then((data) => { if (!cancelled) { setAlerts(data); setLoading(false); } })
          .catch(() => { if (!cancelled) setError(true); });
        void api.get<RawSource[]>(`/api/v1/monitoring/sources`)
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

  const criticalCount = alerts.filter((a) => a.source_evidence_summary?.severity_class === "critical").length;
  const degradedCount = alerts.filter((a) => {
    const s = a.source_evidence_summary?.severity_class;
    return s === "degraded" || s === "warning";
  }).length;
  const sourcesOk = sources.filter((s) => healthVariant(s.operational_evidence_state) === "success").length;

  const openIncidents = (incidentsQ.data ?? []).filter((i) => ["open", "in_progress"].includes(i.lifecycle_state));

  const anyVisible = Object.values(cfg.visible).some(Boolean);

  // ── Panels ──────────────────────────────────────────────────────────────────
  function renderPanel(key: PanelKey) {
    if (!cfg.visible[key]) return null;

    if (key === "alerts") return (
      <Card key="alerts">
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
                <tr key={a.alert_id}
                  className="cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
                  onClick={() => navigate(`/alerts?highlight=${a.alert_id}`)}>
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
    );

    if (key === "sources") return (
      <Card key="sources">
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
              const inMaintenance = allSourcesMaintenance || maintenanceSources.has(s.monitoring_source_id);
              return (
                <div key={s.monitoring_source_id}
                  className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg p-3 cursor-pointer hover:border-[var(--brand)] transition-colors"
                  onClick={() => navigate("/monitoring")} role="button" tabIndex={0}
                  onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") navigate("/monitoring"); }}>
                  <div className="flex items-center justify-between mb-1 gap-1 flex-wrap">
                    <span className="text-sm font-medium truncate">{s.display_name}</span>
                    <div className="flex gap-1 flex-shrink-0">
                      {inMaintenance && <Badge variant="warning">manutenção</Badge>}
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
    );

    if (key === "incidents") return (
      <Card key="incidents">
        <CardHeader>
          <span className="text-sm font-medium">Incidentes abertos</span>
          {incidentsQ.isFetching && <Spinner className="w-3 h-3" />}
          <Link to="/incidents" className="text-xs ml-auto" style={{ color: "var(--brand)", textDecoration: "none" }}>
            Ver todos →
          </Link>
        </CardHeader>
        {incidentsQ.isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : openIncidents.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] py-2">Nenhum incidente aberto.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="pb-2 pr-3 font-medium">Estado</th>
                <th className="pb-2 pr-3 font-medium">Título</th>
                <th className="pb-2 font-medium">Aberto em</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {openIncidents.map((i) => (
                <tr key={i.incident_id}
                  className="cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
                  onClick={() => navigate(`/incidents`)}>
                  <td className="py-1.5 pr-3">
                    <Badge variant={i.lifecycle_state === "in_progress" ? "warning" : "info"}>
                      {i.lifecycle_state === "in_progress" ? "em andamento" : "aberto"}
                    </Badge>
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--text)] max-w-[260px] truncate">{i.title}</td>
                  <td className="py-1.5 text-[var(--text-muted)] whitespace-nowrap">{fmtTs(i.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    );

    if (key === "changes") return (
      <Card key="changes">
        <CardHeader>
          <span className="text-sm font-medium">Mudanças em andamento</span>
          {changesQ.isFetching && <Spinner className="w-3 h-3" />}
          <Link to="/changes" className="text-xs ml-auto" style={{ color: "var(--brand)", textDecoration: "none" }}>
            Ver todas →
          </Link>
        </CardHeader>
        {changesQ.isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : activeRfcs.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] py-2">Nenhuma mudança em andamento.</p>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="pb-2 pr-3 font-medium">Estado</th>
                <th className="pb-2 pr-3 font-medium">Título</th>
                <th className="pb-2 font-medium">Risco</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {activeRfcs.map((r) => (
                <tr key={r.rfc_id}
                  className="cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
                  onClick={() => navigate(`/changes`)}>
                  <td className="py-1.5 pr-3">
                    <Badge variant={r.state === "implementing" ? "warning" : r.state === "approved" ? "success" : "muted"}>
                      {r.state === "implementing" ? "implementando"
                        : r.state === "review" ? "em revisão"
                        : r.state === "approved" ? "aprovado"
                        : r.state === "scheduled" ? "agendado"
                        : r.state}
                    </Badge>
                  </td>
                  <td className="py-1.5 pr-3 text-[var(--text)] max-w-[260px] truncate">{r.title}</td>
                  <td className="py-1.5">
                    <Badge variant={r.risk === "critical" ? "danger" : r.risk === "high" ? "warning" : "muted"}>
                      {r.risk ?? "—"}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    );

    return null;
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold">NOC Overview</h2>
          <LiveDot connected={connected} />
        </div>
        <div className="relative" ref={dropdownRef}>
          <button
            onClick={() => setShowCustomize((v) => !v)}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1 px-2 py-1 rounded border border-[var(--border)] bg-[var(--surface-2)] transition-colors"
          >
            <GripVertical className="w-3 h-3" />
            Personalizar
          </button>

          {showCustomize && (
            <div className="absolute right-0 top-8 z-20 bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-lg p-4 w-72">
              {/* Stat counters */}
              <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Contadores
              </div>
              <div className="grid grid-cols-2 gap-1 mb-3">
                {STAT_KEYS.map((key) => (
                  <label key={key} className="flex items-center gap-1.5 py-1 cursor-pointer select-none text-xs">
                    <input type="checkbox" checked={cfg.visible[key]} onChange={() => toggleVisible(key)}
                      className="accent-[var(--brand)] w-3 h-3" />
                    {WIDGET_LABELS[key].replace("Contador: ", "")}
                  </label>
                ))}
              </div>

              {/* Panels */}
              <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Painéis — ordem
              </div>
              <div className="space-y-1">
                {cfg.order.map((key, idx) => (
                  <div key={key} className="flex items-center gap-2 py-1 px-1 rounded hover:bg-[var(--surface-2)]">
                    <input type="checkbox" checked={cfg.visible[key]} onChange={() => toggleVisible(key)}
                      className="accent-[var(--brand)] w-3 h-3 flex-shrink-0" />
                    <span className="text-xs flex-1 truncate">{WIDGET_LABELS[key]}</span>
                    <div className="flex gap-0.5 flex-shrink-0">
                      <button onClick={() => movePanel(key, -1)} disabled={idx === 0}
                        className="p-0.5 rounded hover:bg-[var(--border)] disabled:opacity-30 transition-colors">
                        <ChevronUp className="w-3 h-3" />
                      </button>
                      <button onClick={() => movePanel(key, 1)} disabled={idx === cfg.order.length - 1}
                        className="p-0.5 rounded hover:bg-[var(--border)] disabled:opacity-30 transition-colors">
                        <ChevronDown className="w-3 h-3" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Template section */}
              <div className="mt-3 pt-3 border-t border-[var(--border)]">
                {isAdmin ? (
                  <>
                    <div className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-2">
                      Template do tenant
                    </div>
                    <button
                      onClick={handleSaveTemplate}
                      className="w-full text-xs py-1.5 px-3 rounded-lg border border-[var(--brand)] text-[var(--brand)] hover:bg-[color-mix(in_srgb,var(--brand)_10%,transparent)] transition-colors text-left"
                    >
                      {templateSaved ? "✓ Template salvo!" : "Definir como template para todos"}
                    </button>
                    {templateExists && (
                      <p className="text-[10px] text-[var(--text-muted)] mt-1.5">
                        TV Mode e novos usuários seguirão este template.
                      </p>
                    )}
                  </>
                ) : configSource === "template" ? (
                  <span className="text-[10px] text-[var(--brand)] flex items-center gap-1.5">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--brand)] inline-block flex-shrink-0" />
                    Seguindo template do administrador
                  </span>
                ) : templateExists ? (
                  <button
                    onClick={handleRestoreTemplate}
                    className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] underline text-left w-full"
                  >
                    Restaurar template do administrador
                  </button>
                ) : null}
              </div>

              <button onClick={() => setShowCustomize(false)}
                className="mt-3 w-full text-xs text-[var(--text-muted)] hover:text-[var(--text)] text-center py-1">
                Fechar
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Stat tiles */}
      {STAT_KEYS.some((k) => cfg.visible[k]) && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {cfg.visible.stat_alerts && (
            <StatCard label="Alertas ativos" value={alerts.length}
              color={alerts.length > 0 ? "var(--yellow)" : "var(--green)"} />
          )}
          {cfg.visible.stat_critical && (
            <StatCard label="Críticos" value={criticalCount}
              color={criticalCount > 0 ? "var(--red)" : "var(--text-muted)"} />
          )}
          {cfg.visible.stat_degraded && (
            <StatCard label="Degradados" value={degradedCount}
              color={degradedCount > 0 ? "var(--yellow)" : "var(--text-muted)"} />
          )}
          {cfg.visible.stat_sources && (
            <StatCard label="Fontes ativas" value={`${sourcesOk}/${sources.length}`}
              color="var(--text-muted)" />
          )}
        </div>
      )}

      {/* Getting started */}
      {!loading && sources.length === 0 && (
        <div style={{
          border: "1px solid var(--border)", borderRadius: 14, padding: "28px 24px",
          background: "color-mix(in srgb, var(--brand) 4%, var(--surface))",
        }}>
          <div className="text-sm font-semibold mb-1" style={{ color: "var(--text)" }}>
            Bem-vindo ao JLMirror 👋
          </div>
          <p className="text-xs mb-5" style={{ color: "var(--text-muted)" }}>
            Nenhuma fonte de monitoramento conectada. Configure sua primeira fonte para começar.
          </p>
          <div className="grid gap-3 sm:grid-cols-3 mb-5">
            {[
              { Icon: Activity, label: "1. Adicionar fonte", desc: "Conecte Zabbix ao JLMirror", page: "/monitoring" },
              { Icon: Bell, label: "2. Definir políticas", desc: "Configure regras de alerta e escalonamento", page: "/policies" },
              { Icon: Zap, label: "3. Configurar automação", desc: "Crie respostas automáticas a incidentes", page: "/automation" },
            ].map(({ Icon, label, desc, page }) => (
              <Link key={label} to={page} style={{
                display: "flex", alignItems: "flex-start", gap: 12, padding: "14px",
                background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10,
                textDecoration: "none", color: "inherit", transition: "border-color 0.15s",
              }}
                onMouseEnter={(e) => (e.currentTarget.style.borderColor = "var(--brand)")}
                onMouseLeave={(e) => (e.currentTarget.style.borderColor = "var(--border)")}>
                <div style={{
                  width: 30, height: 30, borderRadius: 7, flexShrink: 0,
                  background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                  display: "flex", alignItems: "center", justifyContent: "center",
                }}>
                  <Icon size={14} style={{ color: "var(--brand)" }} />
                </div>
                <div>
                  <div className="text-xs font-semibold mb-0.5" style={{ color: "var(--text)" }}>{label}</div>
                  <div className="text-[11px]" style={{ color: "var(--text-muted)" }}>{desc}</div>
                </div>
              </Link>
            ))}
          </div>
          <Link to="/monitoring" style={{
            display: "inline-flex", alignItems: "center", gap: 6,
            fontSize: 12, fontWeight: 500, color: "var(--brand)", textDecoration: "none",
          }}>
            Ir para Monitoramento <ArrowRight size={13} />
          </Link>
        </div>
      )}

      {/* Ordered panels */}
      {cfg.order.map((key) => renderPanel(key))}

      {!anyVisible && (
        <div className="text-center py-16 text-[var(--text-muted)] text-sm">
          Nenhum widget visível. Clique em Personalizar para reativar.
        </div>
      )}
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number | string; color: string }) {
  return (
    <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-xl p-3">
      <div className="text-xl font-semibold tabular-nums" style={{ color }}>{value}</div>
      <div className="text-xs text-[var(--text-muted)] mt-0.5">{label}</div>
    </div>
  );
}
