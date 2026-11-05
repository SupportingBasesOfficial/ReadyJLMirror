import { useState, useRef, useEffect, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import {
  GripVertical, X, Plus, LayoutGrid, Check,
  Bell, AlertTriangle, Activity, Users,
  Wifi, GitBranch, Shield, RefreshCw,
  Monitor, Tv, Smartphone,
} from "lucide-react";

type DeviceType = "pc" | "tv" | "mobile";

// ── Widget types ──────────────────────────────────────────────────────────────

type WidgetType =
  | "alerts_summary"
  | "incidents_open"
  | "sla_breaches"
  | "oncall_now"
  | "alerts_feed"
  | "synthetic_health"
  | "sources_status"
  | "changes_pending";

interface WidgetMeta {
  label: string;
  icon: React.ElementType;
  span: 1 | 3;
  description: string;
}

const CATALOG: Record<WidgetType, WidgetMeta> = {
  alerts_summary:   { label: "Alertas por Severidade", icon: Bell,          span: 1, description: "Contagem de alertas abertos por nível" },
  incidents_open:   { label: "Incidentes Abertos",     icon: AlertTriangle,  span: 1, description: "Total de incidentes em andamento" },
  sla_breaches:     { label: "Brechas de SLA",          icon: Shield,         span: 1, description: "Violações de SLA nas últimas 24h" },
  oncall_now:       { label: "Plantão Agora",            icon: Users,          span: 1, description: "Quem está de plantão neste momento" },
  alerts_feed:      { label: "Feed de Alertas",          icon: Bell,           span: 3, description: "Alertas mais recentes" },
  synthetic_health: { label: "Saúde Sintética",          icon: Activity,       span: 3, description: "Status dos checks HTTP periódicos" },
  sources_status:   { label: "Status das Fontes",        icon: Wifi,           span: 3, description: "Estado das fontes de monitoramento" },
  changes_pending:  { label: "Mudanças Pendentes",       icon: GitBranch,      span: 3, description: "RFCs aguardando aprovação ou em rascunho" },
};

const DEFAULT_WIDGETS: WidgetType[] = [
  "alerts_summary", "incidents_open", "sla_breaches", "oncall_now",
  "alerts_feed", "synthetic_health",
];

// ── Layout API ────────────────────────────────────────────────────────────────

interface LayoutResponse {
  layout: { widgets?: WidgetType[] };
}

function useLayoutApi(tenantId: string, deviceType: DeviceType) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading } = useQuery<LayoutResponse>({
    queryKey: ["custom-dashboard-layout", tenantId, deviceType],
    queryFn: () => api.get<LayoutResponse>(`/api/v1/layout?view_type=dashboard&view_key=${deviceType}`),
    staleTime: Infinity,
  });

  const saveMutation = useMutation({
    mutationFn: (widgets: WidgetType[]) =>
      api.put(`/api/v1/layout?view_type=dashboard&view_key=${deviceType}`, { layout: { widgets } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["custom-dashboard-layout", tenantId, deviceType] });
      toast("Layout salvo.", "success");
    },
    onError: () => toast("Erro ao salvar layout.", "error"),
  });

  const widgets: WidgetType[] =
    data?.layout?.widgets && data.layout.widgets.length > 0
      ? data.layout.widgets
      : DEFAULT_WIDGETS;

  return { widgets, isLoading, save: saveMutation.mutate, saving: saveMutation.isPending };
}

// ── Stat widget base ──────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color }: {
  label: string; value: string | number; sub?: string; color?: string;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">{label}</div>
      <div className="text-3xl font-bold" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="text-[11px] text-[var(--text-muted)]">{sub}</div>}
    </div>
  );
}

// ── Widget: alerts_summary ────────────────────────────────────────────────────

interface RawAlert {
  source_evidence_summary?: { severity_class?: string };
  lifecycle_state: string;
}

