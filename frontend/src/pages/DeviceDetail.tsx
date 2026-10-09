import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  LineChart, Line, AreaChart, Area,
  XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer, CartesianGrid,
} from "recharts";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface Interface {
  interfaceid: string;
  interface_type: string;
  main: boolean;
  use_ip: boolean;
  ip?: string;
  dns?: string;
  port?: string;
}

interface Inventory {
  os?: string; os_full?: string;
  vendor?: string; model?: string; device_type?: string;
  hardware?: string; hardware_full?: string;
  software?: string; software_full?: string;
  serial_primary?: string; serial_secondary?: string;
  asset_tag?: string; location?: string;
  mac_primary?: string; mac_secondary?: string;
  contact?: string;
  poc_1_name?: string; poc_1_email?: string; poc_1_phone?: string;
  poc_2_name?: string; poc_2_email?: string; poc_2_phone?: string;
  site_city?: string; site_rack?: string; site_notes?: string;
  url_a?: string; url_b?: string; url_c?: string;
}

interface Evidence {
  host_status?: string;
  agent_availability?: string;
  snmp_availability?: string;
  ipmi_availability?: string;
  jmx_availability?: string;
  agent_error?: string;
  snmp_error?: string;
  maintenance_status?: string;
  maintenance_type?: string;
  inventory?: Inventory;
  interfaces?: Interface[];
  groups?: { ref: string; name?: string }[];
  templates?: { ref: string; name?: string }[];
  tags?: { tag: string; value: string }[];
}

interface ResourceDetail {
  monitoring_resource_id: string;
  monitoring_source_id: string;
  display_name?: string;
  resource_kind?: string;
  scope_state?: string;
  scope_evidence_state?: string;
  presence_state?: string;
  presence_evidence_state?: string;
  last_observed_at?: string;
  last_confirmed_present_at?: string;
  provider_external_ref?: string;
  created_at?: string;
  updated_at?: string;
  normalized_evidence?: Evidence;
}

interface MetricState {
  metric_definition_id: string;
  monitoring_resource_id: string;
  observed_at?: string;
  value_kind: string;
  value?: unknown;
  name: string;
  unit?: string;
}

interface Problem {
  monitoring_problem_id: string;
  summary?: string;
  severity_class?: string;
  opened_at?: string;
  resolved_at?: string;
  monitoring_resource_id?: string;
}

interface HistoryPoint {
  observed_at: string;
  value?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const PERIODS = [
  { key: "1h",  label: "1h",  sec: 3_600 },
  { key: "6h",  label: "6h",  sec: 21_600 },
  { key: "12h", label: "12h", sec: 43_200 },
  { key: "24h", label: "24h", sec: 86_400 },
  { key: "7d",  label: "7d",  sec: 604_800 },
] as const;

type PeriodKey = (typeof PERIODS)[number]["key"];

// Patterns used to identify headline metrics for the Overview section.
// Matches common Zabbix template metric names (case-insensitive).
const RX_CPU     = /cpu.*(util|usage|load|percent)/i;
const RX_MEM     = /mem.*(util|usage|used|available|free|percent)/i;
const RX_DISK    = /(disk|storage|filesystem|fs).*(util|used|free|space|percent|%)/i;
const RX_NET_IN  = /interface.*(in|received|rx).*bit|bit.*(receiv|in)\b/i;
const RX_NET_OUT = /interface.*(out|sent|tx).*bit|bit.*(sent|out)\b/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("pt-BR"); } catch { return iso; }
}

function fmtTsShort(iso?: string) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  } catch { return iso; }
}

function cleanUnit(unit?: string): string | undefined {
  return unit?.startsWith("!") ? unit.slice(1) : unit;
}

function fmtBytes(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_099_511_627_776) return `${(n / 1_099_511_627_776).toFixed(2)} TB`;
  if (abs >= 1_073_741_824)    return `${(n / 1_073_741_824).toFixed(2)} GB`;
  if (abs >= 1_048_576)        return `${(n / 1_048_576).toFixed(2)} MB`;
  if (abs >= 1_024)            return `${(n / 1_024).toFixed(2)} KB`;
  return `${n} B`;
}

