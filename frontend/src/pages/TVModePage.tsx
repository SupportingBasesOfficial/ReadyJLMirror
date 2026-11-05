/**
 * TV Mode — full-screen kiosk NOC view for display_principal sessions.
 * No sidebar, no controls. Follows the tenant's NOC template if set by admin.
 * Access via /auth/tv?token=<TV_TOKEN> which sets the session and
 * redirects here.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api/client";
import { useSession } from "@/hooks/useSession";

interface RawAlert {
  alert_id: string;
  lifecycle_state: string;
  source_evidence_summary: { severity_class?: string; problem_id?: string };
  monitoring_resource_id: string;
  opened_at: string;
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
  created_at: string;
}

interface RawRfc {
  rfc_id: string;
  title: string;
  state: string;
  risk?: string;
}

// ── Template types (must match NOCDashboard) ──────────────────────────────────
const STAT_KEYS = ["stat_alerts", "stat_critical", "stat_degraded", "stat_sources"] as const;
const PANEL_KEYS = ["alerts", "sources", "incidents", "changes"] as const;
type StatKey = typeof STAT_KEYS[number];
type PanelKey = typeof PANEL_KEYS[number];
type WidgetKey = StatKey | PanelKey;

interface WidgetConfig {
  visible: Record<WidgetKey, boolean>;
  order: PanelKey[];
}

const DEFAULT_TV_TEMPLATE: WidgetConfig = {
  visible: {
    stat_alerts: true, stat_critical: true, stat_degraded: true, stat_sources: true,
    alerts: true, sources: true, incidents: false, changes: false,
  },
  order: ["alerts", "sources", "incidents", "changes"],
};

function loadTemplate(tenantId: string): WidgetConfig | null {
  try {
    const raw = localStorage.getItem(`jlm_noc_template_${tenantId}`);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<WidgetConfig>;
    return {
      visible: { ...DEFAULT_TV_TEMPLATE.visible, ...(parsed.visible ?? {}) },
      order: parsed.order ?? DEFAULT_TV_TEMPLATE.order,
    };
  } catch { return null; }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function sevColor(cls?: string): string {
  if (cls === "critical") return "var(--red, #ef4444)";
  if (cls === "degraded" || cls === "warning") return "var(--yellow, #f59e0b)";
  return "var(--text-muted, #8b93a5)";
}

function sourceColor(state: string): string {
  if (state === "current") return "var(--green, #22c55e)";
  if (["stale", "incomplete", "reconciliation_required"].includes(state)) return "var(--yellow, #f59e0b)";
  if (state === "unavailable") return "var(--red, #ef4444)";
  return "var(--text-muted, #8b93a5)";
}

function rfcStateLabel(state: string): string {
  const map: Record<string, string> = {
    draft: "Rascunho", review: "Em revisão", approved: "Aprovado",
    scheduled: "Agendado", implementing: "Implementando", complete: "Concluído",
  };
  return map[state] ?? state;
}

function fmtTime(iso?: string): string {
  if (!iso) return "";
  try { return new Date(iso).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" }); } catch { return iso; }
}

function Clock() {
  const [time, setTime] = useState(() => new Date().toLocaleTimeString("pt-BR"));
  useEffect(() => {
    const id = setInterval(() => setTime(new Date().toLocaleTimeString("pt-BR")), 1000);
    return () => clearInterval(id);
  }, []);
  return <span>{time}</span>;
}

const panelStyle: React.CSSProperties = {
  background: "var(--surface, #1a1d27)",
  border: "1px solid var(--border, #262c3a)",
  borderRadius: 16,
  overflow: "hidden",
  display: "flex",
  flexDirection: "column",
};

const panelHeaderStyle: React.CSSProperties = {
  padding: "14px 20px",
  borderBottom: "1px solid var(--border)",
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text-muted)",
  textTransform: "uppercase",
  letterSpacing: "0.08em",
};

// ── Component ─────────────────────────────────────────────────────────────────
export function TVModePage() {
  const { data: session } = useSession();
  const [alerts, setAlerts] = useState<RawAlert[]>([]);
  const [sources, setSources] = useState<RawSource[]>([]);
  const [incidents, setIncidents] = useState<RawIncident[]>([]);
  const [changes, setChanges] = useState<RawRfc[]>([]);
  const [connected, setConnected] = useState(false);
  const [reconnectKey, setReconnectKey] = useState(0);
  const [template, setTemplate] = useState<WidgetConfig | null>(null);
  const esRef = useRef<EventSource | null>(null);

  const tenantId = session?.tenant_id;

  const handleReconnect = useCallback(() => {
    esRef.current?.close();
    setConnected(false);
    setReconnectKey(k => k + 1);
  }, []);

  // Load template from localStorage when tenantId is known
  useEffect(() => {
    if (!tenantId) return;
    const tpl = loadTemplate(tenantId);
    setTemplate(tpl);
  }, [tenantId]);

  // SSE + REST bootstrap — re-runs on manual reconnect
  useEffect(() => {
    void api.get<RawAlert[]>("/api/v1/alerting/alerts?lifecycle_state=active&limit=100")
      .then(setAlerts).catch(() => null);
    void api.get<RawSource[]>("/api/v1/monitoring/sources")
      .then(setSources).catch(() => null);

    let cancelled = false;
    function connect() {
      if (cancelled) return;
      const es = new EventSource("/api/v1/noc/stream");
      esRef.current = es;
      es.onopen = () => { if (!cancelled) setConnected(true); };
      es.onmessage = (ev) => {
        if (cancelled) return;
        try {
          const snap = JSON.parse(ev.data);
          setAlerts(snap.alerts ?? []);
          setSources(snap.sources ?? []);
        } catch { /* */ }
      };
      es.onerror = () => {
        if (cancelled) return;
        es.close();
        setConnected(false);
        setTimeout(connect, 10_000);
      };
    }
    connect();
    return () => { cancelled = true; esRef.current?.close(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reconnectKey]);

  // Poll incidents/changes based on template config
  const cfg = template ?? DEFAULT_TV_TEMPLATE;
  useEffect(() => {
    if (!cfg.visible.incidents) return;
    void api.get<RawIncident[]>("/api/v1/alerting/incidents?limit=20").then(setIncidents).catch(() => null);
    const id = setInterval(() => {
      void api.get<RawIncident[]>("/api/v1/alerting/incidents?limit=20").then(setIncidents).catch(() => null);
    }, 30_000);
    return () => clearInterval(id);
  }, [cfg.visible.incidents]);

  useEffect(() => {
    if (!cfg.visible.changes) return;
    void api.get<RawRfc[]>("/api/v1/itsm/changes?limit=10").then(setChanges).catch(() => null);
    const id = setInterval(() => {
      void api.get<RawRfc[]>("/api/v1/itsm/changes?limit=10").then(setChanges).catch(() => null);
    }, 30_000);
    return () => clearInterval(id);
  }, [cfg.visible.changes]);

  // ── Computed values ─────────────────────────────────────────────────────────
  const critical = alerts.filter(a => a.source_evidence_summary?.severity_class === "critical");
  const degraded = alerts.filter(a => ["degraded", "warning"].includes(a.source_evidence_summary?.severity_class ?? ""));
  const sourcesOk = sources.filter(s => s.operational_evidence_state === "current");
  const openIncidents = incidents.filter(i => ["open", "in_progress"].includes(i.lifecycle_state));
  const activeRfcs = changes.filter(r => !["complete", "cancelled"].includes(r.state));

  const tenantName = session?.tenant?.display_name ?? "NOC";

  // ── KPI tiles ───────────────────────────────────────────────────────────────
  type KpiDef = { label: string; value: string | number; color: string };
  const kpiMap: Record<StatKey, KpiDef> = {
    stat_alerts: {
      label: "Alertas",
      value: alerts.length,
      color: alerts.length > 0 ? "var(--yellow, #f59e0b)" : "var(--green, #22c55e)",
    },
    stat_critical: {
      label: "Críticos",
      value: critical.length,
      color: critical.length > 0 ? "var(--red, #ef4444)" : "var(--green, #22c55e)",
    },
    stat_degraded: {
      label: "Avisos",
      value: degraded.length,
      color: degraded.length > 0 ? "var(--yellow, #f59e0b)" : "var(--green, #22c55e)",
    },
    stat_sources: {
      label: "Fontes",
      value: `${sourcesOk.length}/${sources.length}`,
      color: sourcesOk.length < sources.length && sources.length > 0 ? "var(--yellow, #f59e0b)" : "var(--green, #22c55e)",
    },
  };

  const visibleStats = STAT_KEYS.filter(k => cfg.visible[k]);
  const visiblePanels = cfg.order.filter(k => cfg.visible[k]);
  const panelGridCols = visiblePanels.length <= 1 ? "1fr"
    : visiblePanels.length === 2 ? "2fr 1fr"
    : visiblePanels.length === 3 ? "1fr 1fr 1fr"
    : "1fr 1fr 1fr 1fr";

  // ── Panel renderers ─────────────────────────────────────────────────────────
  function renderTvPanel(key: PanelKey) {
    if (key === "alerts") return (
      <div key="alerts" style={panelStyle}>
        <div style={panelHeaderStyle}>Alertas Ativos ({alerts.length})</div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {alerts.length === 0 ? (
            <div style={{ padding: 32, textAlign: "center", color: "var(--green, #22c55e)", fontSize: 18, fontWeight: 500 }}>
              ✓ Sem alertas ativos
            </div>
          ) : alerts.slice(0, 30).map((a) => (
            <div key={a.alert_id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "12px 20px", borderBottom: "1px solid var(--border, #262c3a)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: sevColor(a.source_evidence_summary?.severity_class) }} />
              <span style={{ fontSize: 14, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {a.source_evidence_summary?.problem_id || a.monitoring_resource_id || a.alert_id?.slice(0, 8)}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                {fmtTime(a.opened_at)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );

    if (key === "sources") return (
      <div key="sources" style={panelStyle}>
        <div style={panelHeaderStyle}>Fontes ({sources.length})</div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {sources.map((s) => (
            <div key={s.monitoring_source_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 20px", borderBottom: "1px solid var(--border, #262c3a)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: sourceColor(s.operational_evidence_state) }} />
              <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {s.display_name}
              </span>
            </div>
          ))}
        </div>
      </div>
    );

    if (key === "incidents") return (
      <div key="incidents" style={panelStyle}>
        <div style={panelHeaderStyle}>Incidentes Abertos ({openIncidents.length})</div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {openIncidents.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--green, #22c55e)", fontSize: 14, fontWeight: 500 }}>
              ✓ Sem incidentes
            </div>
          ) : openIncidents.slice(0, 15).map((i) => (
            <div key={i.incident_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 20px", borderBottom: "1px solid var(--border, #262c3a)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: i.lifecycle_state === "in_progress" ? "var(--yellow, #f59e0b)" : "var(--brand, #6366f1)" }} />
              <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {i.title}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                {fmtTime(i.created_at)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );

    if (key === "changes") return (
      <div key="changes" style={panelStyle}>
        <div style={panelHeaderStyle}>Mudanças ({activeRfcs.length})</div>
        <div style={{ overflowY: "auto", flex: 1 }}>
          {activeRfcs.length === 0 ? (
            <div style={{ padding: 24, textAlign: "center", color: "var(--green, #22c55e)", fontSize: 14, fontWeight: 500 }}>
              ✓ Sem mudanças ativas
            </div>
          ) : activeRfcs.slice(0, 15).map((r) => (
            <div key={r.rfc_id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "11px 20px", borderBottom: "1px solid var(--border, #262c3a)" }}>
              <span style={{ width: 8, height: 8, borderRadius: "50%", flexShrink: 0, background: r.state === "implementing" ? "var(--yellow, #f59e0b)" : "var(--brand, #6366f1)" }} />
              <span style={{ fontSize: 13, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                {r.title}
              </span>
              <span style={{ fontSize: 11, color: "var(--text-muted)", flexShrink: 0 }}>
                {rfcStateLabel(r.state)}
              </span>
            </div>
          ))}
        </div>
      </div>
    );

    return null;
  }

  return (
    <div style={{
      minHeight: "100vh",
      background: "var(--bg, #0f1115)",
      color: "var(--text, #e6e8ec)",
      fontFamily: "system-ui, sans-serif",
      display: "flex",
      flexDirection: "column",
      padding: "20px 28px",
      gap: 20,
      boxSizing: "border-box",
    }}>
      {/* Header bar */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
          <span style={{ fontSize: 22, fontWeight: 700, color: "var(--brand, #6366f1)" }}>
            JL<span style={{ color: "var(--text, #e6e8ec)" }}>Mirror</span>
          </span>
          <span style={{ fontSize: 14, color: "var(--text-muted, #8b93a5)" }}>
            {tenantName} · NOC Display
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--text-muted)" }}>
            <span style={{
              display: "inline-block", width: 8, height: 8, borderRadius: "50%",
              background: connected ? "var(--green, #22c55e)" : "var(--yellow, #f59e0b)",
              boxShadow: connected ? "0 0 6px var(--green, #22c55e)" : "none",
              animation: connected ? "pulse 2s infinite" : "none",
            }} />
            {connected ? "live" : (
              <button
                onClick={handleReconnect}
                style={{
                  background: "none", border: "1px solid var(--yellow, #f59e0b)",
                  borderRadius: 6, color: "var(--yellow, #f59e0b)", cursor: "pointer",
                  fontSize: 11, fontWeight: 500, padding: "2px 8px",
                }}
              >
                Reconectar
              </button>
            )}
          </span>
          <span style={{ fontSize: 28, fontWeight: 600, fontVariantNumeric: "tabular-nums", color: "var(--text)" }}>
            <Clock />
          </span>
        </div>
      </div>

      {/* KPI tiles */}
      {visibleStats.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${visibleStats.length}, 1fr)`, gap: 16 }}>
          {visibleStats.map((key) => {
            const { label, value, color } = kpiMap[key];
            return (
              <div key={key} style={{
                background: "var(--surface, #1a1d27)",
                border: "1px solid var(--border, #262c3a)",
                borderRadius: 16,
                padding: "20px 24px",
                display: "flex",
                flexDirection: "column",
                gap: 6,
              }}>
                <span style={{ fontSize: 13, color: "var(--text-muted)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  {label}
                </span>
                <span style={{ fontSize: 52, fontWeight: 700, lineHeight: 1, color, fontVariantNumeric: "tabular-nums" }}>
                  {value}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Panels */}
      {visiblePanels.length > 0 && (
        <div style={{ display: "grid", gridTemplateColumns: panelGridCols, gap: 16, flex: 1, minHeight: 0 }}>
          {visiblePanels.map((key) => renderTvPanel(key))}
        </div>
      )}

      <style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
      `}</style>
    </div>
  );
}