function AlertsSummaryWidget({ tenantId }: { tenantId: string }) {
  const { data, isLoading, refetch } = useQuery<RawAlert[]>({
    queryKey: ["dash-alerts-summary", tenantId],
    queryFn: () => api.get(`/api/v1/alerting/alerts?lifecycle_state=open&limit=200&tenant_id=${tenantId}`),
    refetchInterval: 60_000,
  });
  const alerts = data ?? [];
  const count = (cls: string) => alerts.filter(a => a.source_evidence_summary?.severity_class === cls).length;
  const critical = count("critical");
  const degraded = count("degraded") + count("warning");
  const info = count("informational");
  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Alertas abertos</span>
        <button onClick={() => refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
      </div>
      {isLoading ? <Spinner className="w-4 h-4" /> : (
        <div className="flex gap-4 flex-wrap">
          <StatCard label="Total" value={alerts.length} />
          <StatCard label="Críticos" value={critical} color={critical > 0 ? "#ef4444" : undefined} />
          <StatCard label="Degradados" value={degraded} color={degraded > 0 ? "#f59e0b" : undefined} />
          <StatCard label="Info" value={info} />
        </div>
      )}
    </div>
  );
}

// ── Widget: incidents_open ────────────────────────────────────────────────────

function IncidentsOpenWidget({ tenantId }: { tenantId: string }) {
  const { data, isLoading, refetch } = useQuery<{ incident_id: string; severity_class?: string }[]>({
    queryKey: ["dash-incidents-open", tenantId],
    queryFn: () => api.get(`/api/v1/alerting/incidents?state=open&limit=100&tenant_id=${tenantId}`),
    refetchInterval: 60_000,
  });
  const incidents = data ?? [];
  const critical = incidents.filter(i => i.severity_class === "critical").length;
  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Incidentes abertos</span>
        <button onClick={() => refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
      </div>
      {isLoading ? <Spinner className="w-4 h-4" /> : (
        <div className="flex gap-4 flex-wrap">
          <StatCard label="Total" value={incidents.length} />
          <StatCard label="Críticos" value={critical} color={critical > 0 ? "#ef4444" : undefined} />
        </div>
      )}
    </div>
  );
}

// ── Widget: sla_breaches ──────────────────────────────────────────────────────

interface SlaBreach { breach_id: string; slo_name?: string; started_at?: string }

function SlaBreachesWidget({ tenantId }: { tenantId: string }) {
  const { data, isLoading, refetch } = useQuery<SlaBreach[]>({
    queryKey: ["dash-sla-breaches", tenantId],
    queryFn: () => api.get(`/api/v1/sla/breaches?tenant_id=${tenantId}`),
    refetchInterval: 120_000,
  });
  const breaches = data ?? [];
  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Brechas de SLA</span>
        <button onClick={() => refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
      </div>
      {isLoading ? <Spinner className="w-4 h-4" /> : (
        <StatCard label="Brechas ativas" value={breaches.length} color={breaches.length > 0 ? "#ef4444" : "#10b981"} />
      )}
    </div>
  );
}

// ── Widget: oncall_now ────────────────────────────────────────────────────────

interface OncallEntry { schedule_name: string; display_name?: string; principal_id: string }