function fmtNumber(n: number, rawUnit?: string): string {
  const unit = cleanUnit(rawUnit);
  if (unit === "B") return fmtBytes(n);
  const rounded = parseFloat(n.toFixed(2));
  const formatted = rounded.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
  return unit ? `${formatted} ${unit}` : formatted;
}

function fmtTick(n: number, rawUnit?: string): string {
  const unit = cleanUnit(rawUnit);
  if (unit === "B") {
    const abs = Math.abs(n);
    if (abs >= 1_073_741_824) return `${(n / 1_073_741_824).toFixed(1)}G`;
    if (abs >= 1_048_576)     return `${(n / 1_048_576).toFixed(1)}M`;
    if (abs >= 1_024)         return `${(n / 1_024).toFixed(1)}K`;
    return `${n}`;
  }
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return parseFloat(n.toFixed(2)).toString();
}

function fmtMetricValue(value: unknown, rawUnit?: string): string {
  if (value === null || value === undefined || typeof value !== "object") return "—";
  const v = value as Record<string, unknown>;
  if ("n" in v) {
    const n = Number(v.n);
    if (isNaN(n)) return "—";
    return fmtNumber(n, rawUnit);
  }
  if ("s" in v) return String(v.s).slice(0, 80);
  return "—";
}

function isZeroValue(m: MetricState): boolean {
  const v = m.value;
  if (!v || typeof v !== "object") return true;
  const rec = v as Record<string, unknown>;
  if ("n" in rec) return Number(rec.n) === 0;
  return false;
}

function toChartData(points: HistoryPoint[]): { t: number; v: number }[] {
  return points
    .filter(p => p.value && typeof p.value === "object" && "n" in p.value)
    .map(p => ({
      t: new Date(p.observed_at).getTime(),
      v: Number((p.value as { n: number }).n),
    }));
}

function availVariant(a?: string): "success" | "warning" | "danger" | "muted" {
  if (a === "available") return "success";
  if (a === "unavailable") return "danger";
  return "muted";
}

function availLabel(a?: string): string {
  if (a === "available") return "online";
  if (a === "unavailable") return "offline";
  return "desconhecido";
}

function sevVariant(s?: string): "danger" | "warning" | "info" | "muted" {
  if (s === "critical") return "danger";
  if (s === "degraded" || s === "warning") return "warning";
  if (s === "informational") return "info";
  return "muted";
}

function isNumeric(m: MetricState): boolean {
  return m.value_kind === "number" || m.value_kind === "integer";
}

function makeTickFmt(periodSec: number) {
  return (t: number) => {
    const d = new Date(t);
    if (periodSec <= 86_400) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    return d.toLocaleDateString([], { month: "short", day: "numeric" });
  };
}

// ---------------------------------------------------------------------------
// KV row
// ---------------------------------------------------------------------------

