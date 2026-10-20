import { useState, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AreaChart, Area,
  XAxis, YAxis, Tooltip,
  ResponsiveContainer, CartesianGrid,
  ReferenceLine, Brush,
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
  site_address_a?: string; site_state?: string; site_country?: string;
  location_lat?: string; location_lon?: string;
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
// Constants — palette
// ---------------------------------------------------------------------------

const PERIODS = [
  { key: "1h",  label: "1h",  sec: 3_600 },
  { key: "6h",  label: "6h",  sec: 21_600 },
  { key: "12h", label: "12h", sec: 43_200 },
  { key: "24h", label: "24h", sec: 86_400 },
  { key: "7d",  label: "7d",  sec: 604_800 },
] as const;

type PeriodKey = (typeof PERIODS)[number]["key"] | "custom";

interface CustomRange {
  from: number; // unix seconds
  till: number;
}

// Metric accent palette
const ACCENT = {
  cpu:    "#60a5fa", // blue-400
  mem:    "#34d399", // emerald-400
  disk:   "#fb923c", // orange-400
  net_in: "#f59e0b", // amber-400  (yellow)
  net_out:"#a78bfa", // violet-400 (purple)
  default:"#60a5fa",
} as const;

type AccentKey = keyof typeof ACCENT;

// Headline metric regexes
const RX_CPU     = /cpu.*(util|usage|load|percent)/i;
const RX_MEM     = /mem.*(util|usage|used|available|free|percent)/i;
const RX_DISK    = /(disk|storage|filesystem|fs).*(util|used|free|space|percent|%)/i;
const RX_NET_IN  = /interface.*(in|received|rx).*bit|bit.*(receiv|in)\b|interface.*bits.*(receiv|incoming|in\b)/i;
const RX_NET_OUT = /interface.*(out|sent|tx).*bit|bit.*(sent|out)\b|interface.*bits.*(sent|outgoing|out\b)/i;

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

function fmtBits(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} Gbps`;
  if (abs >= 1_000_000)     return `${(n / 1_000_000).toFixed(2)} Mbps`;
  if (abs >= 1_000)         return `${(n / 1_000).toFixed(2)} Kbps`;
  return `${n} bps`;
}

function fmtNumber(n: number, rawUnit?: string): string {
  const unit = cleanUnit(rawUnit);
  if (unit === "B") return fmtBytes(n);
  if (unit === "bps" || rawUnit === "bps") return fmtBits(n);
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
  if (unit === "bps" || rawUnit === "bps") {
    const abs = Math.abs(n);
    if (abs >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}G`;
    if (abs >= 1_000_000)     return `${(n / 1_000_000).toFixed(1)}M`;
    if (abs >= 1_000)         return `${(n / 1_000).toFixed(1)}K`;
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

function sevVariant(s?: string): "danger" | "warning" | "info" | "muted" {
  if (s === "critical") return "danger";
  if (s === "degraded" || s === "warning") return "warning";
  if (s === "informational") return "info";
  return "muted";
}

function isNumeric(m: MetricState): boolean {
  return m.value_kind === "number" || m.value_kind === "integer";
}

function isPercent(unit?: string): boolean {
  const u = cleanUnit(unit);
  return u === "%" || u === "percent";
}

interface Threshold {
  warning?: number;
  critical?: number;
}

function autoThreshold(unit?: string): Threshold | undefined {
  if (isPercent(unit)) return { warning: 80, critical: 95 };
  return undefined;
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
    <div className="flex gap-2 py-1.5 border-b border-[var(--border)] last:border-0 text-xs">
      <dt className="w-28 flex-shrink-0 text-[var(--text-muted)]">{label}</dt>
      <dd className="text-[var(--text)] break-all">{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Period picker (com seleção personalizada de intervalo)
// ---------------------------------------------------------------------------

function toDatetimeLocal(unix: number): string {
  const d = new Date(unix * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function PeriodPicker({
  value, onChange, customRange, onCustomRange,
}: {
  value: PeriodKey;
  onChange: (k: PeriodKey) => void;
  customRange?: CustomRange;
  onCustomRange: (r: CustomRange) => void;
}) {
  const now = Math.floor(Date.now() / 1000);
  const defaultFrom = customRange?.from ?? now - 86_400;
  const defaultTill = customRange?.till ?? now;

  const [draftFrom, setDraftFrom] = useState(toDatetimeLocal(defaultFrom));
  const [draftTill, setDraftTill] = useState(toDatetimeLocal(defaultTill));
  const [open, setOpen]           = useState(false);

  function applyCustom() {
    const from = Math.floor(new Date(draftFrom).getTime() / 1000);
    const till = Math.floor(new Date(draftTill).getTime() / 1000);
    if (!from || !till || from >= till) return;
    onCustomRange({ from, till });
    onChange("custom");
    setOpen(false);
  }

  return (
    <div className="flex flex-wrap items-center gap-0.5 relative">
      <div className="flex items-center gap-0.5 bg-[var(--surface-2)] rounded-lg p-0.5">
        {PERIODS.map(p => (
          <button
            key={p.key}
            onClick={() => { onChange(p.key); setOpen(false); }}
            className={[
              "px-2.5 py-1 rounded-md text-xs font-medium transition-all",
              value === p.key
                ? "bg-[var(--surface)] text-[var(--text)] shadow-sm"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}
          >
            {p.label}
          </button>
        ))}
        <button
          onClick={() => setOpen(o => !o)}
          className={[
            "px-2.5 py-1 rounded-md text-xs font-medium transition-all flex items-center gap-1",
            value === "custom" || open
              ? "bg-[var(--surface)] text-[var(--brand)] shadow-sm"
              : "text-[var(--text-muted)] hover:text-[var(--text)]",
          ].join(" ")}
          title="Selecionar intervalo personalizado"
        >
          <svg width="11" height="11" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="2" y="2" width="12" height="12" rx="2" />
            <line x1="5" y1="1" x2="5" y2="4" /><line x1="11" y1="1" x2="11" y2="4" />
            <line x1="2" y1="6" x2="14" y2="6" />
          </svg>
          {value === "custom" ? "Personalizado" : "…"}
        </button>
      </div>

      {open && (
        <div
          className="absolute top-full right-0 mt-1 z-50 rounded-xl border border-[var(--border)]
                     bg-[var(--surface)] shadow-xl p-3 flex flex-col gap-2 min-w-[260px]"
        >
          <p className="text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-1">
            Intervalo personalizado
          </p>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[var(--text-muted)]">De</span>
            <input
              type="datetime-local"
              value={draftFrom}
              onChange={e => setDraftFrom(e.target.value)}
              className="text-xs rounded-lg border border-[var(--border)] bg-[var(--surface-2)]
                         text-[var(--text)] px-2 py-1 outline-none focus:border-[var(--brand)]"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-[10px] text-[var(--text-muted)]">Até</span>
            <input
              type="datetime-local"
              value={draftTill}
              onChange={e => setDraftTill(e.target.value)}
              className="text-xs rounded-lg border border-[var(--border)] bg-[var(--surface-2)]
                         text-[var(--text)] px-2 py-1 outline-none focus:border-[var(--brand)]"
            />
          </label>
          <div className="flex gap-2 mt-1">
            <button
              onClick={applyCustom}
              className="flex-1 px-3 py-1.5 rounded-lg text-xs font-semibold
                         bg-[var(--brand)] text-white hover:opacity-90 transition-opacity"
            >
              Aplicar
            </button>
            <button
              onClick={() => setOpen(false)}
              className="px-3 py-1.5 rounded-lg text-xs border border-[var(--border)]
                         text-[var(--text-muted)] hover:text-[var(--text)] transition-colors"
            >
              Cancelar
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Custom recharts tooltip
// ---------------------------------------------------------------------------

function ChartTooltip({ active, payload, label, unit, formatter }: {
  active?: boolean;
  payload?: { value: number; name?: string; color?: string; dataKey?: string }[];
  label?: number;
  unit?: string;
  formatter?: (v: number, key?: string) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: "var(--surface)",
      border: "1px solid var(--border)",
      borderRadius: 10,
      padding: "8px 12px",
      fontSize: 12,
      boxShadow: "0 4px 16px rgba(0,0,0,0.3)",
    }}>
      <p style={{ color: "var(--text-muted)", marginBottom: 6 }}>
        {label ? new Date(Number(label)).toLocaleString("pt-BR") : ""}
      </p>
      {payload.map((item, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
          <span style={{ width: 8, height: 8, borderRadius: "50%", background: item.color, flexShrink: 0 }} />
          <span style={{ color: "var(--text)" }}>
            {formatter
              ? formatter(Number(item.value), item.dataKey as string)
              : fmtNumber(Number(item.value), unit)}
          </span>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Single-metric area chart
// ---------------------------------------------------------------------------

function MetricChart({
  sourceId, metricId, unit, period, accent = "default", height = 180,
  thresholds, showBrush = false, windowFrom, windowTill,
}: {
  sourceId: string;
  metricId: string;
  unit?: string;
  period: PeriodKey;
  accent?: AccentKey;
  height?: number;
  thresholds?: Threshold;
  showBrush?: boolean;
  windowFrom?: number;
  windowTill?: number;
}) {
  const periodSec = PERIODS.find(p => p.key === period)?.sec ?? 86_400;
  const color = ACCENT[accent];
  const gradId = `grad-${metricId.replace(/[^a-z0-9]/gi, "")}`;

  const q = useQuery({
    queryKey: ["metric-history", sourceId, metricId, period, windowFrom, windowTill],
    queryFn: () => {
      const till = windowTill ?? Math.floor(Date.now() / 1000);
      const from = windowFrom ?? till - periodSec;
      return api.get<{ items: HistoryPoint[] }>(
        `/api/v1/monitoring/sources/${sourceId}/metrics/${metricId}/history?window_from=${from}&window_till=${till}`,
      );
    },
  });

  const effectivePeriodSec = windowFrom && windowTill ? windowTill - windowFrom : periodSec;

  if (q.isLoading) return <div className="flex justify-center py-6"><Spinner className="w-4 h-4" /></div>;
  if (q.isError || !q.data?.items?.length) {
    return <p className="text-xs text-[var(--text-muted)] text-center py-4">Sem dados no período.</p>;
  }

  const data = toChartData(q.data.items);
  if (data.length === 0) {
    return <p className="text-xs text-[var(--text-muted)] text-center py-4">Sem valores numéricos.</p>;
  }

  const tickFmt = makeTickFmt(effectivePeriodSec);
  const effectiveHeight = showBrush ? height + 40 : height;

  return (
    <div>
      {thresholds && (
        <div className="flex items-center gap-3 mb-2 text-[10px]">
          {thresholds.warning !== undefined && (
            <span className="flex items-center gap-1">
              <span style={{ width: 18, height: 2, background: "#f59e0b", display: "inline-block", borderRadius: 1 }} />
              <span className="text-[var(--text-muted)]">Alerta {thresholds.warning}%</span>
            </span>
          )}
          {thresholds.critical !== undefined && (
            <span className="flex items-center gap-1">
              <span style={{ width: 18, height: 2, background: "#ef4444", display: "inline-block", borderRadius: 1 }} />
              <span className="text-[var(--text-muted)]">Crítico {thresholds.critical}%</span>
            </span>
          )}
        </div>
      )}
      <ResponsiveContainer width="100%" height={effectiveHeight}>
        <AreaChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: showBrush ? 4 : 0 }}>
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={color} stopOpacity={0.35} />
              <stop offset="95%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.5} />
          <XAxis dataKey="t" tickFormatter={tickFmt}
            tick={{ fontSize: 10, fill: "var(--text-muted)" }}
            tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }}
            tickLine={false} axisLine={false} width={44}
            tickFormatter={(v: number) => fmtTick(v, unit)} />
          <Tooltip content={<ChartTooltip unit={unit} />} />
          {thresholds?.warning !== undefined && (
            <ReferenceLine
              y={thresholds.warning}
              stroke="#f59e0b"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{ value: `▲ ${thresholds.warning}%`, position: "insideTopRight",
                fontSize: 9, fill: "#f59e0b", fontWeight: 600 }}
            />
          )}
          {thresholds?.critical !== undefined && (
            <ReferenceLine
              y={thresholds.critical}
              stroke="#ef4444"
              strokeDasharray="4 3"
              strokeWidth={1.5}
              label={{ value: `▲ ${thresholds.critical}%`, position: "insideTopRight",
                fontSize: 9, fill: "#ef4444", fontWeight: 600 }}
            />
          )}
          <Area type="monotone" dataKey="v" stroke={color}
            fill={`url(#${gradId})`} dot={false} strokeWidth={2}
            activeDot={{ r: 4, fill: color, stroke: "var(--surface)", strokeWidth: 2 }} />
          {showBrush && (
            <Brush
              dataKey="t"
              height={24}
              stroke="var(--border)"
              fill="var(--surface-2)"
              travellerWidth={6}
              tickFormatter={tickFmt}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dual network chart — overlapping areas, yellow=in, purple=out
// ---------------------------------------------------------------------------

type NetFocus = "both" | "in" | "out";

function DualNetChart({
  sourceId, metricIdIn, metricIdOut, unitIn, period, windowFrom, windowTill,
}: {
  sourceId: string;
  metricIdIn: string;
  metricIdOut: string;
  unitIn?: string;
  period: PeriodKey;
  windowFrom?: number;
  windowTill?: number;
}) {
  const [focus, setFocus] = useState<NetFocus>("both");
  const periodSec = PERIODS.find(p => p.key === period)?.sec ?? 86_400;
  const effectivePeriodSec = windowFrom && windowTill ? windowTill - windowFrom : periodSec;

  const fetchHistory = (mid: string) => {
    const till = windowTill ?? Math.floor(Date.now() / 1000);
    const from = windowFrom ?? till - periodSec;
    return api.get<{ items: HistoryPoint[] }>(
      `/api/v1/monitoring/sources/${sourceId}/metrics/${mid}/history?window_from=${from}&window_till=${till}`,
    );
  };

  const inQ  = useQuery({ queryKey: ["metric-history", sourceId, metricIdIn,  period, windowFrom, windowTill], queryFn: () => fetchHistory(metricIdIn) });
  const outQ = useQuery({ queryKey: ["metric-history", sourceId, metricIdOut, period, windowFrom, windowTill], queryFn: () => fetchHistory(metricIdOut) });

  if (inQ.isLoading || outQ.isLoading) {
    return <div className="flex justify-center py-6"><Spinner className="w-4 h-4" /></div>;
  }

  const inMap  = new Map<number, number>();
  const outMap = new Map<number, number>();
  toChartData(inQ.data?.items  ?? []).forEach(p => inMap.set(p.t, p.v));
  toChartData(outQ.data?.items ?? []).forEach(p => outMap.set(p.t, p.v));

  const allTs = Array.from(new Set([...inMap.keys(), ...outMap.keys()])).sort((a, b) => a - b);
  const data  = allTs.map(t => ({ t, in: inMap.get(t), out: outMap.get(t) }));

  if (data.length === 0) {
    return <p className="text-xs text-[var(--text-muted)] text-center py-4">Sem dados no período.</p>;
  }

  const tickFmt = makeTickFmt(effectivePeriodSec);

  const inStroke  = ACCENT.net_in;   // amber/yellow
  const outStroke = ACCENT.net_out;  // violet/purple

  const inOpacity  = focus === "out"  ? 0.15 : 1;
  const outOpacity = focus === "in"   ? 0.15 : 1;

  const netFormatter = (v: number, key?: string) =>
    `${key === "in" ? "▼ Entrada" : "▲ Saída"}: ${fmtNumber(v, unitIn)}`;

  return (
    <div>
      {/* Focus toggle */}
      <div className="flex items-center gap-1.5 mb-3">
        {(["both", "in", "out"] as NetFocus[]).map(f => {
          const label = f === "both" ? "Ambos" : f === "in" ? "▼ Entrada" : "▲ Saída";
          const active = focus === f;
          const color  = f === "in" ? inStroke : f === "out" ? outStroke : undefined;
          return (
            <button
              key={f}
              onClick={() => setFocus(f)}
              className="px-2.5 py-1 rounded-md text-xs font-medium transition-all border"
              style={{
                borderColor: active ? (color ?? "var(--brand)") : "var(--border)",
                color:        active ? (color ?? "var(--text)") : "var(--text-muted)",
                background:   active ? `${(color ?? "var(--brand)")}18` : "transparent",
              }}
            >
              {label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-3 text-[11px] text-[var(--text-muted)]">
          <span style={{ color: inStroke  }}>■</span><span>Entrada</span>
          <span style={{ color: outStroke }}>■</span><span>Saída</span>
        </div>
      </div>

      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={data} margin={{ top: 6, right: 4, left: 0, bottom: 0 }}>
          <defs>
            <linearGradient id="grad-net-in" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={inStroke}  stopOpacity={0.4 * inOpacity} />
              <stop offset="95%" stopColor={inStroke}  stopOpacity={0} />
            </linearGradient>
            <linearGradient id="grad-net-out" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%"  stopColor={outStroke} stopOpacity={0.4 * outOpacity} />
              <stop offset="95%" stopColor={outStroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" strokeOpacity={0.5} />
          <XAxis dataKey="t" tickFormatter={tickFmt}
            tick={{ fontSize: 10, fill: "var(--text-muted)" }}
            tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis tick={{ fontSize: 10, fill: "var(--text-muted)" }}
            tickLine={false} axisLine={false} width={48}
            tickFormatter={(v: number) => fmtTick(v, unitIn)} />
          <Tooltip content={<ChartTooltip formatter={netFormatter} />} />
          <Area
            type="monotone" dataKey="in"
            stroke={inStroke} strokeWidth={focus === "in" ? 2.5 : 1.5}
            strokeOpacity={inOpacity}
            fill="url(#grad-net-in)"
            dot={false}
            activeDot={{ r: 4, fill: inStroke, stroke: "var(--surface)", strokeWidth: 2 }}
          />
          <Area
            type="monotone" dataKey="out"
            stroke={outStroke} strokeWidth={focus === "out" ? 2.5 : 1.5}
            strokeOpacity={outOpacity}
            fill="url(#grad-net-out)"
            dot={false}
            activeDot={{ r: 4, fill: outStroke, stroke: "var(--surface)", strokeWidth: 2 }}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview chart card
// ---------------------------------------------------------------------------

function OverviewChartCard({
  title, value, unit, accent, children,
}: {
  title: string;
  value?: string;
  unit?: string;
  accent?: AccentKey;
  children: React.ReactNode;
}) {
  const color = accent ? ACCENT[accent] : "var(--brand)";
  return (
    <div
      className="rounded-xl border bg-[var(--surface)] p-4 flex flex-col gap-2"
      style={{ borderColor: `${color}30` }}
    >
      <div className="flex items-center justify-between gap-2">
        <span
          className="text-[11px] font-semibold uppercase tracking-widest"
          style={{ color }}
        >
          {title}
        </span>
        {value && (
          <span className="text-2xl font-bold tabular-nums text-[var(--text)]">
            {value}
            {unit && (
              <span className="text-xs font-normal text-[var(--text-muted)] ml-1">
                {cleanUnit(unit)}
              </span>
            )}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sparkline — tiny inline chart for MetricCard
// ---------------------------------------------------------------------------

function Sparkline({
  sourceId, metricId, unit, period, color,
}: {
  sourceId: string;
  metricId: string;
  unit?: string;
  period: PeriodKey;
  color: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); obs.disconnect(); } },
      { threshold: 0.1 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const periodSec = PERIODS.find(p => p.key === period)?.sec ?? 86_400;

  const q = useQuery({
    queryKey: ["metric-history", sourceId, metricId, period],
    queryFn: () => {
      const till = Math.floor(Date.now() / 1000);
      const from = till - periodSec;
      return api.get<{ items: HistoryPoint[] }>(
        `/api/v1/monitoring/sources/${sourceId}/metrics/${metricId}/history?window_from=${from}&window_till=${till}&limit=40`,
      );
    },
    enabled: visible,
    staleTime: 60_000,
  });

  const data = q.data?.items ? toChartData(q.data.items) : [];
  const gradId = `spark-${metricId.replace(/[^a-z0-9]/gi, "")}`;

  return (
    <div ref={ref} style={{ height: 36, marginTop: 4 }}>
      {q.isLoading && (
        <div style={{ height: 36, background: `${color}08`, borderRadius: 4 }} />
      )}
      {data.length > 0 && (
        <ResponsiveContainer width="100%" height={36}>
          <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={color} stopOpacity={0.4} />
                <stop offset="95%" stopColor={color} stopOpacity={0} />
              </linearGradient>
            </defs>
            {isPercent(unit) && (
              <>
                <ReferenceLine y={95} stroke="#ef4444" strokeDasharray="3 2" strokeWidth={1} />
                <ReferenceLine y={80} stroke="#f59e0b" strokeDasharray="3 2" strokeWidth={1} />
              </>
            )}
            <Area type="monotone" dataKey="v" stroke={color} strokeWidth={1.5}
              fill={`url(#${gradId})`} dot={false} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric card (click to expand)
// ---------------------------------------------------------------------------

function MetricCard({
  metric, sourceId, period, expanded, onToggle, windowFrom, windowTill,
}: {
  metric: MetricState;
  sourceId: string;
  period: PeriodKey;
  expanded: boolean;
  onToggle: () => void;
  windowFrom?: number;
  windowTill?: number;
}) {
  const displayValue = fmtMetricValue(metric.value, metric.unit);
  const numeric = isNumeric(metric);
  const sparkColor = ACCENT.default;

  // Detect out-of-range percentage values (e.g. Zabbix delta items)
  const rawN = (() => {
    if (!metric.value || typeof metric.value !== "object") return null;
    const v = metric.value as Record<string, unknown>;
    return "n" in v ? Number(v.n) : null;
  })();
  const isPct = isPercent(metric.unit);
  const outOfRange = isPct && rawN !== null && (rawN < 0 || rawN > 100);

  return (
    <div
      className={[
        "rounded-xl border p-3 transition-all select-none",
        numeric ? "cursor-pointer hover:border-[var(--brand)] hover:shadow-md" : "",
        expanded
          ? "border-[var(--brand)] bg-[var(--surface-2)] shadow-md col-span-2"
          : "border-[var(--border)] bg-[var(--surface)]",
      ].join(" ")}
      style={{ transition: "border-color .15s, box-shadow .15s" }}
      onClick={numeric ? onToggle : undefined}
    >
      <div className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider mb-1.5 truncate leading-tight">
        {metric.name}
      </div>
      <div className="flex items-center gap-1.5">
        <div className="text-xl font-bold tabular-nums leading-none"
          style={{ color: outOfRange ? "var(--text-warning, #b45309)" : expanded ? "var(--brand)" : "var(--text)" }}>
          {displayValue}
        </div>
        {outOfRange && (
          <span title={`Valor fora do intervalo esperado (0–100%). Verifique a configuração do item na fonte de monitoramento.`}
            style={{ fontSize: 13, cursor: "help", color: "var(--text-warning, #b45309)" }}>
            ⚠
          </span>
        )}
      </div>
      {metric.observed_at && (
        <div className="text-[10px] text-[var(--text-muted)] mt-1.5 font-mono">
          {fmtTsShort(metric.observed_at)}
        </div>
      )}
      {!expanded && numeric && (
        <Sparkline
          sourceId={sourceId}
          metricId={metric.metric_definition_id}
          unit={metric.unit}
          period={period}
          color={sparkColor}
        />
      )}
      {expanded && numeric && (
        <div className="mt-4 -mx-1">
          <MetricChart
            sourceId={sourceId}
            metricId={metric.metric_definition_id}
            unit={metric.unit}
            period={period}
            height={200}
            thresholds={autoThreshold(metric.unit)}
            showBrush
            windowFrom={windowFrom}
            windowTill={windowTill}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Severity color bar for problems
// ---------------------------------------------------------------------------

function SevBar({ sev }: { sev?: string }) {
  const colors: Record<string, string> = {
    critical: "#ef4444",
    warning:  "#f59e0b",
    degraded: "#f97316",
    informational: "#60a5fa",
  };
  return (
    <div style={{
      width: 3, borderRadius: 2, flexShrink: 0, alignSelf: "stretch",
      background: colors[sev ?? ""] ?? "var(--border)",
    }} />
  );
}

// ---------------------------------------------------------------------------
// Status dot (with pulse for online)
// ---------------------------------------------------------------------------

function StatusDot({ avail }: { avail?: string }) {
  const color = avail === "available" ? "#22c55e"
    : avail === "unavailable" ? "#ef4444"
    : "#6b7280";
  const pulse = avail === "available";

  return (
    <span style={{ position: "relative", display: "inline-flex", alignItems: "center" }}>
      {pulse && (
        <span style={{
          position: "absolute", inset: 0, borderRadius: "50%",
          background: color, opacity: 0.4,
          animation: "pulse-ring 1.5s ease-out infinite",
        }} />
      )}
      <span style={{
        width: 10, height: 10, borderRadius: "50%", background: color,
        display: "inline-block", flexShrink: 0,
      }} />
      <style>{`
        @keyframes pulse-ring {
          0% { transform: scale(1); opacity: .4; }
          100% { transform: scale(2.4); opacity: 0; }
        }
      `}</style>
    </span>
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
  const [period, setPeriod]             = useState<PeriodKey>("24h");
  const [customRange, setCustomRange]   = useState<CustomRange | undefined>();
  const [expanded, setExpanded]         = useState<Set<string>>(new Set());
  const [hideZeros, setHideZeros]       = useState(true);
  const [lastRefreshed, setLastRefreshed] = useState<Date | null>(null);
  const layoutSaveTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);

  const chartWindowFrom = period === "custom" ? customRange?.from : undefined;
  const chartWindowTill = period === "custom" ? customRange?.till : undefined;

  // Layout persistence
  const layoutQ = useQuery({
    queryKey: ["device-layout", resourceId],
    queryFn: () =>
      api.get<{ layout: { expanded?: string[]; period?: PeriodKey; hideZeros?: boolean } }>(
        `/api/v1/layout?view_type=device_panel&view_key=${encodeURIComponent(resourceId)}`,
      ),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!layoutQ.data?.layout) return;
    const l = layoutQ.data.layout;
    if (l.expanded)  setExpanded(new Set(l.expanded));
    if (l.period)    setPeriod(l.period);
    if (l.hideZeros !== undefined) setHideZeros(l.hideZeros);
  }, [layoutQ.data]);

  function saveLayout(next: { expanded?: Set<string>; period?: PeriodKey; hideZeros?: boolean }) {
    if (layoutSaveTimeout.current) clearTimeout(layoutSaveTimeout.current);
    layoutSaveTimeout.current = setTimeout(() => {
      const payload = {
        expanded:  [...(next.expanded  ?? expanded)],
        period:     next.period    ?? period,
        hideZeros:  next.hideZeros ?? hideZeros,
      };
      api.put(
        `/api/v1/layout?view_type=device_panel&view_key=${encodeURIComponent(resourceId)}`,
        { layout: payload },
      ).catch(() => {});
    }, 800);
  }

  // Queries
  const resourceQ = useQuery({
    queryKey: ["resource-detail", sourceId, resourceId],
    queryFn: () =>
      api.get<ResourceDetail>(`/api/v1/monitoring/sources/${sourceId}/resources/${resourceId}`),
  });

  const currentQ = useQuery({
    queryKey: ["resource-current", sourceId, resourceId],
    queryFn: () =>
      api.get<{ items: MetricState[] }>(
        `/api/v1/monitoring/sources/${sourceId}/resources/${resourceId}/current`,
      ),
    refetchInterval: 60_000,
  });

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
      qc.invalidateQueries({ queryKey: ["resource-current",  sourceId, resourceId] }),
      qc.invalidateQueries({ queryKey: ["resource-problems", sourceId, resourceId] }),
    ]);
    setLastRefreshed(new Date());
  }

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

  const r   = resourceQ.data;
  const ev  = r.normalized_evidence;
  const inv = ev?.inventory;
  const primaryIface    = ev?.interfaces?.find(i => i.main) ?? ev?.interfaces?.[0];
  const allMetrics      = currentQ.data?.items ?? [];
  const metrics         = hideZeros ? allMetrics.filter(m => !isZeroValue(m)) : allMetrics;
  const problems        = problemsQ.data?.items ?? [];
  const activeProblems  = problems.filter(p => !p.resolved_at);

  const agentAvail    = ev?.agent_availability;
  const inMaintenance = ev?.maintenance_status === "active";
  const isDisabled    = ev?.host_status === "disabled";

  const numericMetrics = allMetrics.filter(isNumeric);
  const cpuMetric      = numericMetrics.find(m => RX_CPU.test(m.name));
  const memMetric      = numericMetrics.find(m => RX_MEM.test(m.name));
  const diskMetric     = numericMetrics.find(m => RX_DISK.test(m.name));
  const netInMetric    = numericMetrics.find(m => RX_NET_IN.test(m.name));
  const netOutMetric   = numericMetrics.find(m => RX_NET_OUT.test(m.name));

  const hasOverview = cpuMetric || memMetric || diskMetric || (netInMetric && netOutMetric);

  const overviewIds = new Set([
    cpuMetric?.metric_definition_id,
    memMetric?.metric_definition_id,
    diskMetric?.metric_definition_id,
    netInMetric?.metric_definition_id,
    netOutMetric?.metric_definition_id,
  ].filter(Boolean) as string[]);

  const gridMetrics = metrics.filter(m => !overviewIds.has(m.metric_definition_id));

  return (
    <div className="space-y-5">

      {/* ── Header ── */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--surface)] p-4">
        {/* Breadcrumb */}
        <button
          onClick={onBack}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--brand)] transition-colors mb-3 flex items-center gap-1"
        >
          ← Inventário
        </button>

        {/* Device name + status */}
        <div className="flex flex-wrap items-center gap-3 mb-4">
          <StatusDot avail={agentAvail} />
          <h2 className="text-lg font-bold text-[var(--text)] truncate">
            {r.display_name ?? r.monitoring_resource_id}
          </h2>
          <Badge variant={availVariant(agentAvail)}>
            {agentAvail === "available" ? "Online" : agentAvail === "unavailable" ? "Offline" : "Desconhecido"}
          </Badge>
          {inMaintenance && (
            <Badge variant="warning">
              Manutenção{ev?.maintenance_type === "no_data" ? " (sem coleta)" : ""}
            </Badge>
          )}
          {isDisabled         && <Badge variant="muted">Desabilitado</Badge>}
          {r.presence_state === "removed" && <Badge variant="muted">Removido</Badge>}
        </div>

        {/* Quick KPIs row */}
        <div className="flex flex-wrap gap-4 text-xs">
          <div className="flex flex-col gap-0.5">
            <span className="text-[var(--text-muted)] uppercase tracking-wide text-[10px]">Problemas ativos</span>
            <span className={`font-bold text-base tabular-nums ${activeProblems.length > 0 ? "text-[var(--red)]" : "text-[var(--text-muted)]"}`}>
              {problemsQ.isLoading ? "…" : activeProblems.length}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-[var(--text-muted)] uppercase tracking-wide text-[10px]">Métricas</span>
            <span className="font-bold text-base tabular-nums text-[var(--text)]">
              {allMetrics.length > 0 ? allMetrics.length : "…"}
            </span>
          </div>
          {primaryIface?.ip && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[var(--text-muted)] uppercase tracking-wide text-[10px]">Endereço IP</span>
              <span className="font-mono font-medium text-[var(--text)]">{primaryIface.ip}</span>
            </div>
          )}
          {inv?.os && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[var(--text-muted)] uppercase tracking-wide text-[10px]">Sistema</span>
              <span className="font-medium text-[var(--text)] truncate max-w-[160px]">{inv.os}</span>
            </div>
          )}
          <div className="ml-auto flex items-center gap-2">
            {lastRefreshed && (
              <span className="text-[10px] text-[var(--text-muted)] font-mono">
                ↻ {fmtTsShort(lastRefreshed.toISOString())}
              </span>
            )}
            <button
              onClick={handleRefresh}
              disabled={currentQ.isFetching}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg border border-[var(--border)]
                         text-[var(--text-muted)] hover:text-[var(--text)] hover:border-[var(--brand)]
                         transition-colors disabled:opacity-50 font-medium"
            >
              {currentQ.isFetching ? <Spinner className="w-3 h-3" /> : "↻"} Atualizar
            </button>
          </div>
        </div>
      </div>

      {/* ── Overview ── */}
      {hasOverview && (
        <Card>
          <CardHeader>
            <span className="text-sm font-semibold">Visão Geral</span>
            <PeriodPicker value={period} onChange={changePeriod}
              customRange={customRange} onCustomRange={setCustomRange} />
          </CardHeader>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {cpuMetric && (
              <OverviewChartCard
                title="CPU"
                value={fmtMetricValue(cpuMetric.value, cpuMetric.unit)}
                unit={cpuMetric.unit}
                accent="cpu"
              >
                <MetricChart sourceId={sourceId} metricId={cpuMetric.metric_definition_id}
                  unit={cpuMetric.unit} period={period} accent="cpu" height={180}
                  thresholds={autoThreshold(cpuMetric.unit)}
                  windowFrom={chartWindowFrom} windowTill={chartWindowTill} />
              </OverviewChartCard>
            )}

            {memMetric && (
              <OverviewChartCard
                title="Memória"
                value={fmtMetricValue(memMetric.value, memMetric.unit)}
                unit={memMetric.unit}
                accent="mem"
              >
                <MetricChart sourceId={sourceId} metricId={memMetric.metric_definition_id}
                  unit={memMetric.unit} period={period} accent="mem" height={180}
                  thresholds={autoThreshold(memMetric.unit)}
                  windowFrom={chartWindowFrom} windowTill={chartWindowTill} />
              </OverviewChartCard>
            )}

            {diskMetric && (
              <OverviewChartCard
                title="Disco"
                value={fmtMetricValue(diskMetric.value, diskMetric.unit)}
                unit={diskMetric.unit}
                accent="disk"
              >
                <MetricChart sourceId={sourceId} metricId={diskMetric.metric_definition_id}
                  unit={diskMetric.unit} period={period} accent="disk" height={180}
                  thresholds={autoThreshold(diskMetric.unit)}
                  windowFrom={chartWindowFrom} windowTill={chartWindowTill} />
              </OverviewChartCard>
            )}

            {netInMetric && netOutMetric && (
              <OverviewChartCard
                title="Rede"
                accent="net_in"
              >
                <DualNetChart
                  sourceId={sourceId}
                  metricIdIn={netInMetric.metric_definition_id}
                  metricIdOut={netOutMetric.metric_definition_id}
                  unitIn={netInMetric.unit}
                  period={period}
                  windowFrom={chartWindowFrom}
                  windowTill={chartWindowTill}
                />
              </OverviewChartCard>
            )}
          </div>
        </Card>
      )}

      {/* ── Identification + Location ── */}
      {(inv || primaryIface) && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <Card>
            <CardHeader><span className="text-sm font-semibold">Identificação</span></CardHeader>
            <dl>
              <KV label="Endereço IP"    value={primaryIface?.ip} />
              <KV label="DNS"            value={primaryIface?.dns} />
              <KV label="Porta"          value={primaryIface?.port} />
              <KV label="Protocolo"      value={primaryIface?.interface_type} />
              <KV label="Sistema op."    value={inv?.os_full ?? inv?.os} />
              <KV label="Fabricante"     value={inv?.vendor} />
              <KV label="Modelo"         value={inv?.model} />
              <KV label="Tipo"           value={inv?.device_type} />
              <KV label="Hardware"       value={inv?.hardware_full ?? inv?.hardware} />
              <KV label="Serial"         value={inv?.serial_primary} />
              <KV label="Asset tag"      value={inv?.asset_tag} />
              <KV label="MAC primário"   value={inv?.mac_primary} />
              <KV label="MAC secundário" value={inv?.mac_secondary} />
              <KV label="Último visto"   value={fmtTs(r.last_observed_at)} />
            </dl>
          </Card>

          <Card>
            <CardHeader><span className="text-sm font-semibold">Localização e contato</span></CardHeader>
            {(() => {
              const hasLocationData = inv && (
                inv.location || inv.site_rack || inv.site_city || inv.site_notes ||
                inv.site_address_a || inv.site_state || inv.site_country ||
                inv.location_lat || inv.location_lon ||
                inv.contact || inv.poc_1_name || inv.poc_1_email || inv.poc_1_phone ||
                inv.poc_2_name || inv.poc_2_email || inv.url_a || inv.url_b || inv.url_c
              );
              if (!hasLocationData) {
                return (
                  <p className="text-xs text-[var(--text-muted)] italic">
                    Nenhum dado de localização cadastrado no inventário do Zabbix.
                  </p>
                );
              }
              const lat = inv?.location_lat ? parseFloat(inv.location_lat) : null;
              const lon = inv?.location_lon ? parseFloat(inv.location_lon) : null;
              const hasCoords = lat !== null && lon !== null && !isNaN(lat) && !isNaN(lon);
              const addressParts = [inv?.site_address_a, inv?.site_city, inv?.site_state, inv?.site_country].filter(Boolean);
              const addressStr = addressParts.join(", ");
              const googleMapsUrl = hasCoords
                ? `https://www.google.com/maps?q=${lat},${lon}`
                : addressStr
                  ? `https://www.google.com/maps/search/${encodeURIComponent(addressStr)}`
                  : null;
              return (
                <>
                  {hasCoords && (
                    <div className="mb-3 rounded-lg overflow-hidden border border-[var(--border)]" style={{ height: 180 }}>
                      <iframe
                        title="Mapa de localização"
                        width="100%"
                        height="180"
                        style={{ border: 0, display: "block" }}
                        src={`https://www.openstreetmap.org/export/embed.html?bbox=${lon - 0.01},${lat - 0.01},${lon + 0.01},${lat + 0.01}&layer=mapnik&marker=${lat},${lon}`}
                        loading="lazy"
                      />
                    </div>
                  )}
                  <dl>
                    <KV label="Local"         value={inv?.location} />
                    <KV label="Endereço"      value={inv?.site_address_a} />
                    <KV label="Estado"        value={inv?.site_state} />
                    <KV label="País"          value={inv?.site_country} />
                    <KV label="Rack"          value={inv?.site_rack} />
                    <KV label="Cidade"        value={inv?.site_city} />
                    {hasCoords && (
                      <KV label="Coordenadas" value={`${lat?.toFixed(6)}, ${lon?.toFixed(6)}`} />
                    )}
                    <KV label="Observações"   value={inv?.site_notes} />
                    <KV label="Contato"       value={inv?.contact} />
                    <KV label="Responsável 1" value={inv?.poc_1_name} />
                    <KV label="E-mail 1"      value={inv?.poc_1_email} />
                    <KV label="Telefone 1"    value={inv?.poc_1_phone} />
                    <KV label="Responsável 2" value={inv?.poc_2_name} />
                    <KV label="E-mail 2"      value={inv?.poc_2_email} />
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
                    {googleMapsUrl && !hasCoords && (
                      <KV
                        label="Ver no mapa"
                        value={<a href={googleMapsUrl} target="_blank" rel="noreferrer" className="text-[var(--brand)] underline text-xs">Abrir no Google Maps</a>}
                      />
                    )}
                  </dl>
                  {hasCoords && googleMapsUrl && (
                    <div className="mt-2">
                      <a href={googleMapsUrl} target="_blank" rel="noreferrer"
                        className="text-xs text-[var(--brand)] underline">
                        Abrir no Google Maps
                      </a>
                    </div>
                  )}
                </>
              );
            })()}

            {(ev?.interfaces?.length ?? 0) > 1 && (
              <>
                <div className="mt-4 mb-2 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                  Interfaces
                </div>
                {ev!.interfaces!.map(iface => (
                  <div key={iface.interfaceid}
                    className="text-xs flex gap-2 py-1.5 border-b border-[var(--border)] last:border-0">
                    <span className="text-[var(--text-muted)] w-14 flex-shrink-0">{iface.interface_type}</span>
                    <span className="text-[var(--text)] font-mono">{iface.ip || iface.dns || "—"}</span>
                    {iface.main && <span className="text-[var(--text-muted)]">(primário)</span>}
                  </div>
                ))}
              </>
            )}

            {ev?.agent_error && (
              <div className="mt-3 p-2.5 rounded-lg bg-[#3a1a1a] border border-[#4a2020]">
                <p className="text-xs text-[var(--red)]">Erro agente: {ev.agent_error}</p>
              </div>
            )}
            {ev?.snmp_error && (
              <div className="mt-2 p-2.5 rounded-lg bg-[#3a1a1a] border border-[#4a2020]">
                <p className="text-xs text-[var(--red)]">Erro SNMP: {ev.snmp_error}</p>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ── Groups / tags ── */}
      {((ev?.groups?.length ?? 0) > 0 || (ev?.tags?.length ?? 0) > 0) && (
        <Card>
          <div className="flex flex-wrap gap-1.5">
            {ev?.groups?.map(g => (
              <span key={g.ref}
                className="text-xs px-2.5 py-1 rounded-full bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-muted)]">
                {g.name ?? g.ref}
              </span>
            ))}
            {ev?.tags?.map(t => (
              <span key={`${t.tag}:${t.value}`}
                className="text-xs px-2.5 py-1 rounded-full border text-[var(--brand)]"
                style={{ borderColor: `${ACCENT.cpu}40`, background: `${ACCENT.cpu}10` }}>
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
            <span className="text-sm font-semibold">
              Todas as métricas
              <span className="ml-2 text-xs font-normal text-[var(--text-muted)]">
                ({gridMetrics.length}
                {hideZeros && gridMetrics.length < allMetrics.length - overviewIds.size
                  ? ` / ${allMetrics.length - overviewIds.size}`
                  : ""})
              </span>
            </span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => changeHideZeros(!hideZeros)}
                className={[
                  "px-2.5 py-1 rounded-lg text-xs font-medium transition-colors border",
                  hideZeros
                    ? "border-[var(--brand)] text-[var(--brand)] bg-[var(--brand-bg,#1e3a5f)]"
                    : "border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text)]",
                ].join(" ")}
              >
                {hideZeros ? "≠ 0" : "= 0"}
              </button>
              {!hasOverview && <PeriodPicker value={period} onChange={changePeriod}
                customRange={customRange} onCustomRange={setCustomRange} />}
            </div>
          </CardHeader>

          {currentQ.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : currentQ.isError ? (
            <p className="text-xs text-[var(--red)]">Falha ao carregar métricas.</p>
          ) : gridMetrics.length === 0 ? (
            <div className="text-xs text-[var(--text-muted)] space-y-2">
              <p>
                {allMetrics.length - overviewIds.size > 0
                  ? "Todas as métricas estão com valor zero."
                  : "Nenhuma métrica adicional disponível."}
              </p>
              {allMetrics.length - overviewIds.size > 0 && (
                <button onClick={() => changeHideZeros(false)} className="text-[var(--brand)] hover:underline">
                  Mostrar todas
                </button>
              )}
            </div>
          ) : (
            <>
              <p className="text-xs text-[var(--text-muted)] mb-3">
                Clique em uma métrica numérica para ver o histórico.
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
                    windowFrom={chartWindowFrom}
                    windowTill={chartWindowTill}
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
          <span className="text-sm font-semibold">Problemas ativos</span>
          {activeProblems.length > 0 && (
            <Badge variant="danger">{activeProblems.length}</Badge>
          )}
        </CardHeader>

        {problemsQ.isLoading ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : activeProblems.length === 0 ? (
          <div className="flex items-center gap-2 py-2">
            <span style={{ color: "#22c55e" }}>✓</span>
            <p className="text-xs text-[var(--text-muted)]">Nenhum problema ativo.</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {activeProblems.map(p => (
              <li key={p.monitoring_problem_id}
                className="flex items-stretch gap-3 rounded-lg overflow-hidden
                           border border-[var(--border)] bg-[var(--surface-2)]">
                <SevBar sev={p.severity_class} />
                <div className="py-2.5 pr-3 flex items-start gap-2.5 min-w-0">
                  <Badge variant={sevVariant(p.severity_class)} className="mt-0.5 flex-shrink-0">
                    {(p.severity_class ?? "?").toUpperCase()}
                  </Badge>
                  <div className="min-w-0">
                    <p className="text-xs text-[var(--text)] leading-snug">{p.summary ?? "—"}</p>
                    <p className="text-[10px] text-[var(--text-muted)] mt-1 font-mono">
                      Aberto {fmtTs(p.opened_at)}
                    </p>
                  </div>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