function OncallNowWidget({ tenantId }: { tenantId: string }) {
  const { data, isLoading, refetch } = useQuery<OncallEntry[]>({
    queryKey: ["dash-oncall-now", tenantId],
    queryFn: () => api.get(`/api/v1/oncall/current?tenant_id=${tenantId}`),
    refetchInterval: 60_000,
  });
  const entries = data ?? [];
  return (
    <div className="flex flex-col gap-3 h-full">
      <div className="flex items-center justify-between">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Plantão agora</span>
        <button onClick={() => refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
      </div>
      {isLoading ? <Spinner className="w-4 h-4" /> : entries.length === 0 ? (
        <span className="text-[12px] text-[var(--text-muted)]">Ninguém em plantão</span>
      ) : (
        <div className="flex flex-col gap-1">
          {entries.map(e => (
            <div key={e.principal_id} className="text-[12px]">
              <span className="font-medium">{e.display_name ?? e.principal_id}</span>
              <span className="text-[var(--text-muted)]"> — {e.schedule_name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Widget: alerts_feed ───────────────────────────────────────────────────────

function AlertsFeedWidget({ tenantId }: { tenantId: string }) {
  const { data, isLoading, refetch } = useQuery<RawAlert[]>({
    queryKey: ["dash-alerts-feed", tenantId],
    queryFn: () => api.get(`/api/v1/alerting/alerts?lifecycle_state=open&limit=10&tenant_id=${tenantId}`),
    refetchInterval: 30_000,
  });
  const alerts = (data ?? []) as (RawAlert & { alert_id: string; monitoring_resource_id: string; opened_at: string })[];
  function sevColor(cls?: string) {
    if (cls === "critical") return "#ef4444";
    if (cls === "degraded" || cls === "warning") return "#f59e0b";
    return "#6b7280";
  }
  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Alertas recentes</span>
        <button onClick={() => refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
      </div>
      {isLoading ? <Spinner className="w-4 h-4" /> : alerts.length === 0 ? (
        <span className="text-[12px] text-[var(--text-muted)]">Nenhum alerta aberto.</span>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[var(--text-muted)] border-b border-[var(--border)]">
                <th className="text-left pb-1 font-medium">Recurso</th>
                <th className="text-left pb-1 font-medium">Severidade</th>
                <th className="text-left pb-1 font-medium">Aberto em</th>
              </tr>
            </thead>
            <tbody>
              {alerts.map(a => {
                const sev = a.source_evidence_summary?.severity_class;
                return (
                  <tr key={a.alert_id} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-1 pr-3 truncate max-w-[200px]">{a.monitoring_resource_id || "—"}</td>
                    <td className="py-1 pr-3">
                      <span className="text-[10px] font-semibold uppercase" style={{ color: sevColor(sev) }}>
                        {sev ?? "—"}
                      </span>
                    </td>
                    <td className="py-1 text-[var(--text-muted)]">{new Date(a.opened_at).toLocaleString("pt-BR")}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Widget: synthetic_health ──────────────────────────────────────────────────

interface SyntheticCheck {
  check_id: string; name: string; url: string; enabled: boolean;
  last_ok: boolean | null; last_response_ms: number | null;
}

function SyntheticHealthWidget({ tenantId }: { tenantId: string }) {
  const { data, isLoading, refetch } = useQuery<SyntheticCheck[]>({
    queryKey: ["dash-synthetic", tenantId],
    queryFn: () => api.get(`/api/v1/synthetic/checks?tenant_id=${tenantId}`),
    refetchInterval: 30_000,
  });
  const checks = data ?? [];
  const ok = checks.filter(c => c.last_ok === true).length;
  const fail = checks.filter(c => c.last_ok === false).length;
  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between mb-1">
        <div className="flex items-center gap-3">
          <span className="text-[12px] font-medium text-[var(--text-muted)]">Saúde sintética</span>
          {!isLoading && (
            <span className="text-[11px]">
              <span className="text-[#10b981] font-medium">{ok} OK</span>
              {fail > 0 && <span className="text-[#ef4444] font-medium ml-2">{fail} FALHA</span>}
            </span>
          )}
        </div>
        <button onClick={() => refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
      </div>
      {isLoading ? <Spinner className="w-4 h-4" /> : checks.length === 0 ? (
        <span className="text-[12px] text-[var(--text-muted)]">Nenhum check sintético configurado.</span>
      ) : (
        <div className="flex flex-wrap gap-2">
          {checks.map(c => (
            <div key={c.check_id} className="flex items-center gap-1.5 border border-[var(--border)] rounded px-2 py-1">
              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{
                background: c.last_ok === true ? "#10b981" : c.last_ok === false ? "#ef4444" : "#6b7280"
              }} />
              <span className="text-[11px] truncate max-w-[140px]">{c.name}</span>
              {c.last_response_ms != null && (
                <span className="text-[10px] text-[var(--text-muted)]">{c.last_response_ms}ms</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Widget: sources_status ────────────────────────────────────────────────────

interface Source {
  monitoring_source_id: string; display_name: string;
  operational_evidence_state: string;
}

function SourcesStatusWidget({ tenantId }: { tenantId: string }) {
  const { data, isLoading, refetch } = useQuery<Source[]>({
    queryKey: ["dash-sources", tenantId],
    queryFn: () => api.get(`/api/v1/monitoring/sources?tenant_id=${tenantId}`),
    refetchInterval: 60_000,
  });
  const sources = data ?? [];
  function stateColor(s: string) {
    if (s === "ok" || s === "operational") return "#10b981";
    if (s === "problem" || s === "degraded") return "#ef4444";
    if (s === "warning") return "#f59e0b";
    return "#6b7280";
  }
  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Fontes de monitoramento</span>
        <button onClick={() => refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
      </div>
      {isLoading ? <Spinner className="w-4 h-4" /> : sources.length === 0 ? (
        <span className="text-[12px] text-[var(--text-muted)]">Nenhuma fonte configurada.</span>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-[12px]">
            <thead>
              <tr className="text-[var(--text-muted)] border-b border-[var(--border)]">
                <th className="text-left pb-1 font-medium">Nome</th>
                <th className="text-left pb-1 font-medium">Estado</th>
              </tr>
            </thead>
            <tbody>
              {sources.map(s => (
                <tr key={s.monitoring_source_id} className="border-b border-[var(--border)] last:border-0">
                  <td className="py-1 pr-4 truncate max-w-[300px]">{s.display_name}</td>
                  <td className="py-1">
                    <span className="text-[10px] font-semibold uppercase"
                      style={{ color: stateColor(s.operational_evidence_state) }}>
                      {s.operational_evidence_state}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Widget: changes_pending ───────────────────────────────────────────────────

interface Rfc { rfc_id: string; title: string; state: string; risk?: string }

function ChangesPendingWidget({ tenantId }: { tenantId: string }) {
  const { data, isLoading, refetch } = useQuery<Rfc[]>({
    queryKey: ["dash-changes-pending", tenantId],
    queryFn: () => api.get(`/api/v1/itsm/changes?tenant_id=${tenantId}`),
    refetchInterval: 120_000,
  });
  const items = (data ?? []).filter(r => ["draft", "pending_approval", "review"].includes(r.state));
  function riskColor(r?: string) {
    if (r === "high") return "#ef4444";
    if (r === "medium") return "#f59e0b";
    return "#6b7280";
  }
  return (
    <div className="flex flex-col gap-2 h-full">
      <div className="flex items-center justify-between mb-1">
        <span className="text-[12px] font-medium text-[var(--text-muted)]">Mudanças pendentes ({items.length})</span>
        <button onClick={() => refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]"><RefreshCw size={12} /></button>
      </div>
      {isLoading ? <Spinner className="w-4 h-4" /> : items.length === 0 ? (
        <span className="text-[12px] text-[var(--text-muted)]">Nenhuma mudança pendente.</span>
      ) : (
        <div className="flex flex-col gap-1">
          {items.slice(0, 8).map(r => (
            <div key={r.rfc_id} className="flex items-center gap-2 text-[12px]">
              <span className="text-[10px] font-semibold uppercase text-[var(--text-muted)] w-[80px] flex-shrink-0">{r.state}</span>
              <span className="truncate flex-1">{r.title}</span>
              {r.risk && (
                <span className="text-[10px] font-semibold uppercase flex-shrink-0" style={{ color: riskColor(r.risk) }}>{r.risk}</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Widget renderer ───────────────────────────────────────────────────────────

function WidgetContent({ type, tenantId }: { type: WidgetType; tenantId: string }) {
  switch (type) {
    case "alerts_summary":   return <AlertsSummaryWidget tenantId={tenantId} />;
    case "incidents_open":   return <IncidentsOpenWidget tenantId={tenantId} />;
    case "sla_breaches":     return <SlaBreachesWidget tenantId={tenantId} />;
    case "oncall_now":       return <OncallNowWidget tenantId={tenantId} />;
    case "alerts_feed":      return <AlertsFeedWidget tenantId={tenantId} />;
    case "synthetic_health": return <SyntheticHealthWidget tenantId={tenantId} />;
    case "sources_status":   return <SourcesStatusWidget tenantId={tenantId} />;
    case "changes_pending":  return <ChangesPendingWidget tenantId={tenantId} />;
  }
}

// ── Drag-and-drop grid ────────────────────────────────────────────────────────

function WidgetGrid({ widgets, editMode, onRemove, onReorder, tenantId }: {
  widgets: WidgetType[];
  editMode: boolean;
  onRemove: (type: WidgetType) => void;
  onReorder: (newOrder: WidgetType[]) => void;
  tenantId: string;
}) {
  const dragIdx = useRef<number | null>(null);
  const [dropIdx, setDropIdx] = useState<number | null>(null);

  function handleDragStart(e: React.DragEvent, idx: number) {
    dragIdx.current = idx;
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent, idx: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setDropIdx(idx);
  }

  function handleDrop(e: React.DragEvent, targetIdx: number) {
    e.preventDefault();
    const from = dragIdx.current;
    if (from === null || from === targetIdx) { setDropIdx(null); return; }
    const next = [...widgets];
    const [item] = next.splice(from, 1);
    next.splice(targetIdx, 0, item);
    onReorder(next);
    dragIdx.current = null;
    setDropIdx(null);
  }

  function handleDragEnd() {
    dragIdx.current = null;
    setDropIdx(null);
  }

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(3, 1fr)",
      gap: "12px",
    }}>
      {widgets.map((type, idx) => {
        const meta = CATALOG[type];
        const isDropTarget = dropIdx === idx && dragIdx.current !== null && dragIdx.current !== idx;
        return (
          <div
            key={type}
            style={{
              gridColumn: `span ${meta.span}`,
              outline: isDropTarget ? "2px solid var(--brand)" : "none",
              opacity: dragIdx.current === idx ? 0.5 : 1,
              cursor: editMode ? "grab" : "default",
              transition: "outline 0.1s, opacity 0.1s",
              borderRadius: "12px",
            }}
            draggable={editMode}
            onDragStart={editMode ? (e) => handleDragStart(e, idx) : undefined}
            onDragOver={editMode ? (e) => handleDragOver(e, idx) : undefined}
            onDrop={editMode ? (e) => handleDrop(e, idx) : undefined}
            onDragEnd={editMode ? handleDragEnd : undefined}
          >
            <Card className={meta.span === 1 ? "min-h-[120px]" : "min-h-[160px]"}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  {editMode && (
                    <GripVertical size={14} className="text-[var(--text-muted)] flex-shrink-0" />
                  )}
                  <span className="text-[12px] font-semibold">{meta.label}</span>
                </div>
                {editMode && (
                  <button
                    onClick={() => onRemove(type)}
                    className="text-[var(--text-muted)] hover:text-[#ef4444] transition-colors flex-shrink-0 ml-2"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <WidgetContent type={type} tenantId={tenantId} />
            </Card>
          </div>
        );
      })}
    </div>
  );
}

// ── Widget catalog panel ──────────────────────────────────────────────────────

function CatalogPanel({ active, onAdd }: {
  active: WidgetType[];
  onAdd: (type: WidgetType) => void;
}) {
  const all = Object.entries(CATALOG) as [WidgetType, WidgetMeta][];
  const available = all.filter(([t]) => !active.includes(t));
  if (available.length === 0) return (
    <div className="text-[12px] text-[var(--text-muted)] mt-2">Todos os widgets já estão ativos.</div>
  );
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: "8px", marginTop: "8px" }}>
      {available.map(([type, meta]) => (
        <button
          key={type}
          onClick={() => onAdd(type)}
          className="flex items-center gap-2 border border-dashed border-[var(--border)] rounded-lg px-3 py-2 text-left hover:border-[var(--brand)] hover:bg-[var(--surface-hover)] transition-colors group"
        >
          <Plus size={14} className="text-[var(--brand)] flex-shrink-0" />
          <div>
            <div className="text-[12px] font-medium">{meta.label}</div>
            <div className="text-[10px] text-[var(--text-muted)]">{meta.description}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const DEVICE_TABS: { type: DeviceType; label: string; icon: React.ElementType }[] = [
  { type: "pc",     label: "PC",     icon: Monitor },
  { type: "tv",     label: "TV",     icon: Tv },
  { type: "mobile", label: "Mobile", icon: Smartphone },
];

interface Props { tenantId: string }

export function CustomDashboardPage({ tenantId }: Props) {
  const [deviceType, setDeviceType] = useState<DeviceType>("pc");
  const { widgets: savedWidgets, isLoading, save, saving } = useLayoutApi(tenantId, deviceType);
  const [widgets, setWidgets] = useState<WidgetType[]>([]);
  const [editMode, setEditMode] = useState(false);

  // Reset edit mode when switching device type
  useEffect(() => {
    setEditMode(false);
  }, [deviceType]);

  useEffect(() => {
    if (!isLoading) setWidgets(savedWidgets);
  }, [isLoading, savedWidgets]);

  const handleRemove = useCallback((type: WidgetType) => {
    setWidgets(prev => prev.filter(w => w !== type));
  }, []);

  const handleAdd = useCallback((type: WidgetType) => {
    setWidgets(prev => [...prev, type]);
  }, []);

  const handleReorder = useCallback((next: WidgetType[]) => {
    setWidgets(next);
  }, []);

  function handleSave() {
    save(widgets);
    setEditMode(false);
  }

  function handleCancel() {
    setWidgets(savedWidgets);
    setEditMode(false);
  }

  return (
    <div className="flex flex-col gap-4 p-6 min-h-full">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold">Meu Dashboard</h1>
          <p className="text-[12px] text-[var(--text-muted)]">Widgets personalizáveis — arraste para reorganizar</p>
        </div>
        <div className="flex items-center gap-2">

          {/* Device type selector */}
          <div style={{ display: "flex", gap: 2, background: "var(--surface-2, #1e2130)", borderRadius: 8, padding: 2 }}>
            {DEVICE_TABS.map(({ type, label, icon: Icon }) => (
              <button
                key={type}
                onClick={() => setDeviceType(type)}
                title={`Layout ${label}`}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 500,
                  background: deviceType === type ? "var(--surface, #252836)" : "none",
                  color: deviceType === type ? "var(--brand, #6366f1)" : "var(--text-muted)",
                  border: deviceType === type ? "1px solid color-mix(in srgb, var(--brand) 30%, transparent)" : "1px solid transparent",
                  cursor: "pointer", transition: "all .15s",
                }}
              >
                <Icon size={12} />
                {label}
              </button>
            ))}
          </div>

          {editMode ? (
            <>
              <button
                onClick={handleCancel}
                className="text-[12px] text-[var(--text-muted)] hover:text-[var(--text)] px-3 py-1.5 rounded border border-[var(--border)] transition-colors"
              >
                Cancelar
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="flex items-center gap-1.5 text-[12px] bg-[var(--brand)] text-white px-3 py-1.5 rounded hover:opacity-90 transition-opacity disabled:opacity-50"
              >
                {saving ? <Spinner className="w-4 h-4" /> : <Check size={13} />}
                Salvar layout
              </button>
            </>
          ) : (
            <button
              onClick={() => setEditMode(true)}
              className="flex items-center gap-1.5 text-[12px] border border-[var(--border)] px-3 py-1.5 rounded hover:bg-[var(--surface-hover)] transition-colors"
            >
              <LayoutGrid size={13} />
              Personalizar
            </button>
          )}
        </div>
      </div>

      {/* Loading state */}
      {isLoading ? (
        <div className="flex items-center justify-center py-16"><Spinner /></div>
      ) : (
        <>
          {/* Widget grid */}
          <WidgetGrid
            widgets={widgets}
            editMode={editMode}
            onRemove={handleRemove}
            onReorder={handleReorder}
            tenantId={tenantId}
          />

          {/* Add widgets catalog (only in edit mode) */}
          {editMode && (
            <div>
              <div className="text-[12px] font-semibold text-[var(--text-muted)] uppercase tracking-wide mt-2">
                Adicionar widget
              </div>
              <CatalogPanel active={widgets} onAdd={handleAdd} />
            </div>
          )}

          {/* Empty state */}
          {widgets.length === 0 && !editMode && (
            <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
              <LayoutGrid size={32} className="text-[var(--text-muted)]" />
              <div className="text-[14px] font-medium">Dashboard vazio</div>
              <div className="text-[12px] text-[var(--text-muted)]">Clique em Personalizar para adicionar widgets.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