function KV({ label, value }: { label: string; value?: React.ReactNode }) {
  if (value === undefined || value === null || value === "") return null;
  return (
    <div className="flex gap-2 py-1 border-b border-[var(--border)] last:border-0 text-xs">
      <dt className="w-28 flex-shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className="text-[var(--text)] break-all">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-metric line chart
// ---------------------------------------------------------------------------

function MetricChart({
  sourceId, metricId, unit, period,
}: {
  sourceId: string;
  metricId: string;
  unit?: string;
  period: PeriodKey;
}) {
  const periodSec = PERIODS.find(p => p.key === period)?.sec ?? 86_400;
  const q = useQuery({
    queryKey: ["metric-history", sourceId, metricId, period],
    queryFn: () => {
      const till = Math.floor(Date.now() / 1000);
      const from = till - periodSec;
      return api.get<{ items: HistoryPoint[] }>(
        `/api/v1/monitoring/sources/${sourceId}/metrics/${metricId}/history?window_from=${from}&window_till=${till}`,
      );
    },
  });

  if (q.isLoading) return <div className="flex justify-center py-6"><Spinner className="w-4 h-4" /></div>;
  if (q.isError || !q.data?.items?.length) {
    return <p className="text-xs text-[var(--text-muted)] text-center py-4">Sem dados no período.</p>;
  }

  const data = toChartData(q.data.items);
  if (data.length === 0) {
    return <p className="text-xs text-[var(--text-muted)] text-center py-4">Sem valores numéricos.</p>;
  }

  const tickFmt = makeTickFmt(periodSec);

  return (
    <ResponsiveContainer width="100%" height={140}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <defs>
          <linearGradient id={`grad-${metricId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--brand)" stopOpacity={0.25} />
            <stop offset="95%" stopColor="var(--brand)" stopOpacity={0} />
          </linearGradient>
        </defs>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="t" tickFormatter={tickFmt}
          tick={{ fontSize: 10, fill: "var(--text-muted)" }}
          tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }}
          tickLine={false} axisLine={false} width={42}
          tickFormatter={(v: number) => fmtTick(v, unit)} />
        <Tooltip
          contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
          labelFormatter={(t) => new Date(Number(t)).toLocaleString("pt-BR")}
          formatter={(v) => [fmtNumber(Number(v), unit), ""]}
        />
        <Area type="monotone" dataKey="v" stroke="var(--brand)"
          fill={`url(#grad-${metricId})`} dot={false} strokeWidth={1.5} activeDot={{ r: 3 }} />
      </AreaChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Dual-line chart (network in / out)
// ---------------------------------------------------------------------------

function DualLineChart({
  sourceId, metricIdIn, metricIdOut, unitIn, period,
}: {
  sourceId: string;
  metricIdIn: string;
  metricIdOut: string;
  unitIn?: string;
  period: PeriodKey;
}) {
  const periodSec = PERIODS.find(p => p.key === period)?.sec ?? 86_400;
  const opts = {
    queryFn: (mid: string) => {
      const till = Math.floor(Date.now() / 1000);
      const from = till - periodSec;
      return api.get<{ items: HistoryPoint[] }>(
        `/api/v1/monitoring/sources/${sourceId}/metrics/${mid}/history?window_from=${from}&window_till=${till}`,
      );
    },
  };

  const inQ  = useQuery({ queryKey: ["metric-history", sourceId, metricIdIn, period],  queryFn: () => opts.queryFn(metricIdIn) });
  const outQ = useQuery({ queryKey: ["metric-history", sourceId, metricIdOut, period], queryFn: () => opts.queryFn(metricIdOut) });

  if (inQ.isLoading || outQ.isLoading) {
    return <div className="flex justify-center py-6"><Spinner className="w-4 h-4" /></div>;
  }

  // Merge by timestamp — align on the nearest second
  const inMap = new Map<number, number>();
  toChartData(inQ.data?.items ?? []).forEach(p => inMap.set(p.t, p.v));
  const outMap = new Map<number, number>();
  toChartData(outQ.data?.items ?? []).forEach(p => outMap.set(p.t, p.v));

  const allTs = Array.from(new Set([...inMap.keys(), ...outMap.keys()])).sort((a, b) => a - b);
  const data = allTs.map(t => ({ t, in: inMap.get(t), out: outMap.get(t) }));

  if (data.length === 0) {
    return <p className="text-xs text-[var(--text-muted)] text-center py-4">Sem dados no período.</p>;
  }

  const tickFmt = makeTickFmt(periodSec);

  return (
    <ResponsiveContainer width="100%" height={160}>
      <LineChart data={data} margin={{ top: 4, right: 8, left: 0, bottom: 4 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
        <XAxis dataKey="t" tickFormatter={tickFmt}
          tick={{ fontSize: 10, fill: "var(--text-muted)" }}
          tickLine={false} axisLine={false} minTickGap={40} />
        <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }}
          tickLine={false} axisLine={false} width={42}
          tickFormatter={(v: number) => fmtTick(v, unitIn)} />
        <Tooltip
          contentStyle={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, fontSize: 12 }}
          labelFormatter={(t) => new Date(Number(t)).toLocaleString("pt-BR")}
          formatter={(v, name) => [fmtNumber(Number(v), unitIn), name === "in" ? "Entrada" : "Saída"]}
        />
        <Legend formatter={(val) => val === "in" ? "Entrada" : "Saída"}
          wrapperStyle={{ fontSize: 11 }} />
        <Line type="monotone" dataKey="in"  stroke="var(--brand)"   dot={false} strokeWidth={1.5} activeDot={{ r: 3 }} />
        <Line type="monotone" dataKey="out" stroke="var(--orange)"  dot={false} strokeWidth={1.5} activeDot={{ r: 3 }} />
      </LineChart>
    </ResponsiveContainer>
  );
}

// ---------------------------------------------------------------------------
// Overview chart card (always visible — headline metric)
// ---------------------------------------------------------------------------

function OverviewChartCard({
  title, value, unit, children,
}: {
  title: string;
  value?: string;
  unit?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-3">
      <div className="flex items-baseline justify-between mb-1 gap-2">
        <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wider truncate">{title}</span>
        {value && (
          <span className="text-lg font-semibold tabular-nums text-[var(--text)] whitespace-nowrap">
            {value}{unit ? <span className="text-xs font-normal text-[var(--text-muted)] ml-1">{cleanUnit(unit)}</span> : null}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric card (click to expand in the "all metrics" grid)
// ---------------------------------------------------------------------------

function MetricCard({
  metric, sourceId, period, expanded, onToggle,
}: {
  metric: MetricState;
  sourceId: string;
  period: PeriodKey;
  expanded: boolean;
  onToggle: () => void;
}) {
  const displayValue = fmtMetricValue(metric.value, metric.unit);
  const numeric = isNumeric(metric);

  return (
    <div
      className={[
        "rounded-xl border p-3 transition-colors",
        numeric ? "cursor-pointer hover:border-[var(--brand)]" : "",
        expanded ? "border-[var(--brand)] bg-[var(--surface-2)]" : "border-[var(--border)] bg-[var(--surface)]",
      ].join(" ")}
      onClick={numeric ? onToggle : undefined}
    >
      <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1 truncate">
        {metric.name}
      </div>
      <div className="text-xl font-semibold tabular-nums text-[var(--text)] leading-none">
        {displayValue}
      </div>
      {metric.observed_at && (
        <div className="text-[10px] text-[var(--text-muted)] mt-1.5">
          {fmtTs(metric.observed_at)}
        </div>
      )}
      {expanded && numeric && (
        <div className="mt-3 -mx-1">
          <MetricChart
            sourceId={sourceId}
            metricId={metric.metric_definition_id}
            unit={metric.unit}
            period={period}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period picker (shared control)
// ---------------------------------------------------------------------------

function PeriodPicker({ value, onChange }: { value: PeriodKey; onChange: (k: PeriodKey) => void }) {
  return (
    <div className="flex items-center gap-1">
      {PERIODS.map(p => (
        <button
          key={p.key}
          onClick={() => onChange(p.key)}
          className={[
            "px-2 py-1 rounded text-xs transition-colors",
            value === p.key
              ? "bg-[var(--brand)] text-white"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          ].join(" ")}
        >
          {p.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function DeviceDetail({
  tenantId: _tenantId,
  sourceId,
  resourceId,
  onBack,
}: {
  tenantId: string;
  sourceId: string;
  resourceId: string;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const [period, setPeriod] = useState<PeriodKey>("24h");
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [hideZeros, setHideZeros] = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const layoutSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Layout persistence ────────────────────────────────────────────────────

  const layoutQ = useQuery({
    queryKey: ["device-layout", resourceId],
    queryFn: () =>
      api.get<{ layout: { expanded?: string[]; period?: PeriodKey; hideZeros?: boolean } }>(
        `/api/v1/layout?view_type=device_panel&view_key=${encodeURIComponent(resourceId)}`,
      ),
    staleTime: Infinity,
  });

  // Restore layout from server on first load
  useEffect(() => {
    if (!layoutQ.data?.layout) return;
    const l = layoutQ.data.layout;
    if (l.expanded) setExpanded(new Set(l.expanded));
    if (l.period)   setPeriod(l.period);
    if (l.hideZeros !== undefined) setHideZeros(l.hideZeros);
  }, [layoutQ.data]);

  function saveLayout(next: { expanded?: Set<string>; period?: PeriodKey; hideZeros?: boolean }) {
    if (layoutSaveTimeout.current) clearTimeout(layoutSaveTimeout.current);
    layoutSaveTimeout.current = setTimeout(() => {
      const payload = {
        expanded: [...(next.expanded ?? expanded)],
        period:    next.period    ?? period,
        hideZeros: next.hideZeros ?? hideZeros,
      };
      api.put(`/api/v1/layout?view_type=device_panel&view_key=${encodeURIComponent(resourceId)}`,
              { layout: payload }).catch(() => {/* best-effort */});
    }, 800);
  }

  // ── Queries ───────────────────────────────────────────────────────────────

  const resourceQ = useQuery({
    queryKey: ["resource-detail", sourceId, resourceId],
    queryFn: () =>
      api.get<ResourceDetail>(
        `/api/v1/monitoring/sources/${sourceId}/resources/${resourceId}`,
      ),
  });

  const currentQ = useQuery({
    queryKey: ["resource-current", sourceId, resourceId],
    queryFn: () =>
      api.get<{ items: MetricState[] }>(
        `/api/v1/monitoring/sources/${sourceId}/resources/${resourceId}/current`,
      ),
    refetchInterval: 60_000,
  });

  // Track last successful refresh (onSuccess removed in TanStack Query v5)
  useEffect(() => {
    if (currentQ.isSuccess) setLastRefreshed(new Date());
  }, [currentQ.dataUpdatedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  const problemsQ = useQuery({
    queryKey: ["resource-problems", sourceId, resourceId],
    queryFn: () =>
      api.get<{ items: Problem[] }>(
        `/api/v1/monitoring/sources/${sourceId}/resources/${resourceId}/problems`,
      ),
    refetchInterval: 60_000,
  });

  // ── Actions ───────────────────────────────────────────────────────────────

  function toggleMetric(id: string) {
    setExpanded(prev => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      saveLayout({ expanded: next });
      return next;
    });
  }

  function changePeriod(k: PeriodKey) {
    setPeriod(k);
    saveLayout({ period: k });
  }

  function changeHideZeros(v: boolean) {
    setHideZeros(v);
    saveLayout({ hideZeros: v });
  }

  async function handleRefresh() {
    await Promise.all([
      qc.invalidateQueries({ queryKey: ["resource-current", sourceId, resourceId] }),
      qc.invalidateQueries({ queryKey: ["resource-problems", sourceId, resourceId] }),
    ]);
    setLastRefreshed(new Date());
  }

  // ── Loading / error states ────────────────────────────────────────────────

  if (resourceQ.isLoading) {
    return <div className="flex justify-center py-16"><Spinner /></div>;
  }
  if (resourceQ.isError || !resourceQ.data) {
    return (
      <div>
        <button onClick={onBack} className="text-xs text-[var(--brand)] hover:underline mb-3 block">
          ← Inventário
        </button>
        <p className="text-xs text-[var(--red)]">Falha ao carregar dispositivo.</p>
      </div>
    );
  }

  // ── Data derivation ───────────────────────────────────────────────────────

  const r   = resourceQ.data;
  const ev  = r.normalized_evidence;
  const inv = ev?.inventory;
  const primaryIface = ev?.interfaces?.find(i => i.main) ?? ev?.interfaces?.[0];
  const allMetrics   = currentQ.data?.items ?? [];
  const metrics      = hideZeros ? allMetrics.filter(m => !isZeroValue(m)) : allMetrics;
  const problems     = problemsQ.data?.items ?? [];
  const activeProblems = problems.filter(p => !p.resolved_at);

  const agentAvail  = ev?.agent_availability;
  const inMaintenance = ev?.maintenance_status === "active";
  const isDisabled  = ev?.host_status === "disabled";

  // Headline metric detection
  const numericMetrics = allMetrics.filter(isNumeric);
  const cpuMetric   = numericMetrics.find(m => RX_CPU.test(m.name));
  const memMetric   = numericMetrics.find(m => RX_MEM.test(m.name));
  const diskMetric  = numericMetrics.find(m => RX_DISK.test(m.name));
  const netInMetric  = numericMetrics.find(m => RX_NET_IN.test(m.name));
  const netOutMetric = numericMetrics.find(m => RX_NET_OUT.test(m.name));

  const hasOverview = cpuMetric || memMetric || diskMetric || (netInMetric && netOutMetric);

  // Metrics excluded from the "all metrics" grid if already shown in Overview
  const overviewIds = new Set([
    cpuMetric?.metric_definition_id,
    memMetric?.metric_definition_id,
    diskMetric?.metric_definition_id,
    netInMetric?.metric_definition_id,
    netOutMetric?.metric_definition_id,
  ].filter(Boolean) as string[]);

  const gridMetrics = metrics.filter(m => !overviewIds.has(m.metric_definition_id));

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* ── Header ── */}
      <div className="flex flex-wrap items-center gap-2">
        <button
          onClick={onBack}
          className="text-xs text-[var(--brand)] cursor-pointer hover:underline bg-none border-none p-0"
        >
          ← Inventário
        </button>
        <h2 className="text-sm font-semibold truncate max-w-xs">
          {r.display_name ?? r.monitoring_resource_id}
        </h2>
        <Badge variant={availVariant(agentAvail)}>
          {availLabel(agentAvail)}
        </Badge>
        {inMaintenance && (
          <Badge variant="warning">
            Em manutenção{ev?.maintenance_type === "no_data" ? " (sem coleta)" : ""}
          </Badge>
        )}
        {isDisabled  && <Badge variant="muted">Desabilitado</Badge>}
        {r.presence_state === "removed" && <Badge variant="muted">Removido</Badge>}
        <div className="ml-auto flex items-center gap-3">
          {lastRefreshed && (
            <span className="text-[10px] text-[var(--text-muted)]">
              Atualizado às {fmtTsShort(lastRefreshed.toISOString())}
            </span>
          )}
          <button
            onClick={handleRefresh}
            disabled={currentQ.isFetching}
            className="flex items-center gap-1 px-2 py-1 text-xs rounded border border-[var(--border)]
                       text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--brand)]
                       transition-colors disabled:opacity-50"
            title="Atualizar métricas e problemas"
          >
            {currentQ.isFetching ? <Spinner className="w-3 h-3" /> : "↻"} Atualizar
          </button>
        </div>
      </div>

      {/* ── Overview section ── */}
      {hasOverview && (
        <Card>
          <CardHeader>
            <span className="text-sm font-medium">Visão Geral</span>
            <PeriodPicker value={period} onChange={changePeriod} />
          </CardHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {cpuMetric && (
              <OverviewChartCard
                title="CPU"
                value={fmtMetricValue(cpuMetric.value, cpuMetric.unit)}
                unit={cpuMetric.unit}
              >
                <MetricChart sourceId={sourceId} metricId={cpuMetric.metric_definition_id}
                             unit={cpuMetric.unit} period={period} />
              </OverviewChartCard>
            )}

            {memMetric && (
              <OverviewChartCard
                title="Memória"
                value={fmtMetricValue(memMetric.value, memMetric.unit)}
                unit={memMetric.unit}
              >
                <MetricChart sourceId={sourceId} metricId={memMetric.metric_definition_id}
                             unit={memMetric.unit} period={period} />
              </OverviewChartCard>
            )}

            {diskMetric && (
              <OverviewChartCard
                title="Disco"
                value={fmtMetricValue(diskMetric.value, diskMetric.unit)}
                unit={diskMetric.unit}
              >
                <MetricChart sourceId={sourceId} metricId={diskMetric.metric_definition_id}
                             unit={diskMetric.unit} period={period} />
              </OverviewChartCard>
            )}

            {netInMetric && netOutMetric && (
              <OverviewChartCard title="Rede (entrada / saída)">
                <DualLineChart
                  sourceId={sourceId}
                  metricIdIn={netInMetric.metric_definition_id}
                  metricIdOut={netOutMetric.metric_definition_id}
                  unitIn={netInMetric.unit}
                  period={period}
                />
              </OverviewChartCard>
            )}
          </div>
        </Card>
      )}

      {/* ── Identity ── */}
      {(inv || primaryIface) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader><span className="text-sm font-medium">Identificação</span></CardHeader>
            <dl>
              <KV label="Endereço IP"  value={primaryIface?.ip} />
              <KV label="DNS"          value={primaryIface?.dns} />
              <KV label="Porta"        value={primaryIface?.port} />
              <KV label="Protocolo"    value={primaryIface?.interface_type} />
              <KV label="Sistema op."  value={inv?.os_full ?? inv?.os} />
              <KV label="Fabricante"   value={inv?.vendor} />
              <KV label="Modelo"       value={inv?.model} />
              <KV label="Tipo"         value={inv?.device_type} />
              <KV label="Hardware"     value={inv?.hardware_full ?? inv?.hardware} />
              <KV label="Serial"       value={inv?.serial_primary} />
              <KV label="Asset tag"    value={inv?.asset_tag} />
              <KV label="MAC primário" value={inv?.mac_primary} />
              <KV label="MAC secundário" value={inv?.mac_secondary} />
              <KV label="Último visto" value={fmtTs(r.last_observed_at)} />
            </dl>
          </Card>

          <Card>
            <CardHeader><span className="text-sm font-medium">Localização e contato</span></CardHeader>
            <dl>
              <KV label="Local"          value={inv?.location} />
              <KV label="Rack"           value={inv?.site_rack} />
              <KV label="Cidade"         value={inv?.site_city} />
              <KV label="Observações"    value={inv?.site_notes} />
              <KV label="Contato"        value={inv?.contact} />
              <KV label="Responsável 1"  value={inv?.poc_1_name} />
              <KV label="E-mail 1"       value={inv?.poc_1_email} />
              <KV label="Telefone 1"     value={inv?.poc_1_phone} />
              <KV label="Responsável 2"  value={inv?.poc_2_name} />
              <KV label="E-mail 2"       value={inv?.poc_2_email} />
              {(inv?.url_a || inv?.url_b || inv?.url_c) && (
                <KV
                  label="Acesso remoto"
                  value={
                    <span className="flex flex-wrap gap-2">
                      {inv?.url_a && <a href={inv.url_a} target="_blank" rel="noreferrer" className="text-[var(--brand)] underline">{inv.url_a}</a>}
                      {inv?.url_b && <a href={inv.url_b} target="_blank" rel="noreferrer" className="text-[var(--brand)] underline">{inv.url_b}</a>}
                      {inv?.url_c && <a href={inv.url_c} target="_blank" rel="noreferrer" className="text-[var(--brand)] underline">{inv.url_c}</a>}
                    </span>
                  }
                />
              )}
            </dl>

            {(ev?.interfaces?.length ?? 0) > 1 && (
              <>
                <div className="mt-4 mb-2 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wider">
                  Interfaces
                </div>
                {ev!.interfaces!.map(iface => (
                  <div key={iface.interfaceid}
                    className="text-xs flex gap-2 py-1 border-b border-[var(--border)] last:border-0">
                    <span className="text-[var(--text-muted)] w-12">{iface.interface_type}</span>
                    <span className="text-[var(--text)]">{iface.ip || iface.dns || "—"}</span>
                    {iface.main && <span className="text-[var(--text-muted)]">(primário)</span>}
                  </div>
                ))}
              </>
            )}

            {ev?.agent_error && (
              <div className="mt-3 p-2 rounded-lg bg-[#3a1a1a] border border-[#4a2020]">
                <p className="text-xs text-[var(--red)]">Erro agente: {ev.agent_error}</p>
              </div>
            )}
            {ev?.snmp_error && (
              <div className="mt-2 p-2 rounded-lg bg-[#3a1a1a] border border-[#4a2020]">
                <p className="text-xs text-[var(--red)]">Erro SNMP: {ev.snmp_error}</p>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── Groups / tags ── */}
      {((ev?.groups?.length ?? 0) > 0 || (ev?.tags?.length ?? 0) > 0) && (
        <Card>
          <div className="flex flex-wrap gap-2">
            {ev?.groups?.map(g => (
              <span key={g.ref}
                className="text-xs px-2 py-0.5 rounded-full bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-muted)]">
                {g.name ?? g.ref}
              </span>
            ))}
            {ev?.tags?.map(t => (
              <span key={`${t.tag}:${t.value}`}
                className="text-xs px-2 py-0.5 rounded-full bg-[var(--surface-2)] border border-[var(--border)] text-[var(--brand)]">
                {t.tag}{t.value ? `: ${t.value}` : ""}
              </span>
            ))}
          </div>
        </Card>
      )}

      {/* ── All metrics grid ── */}
      {allMetrics.length > 0 && (
        <Card>
          <CardHeader>
            <span className="text-sm font-medium">
              Todas as métricas
              <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                {gridMetrics.length}
                {hideZeros && gridMetrics.length < allMetrics.length - overviewIds.size
                  ? ` / ${allMetrics.length - overviewIds.size}`
                  : ""}
              </span>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => changeHideZeros(!hideZeros)}
                className={[
                  "px-2 py-1 rounded text-xs transition-colors border",
                  hideZeros
                    ? "border-[var(--brand)] text-[var(--brand)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
                ].join(" ")}
                title="Mostrar ou ocultar métricas com valor zero"
              >
                {hideZeros ? "≠ 0" : "= 0"}
              </button>
              {!hasOverview && <PeriodPicker value={period} onChange={changePeriod} />}
            </div>
          </CardHeader>

          {currentQ.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : currentQ.isError ? (
            <p className="text-xs text-[var(--red)]">Falha ao carregar métricas.</p>
          ) : gridMetrics.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)] space-y-2">
              <p>{allMetrics.length - overviewIds.size > 0 ? "Todas as métricas estão com valor zero." : "Nenhuma métrica adicional disponível."}</p>
              {allMetrics.length - overviewIds.size > 0 && (
                <button onClick={() => changeHideZeros(false)} className="text-[var(--brand)] hover:underline">
                  Mostrar todas
                </button>
              )}
            </div>
          ) : (
            <>
              <p className="text-xs text-[var(--text-muted)] mb-3">
                Clique em uma métrica numérica para ver o gráfico histórico.
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-3">
                {gridMetrics.map(m => (
                  <MetricCard
                    key={m.metric_definition_id}
                    metric={m}
                    sourceId={sourceId}
                    period={period}
                    expanded={expanded.has(m.metric_definition_id)}
                    onToggle={() => toggleMetric(m.metric_definition_id)}
                  />
                ))}
              </div>
            </>
          )}
        </Card>
      )}

      {/* ── Active problems ── */}
      <Card>
        <CardHeader>
          <span className="text-sm font-medium">Problemas ativos</span>
          {activeProblems.length > 0 && (
            <Badge variant="danger">{activeProblems.length}</Badge>
          )}
        </CardHeader>

        {problemsQ.isLoading ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : activeProblems.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">Nenhum problema ativo.</p>
        ) : (
          <ul className="space-y-2">
            {activeProblems.map(p => (
              <li key={p.monitoring_problem_id}
                className="flex items-start gap-2 border-b border-[var(--border)] last:border-0 pb-2 last:pb-0">
                <Badge variant={sevVariant(p.severity_class)} className="mt-0.5 flex-shrink-0">
                  {(p.severity_class ?? "?").toUpperCase()}
                </Badge>
                <div className="min-w-0">
                  <p className="text-xs text-[var(--text)]">{p.summary ?? "—"}</p>
                  <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                    Aberto {fmtTs(p.opened_at)}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
