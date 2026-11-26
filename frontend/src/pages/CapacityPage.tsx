import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { usePermission } from "@/hooks/useSession";
import {
  Gauge, AlertTriangle, CheckCircle2, XCircle,
  TrendingUp, TrendingDown, Minus, Settings, Trash2, ChevronDown, ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface CapacityMetric {
  metric_name: string;
  value: number | null;
  unit: string;
  sampled_at: string;
  warn_pct: number | null;
  crit_pct: number | null;
  state: "ok" | "warning" | "critical";
}

interface CapacityResource {
  resource_id: string;
  resource_name: string | null;
  metrics: CapacityMetric[];
}

interface Summary {
  ok: number;
  warning: number;
  critical: number;
}

interface Threshold {
  threshold_id: string;
  resource_id: string;
  metric_name: string;
  warn_pct: number;
  crit_pct: number;
  enabled: boolean;
}

interface Forecast {
  resource_id: string;
  metric_name: string;
  current_value: number;
  trend: "increasing" | "decreasing" | "stable";
  forecast: { step: number; value: number }[];
  insufficient_data: boolean;
}

interface TrendPoint {
  bucket: string;
  avg: number | null;
  max: number | null;
}

const METRIC_LABELS: Record<string, string> = {
  cpu: "CPU", memory: "Memória", disk: "Disco", swap: "Swap",
  iops: "IOPS", bandwidth: "Banda", connections: "Conexões", load: "Load",
};

function stateColor(state: string) {
  if (state === "critical") return "text-red-600 dark:text-red-400";
  if (state === "warning") return "text-yellow-600 dark:text-yellow-400";
  return "text-green-600 dark:text-green-400";
}

function barColor(state: string) {
  if (state === "critical") return "bg-red-500";
  if (state === "warning") return "bg-yellow-500";
  return "bg-teal-500";
}

function StateIcon({ state }: { state: string }) {
  if (state === "critical") return <XCircle className="w-4 h-4 text-red-500" />;
  if (state === "warning") return <AlertTriangle className="w-4 h-4 text-yellow-500" />;
  return <CheckCircle2 className="w-4 h-4 text-green-500" />;
}

function MetricBar({ m }: { m: CapacityMetric }) {
  const pct = Math.min(m.value ?? 0, 100);
  return (
    <div className="space-y-0.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-gray-600 dark:text-gray-400">{METRIC_LABELS[m.metric_name] ?? m.metric_name}</span>
        <span className={`font-mono font-medium ${stateColor(m.state)}`}>
          {m.value != null ? `${m.value.toFixed(1)}${m.unit}` : "—"}
        </span>
      </div>
      <div className="bg-gray-200 dark:bg-gray-700 rounded-full h-2 relative">
        <div className={`${barColor(m.state)} h-2 rounded-full transition-all`} style={{ width: `${pct}%` }} />
        {m.warn_pct != null && (
          <div className="absolute top-0 bottom-0 w-px bg-yellow-400/70" style={{ left: `${m.warn_pct}%` }} />
        )}
        {m.crit_pct != null && (
          <div className="absolute top-0 bottom-0 w-px bg-red-400/70" style={{ left: `${m.crit_pct}%` }} />
        )}
      </div>
    </div>
  );
}

function ForecastPanel({ resourceId, metric }: { resourceId: string; metric: string }) {
  const q = useQuery<Forecast>({
    queryKey: ["capacity-forecast", resourceId, metric],
    queryFn: () => api.get<Forecast>(`/api/v1/capacity/forecast?resource_id=${encodeURIComponent(resourceId)}&metric_name=${metric}&hours_ahead=24`),
  });
  const trend = q.data?.trend;
  if (q.isLoading) return <div className="text-xs text-gray-400">Calculando previsão...</div>;
  if (!q.data || q.data.insufficient_data) return <div className="text-xs text-gray-400">Dados insuficientes para previsão (mín. 3 amostras).</div>;
  const peak = Math.max(...q.data.forecast.map(f => f.value));
  return (
    <div className="flex items-center gap-3 text-xs">
      {trend === "increasing" && <TrendingUp className="w-4 h-4 text-red-500" />}
      {trend === "decreasing" && <TrendingDown className="w-4 h-4 text-green-500" />}
      {trend === "stable" && <Minus className="w-4 h-4 text-gray-400" />}
      <span className="text-gray-600 dark:text-gray-400">
        Tendência: <strong className="text-gray-800 dark:text-gray-200">{trend === "increasing" ? "crescente" : trend === "decreasing" ? "decrescente" : "estável"}</strong>
        {" "} · Pico previsto 24h: <strong className={peak >= 90 ? "text-red-600" : peak >= 70 ? "text-yellow-600" : "text-green-600"}>{peak.toFixed(1)}%</strong>
      </span>
    </div>
  );
}

function ThresholdForm({
  resourceId, metricName, existing, onSave, onDelete, saving,
}: {
  resourceId: string;
  metricName: string;
  existing?: Threshold;
  onSave: (data: { resource_id: string; metric_name: string; warn_pct: number; crit_pct: number }) => void;
  onDelete?: (id: string) => void;
  saving: boolean;
}) {
  const [warn, setWarn] = useState(existing?.warn_pct?.toString() ?? "70");
  const [crit, setCrit] = useState(existing?.crit_pct?.toString() ?? "90");
  return (
    <div className="flex items-center gap-2 text-xs flex-wrap">
      <span className="text-gray-500">Alerta</span>
      <input type="number" min="0" max="100" step="1"
        className="w-16 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        value={warn} onChange={e => setWarn(e.target.value)} />
      <span className="text-gray-500">% · Crítico</span>
      <input type="number" min="0" max="100" step="1"
        className="w-16 border border-gray-200 dark:border-gray-700 rounded px-1.5 py-0.5 text-xs bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
        value={crit} onChange={e => setCrit(e.target.value)} />
      <span className="text-gray-500">%</span>
      <Button size="sm" disabled={saving}
        onClick={() => onSave({ resource_id: resourceId, metric_name: metricName, warn_pct: parseFloat(warn), crit_pct: parseFloat(crit) })}
        className="h-6 text-xs bg-teal-700 hover:bg-teal-800 text-white px-2">
        Salvar
      </Button>
      {existing && onDelete && (
        <button onClick={() => onDelete(existing.threshold_id)} className="text-gray-400 hover:text-red-500">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  );
}

export function CapacityPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const canOperate = usePermission("monitoring:operate") || usePermission("tenant:admin");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [configMetric, setConfigMetric] = useState<{ resourceId: string; metricName: string } | null>(null);
  const [hoursFilter, setHoursFilter] = useState(1);

  const summaryQ = useQuery<Summary>({
    queryKey: ["capacity-summary", tenantId],
    queryFn: () => api.get<Summary>("/api/v1/capacity/summary"),
    refetchInterval: 60_000,
  });

  const resourcesQ = useQuery<CapacityResource[]>({
    queryKey: ["capacity-resources", tenantId, hoursFilter],
    queryFn: () => api.get<CapacityResource[]>(`/api/v1/capacity/resources?hours=${hoursFilter}`),
    refetchInterval: 60_000,
  });

  const thresholdsQ = useQuery<Threshold[]>({
    queryKey: ["capacity-thresholds", tenantId],
    queryFn: () => api.get<Threshold[]>("/api/v1/capacity/thresholds"),
  });

  const upsertMut = useMutation({
    mutationFn: (data: { resource_id: string; metric_name: string; warn_pct: number; crit_pct: number }) =>
      api.post("/api/v1/capacity/thresholds", data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["capacity-thresholds", tenantId] });
      qc.invalidateQueries({ queryKey: ["capacity-resources", tenantId] });
      setConfigMetric(null);
    },
  });

  const deleteThreshMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/capacity/thresholds/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["capacity-thresholds", tenantId] });
      qc.invalidateQueries({ queryKey: ["capacity-resources", tenantId] });
      setConfigMetric(null);
    },
  });

  const summary = summaryQ.data;
  const resources = resourcesQ.data ?? [];
  const thresholds = thresholdsQ.data ?? [];

  const getThreshold = (resourceId: string, metricName: string) =>
    thresholds.find(t => t.resource_id === resourceId && t.metric_name === metricName);

  const worstState = (resource: CapacityResource) => {
    if (resource.metrics.some(m => m.state === "critical")) return "critical";
    if (resource.metrics.some(m => m.state === "warning")) return "warning";
    return "ok";
  };

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Gauge className="w-5 h-5 text-teal-600" />
            Capacidade
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Métricas de utilização, thresholds e forecast por regressão linear
          </p>
        </div>
        <select value={hoursFilter} onChange={e => setHoursFilter(parseInt(e.target.value))}
          className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
          <option value={1}>Última 1h</option>
          <option value={6}>Últimas 6h</option>
          <option value={24}>Últimas 24h</option>
          <option value={168}>Última semana</option>
        </select>
      </div>

      {/* Summary cards */}
      {summary && (
        <div className="grid grid-cols-3 gap-3">
          {[
            { label: "OK", value: summary.ok, icon: <CheckCircle2 className="w-4 h-4 text-green-500" />, bg: "bg-green-50 dark:bg-green-900/20" },
            { label: "Alerta", value: summary.warning, icon: <AlertTriangle className="w-4 h-4 text-yellow-500" />, bg: "bg-yellow-50 dark:bg-yellow-900/20" },
            { label: "Crítico", value: summary.critical, icon: <XCircle className="w-4 h-4 text-red-500" />, bg: "bg-red-50 dark:bg-red-900/20" },
          ].map(card => (
            <div key={card.label} className={`${card.bg} rounded-lg p-3 flex items-center gap-3`}>
              {card.icon}
              <div>
                <p className="text-xs text-gray-500 dark:text-gray-400">{card.label}</p>
                <p className="text-xl font-bold text-gray-900 dark:text-gray-100">{card.value}</p>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Resource list */}
      {resourcesQ.isLoading ? (
        <div className="text-gray-400 text-sm">Carregando métricas...</div>
      ) : resources.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Gauge className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhuma métrica de capacidade no período selecionado.</p>
          <p className="text-xs mt-1">Use POST /api/v1/capacity/metrics ou /metrics/batch para ingerir dados.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {resources.map(res => {
            const ws = worstState(res);
            const isExp = expanded === res.resource_id;
            return (
              <div key={res.resource_id} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
                <div className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-gray-900">
                  <button onClick={() => setExpanded(isExp ? null : res.resource_id)}
                    className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                    {isExp ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                  </button>
                  <StateIcon state={ws} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 dark:text-gray-100 truncate">
                      {res.resource_name ?? res.resource_id}
                    </p>
                    <p className="text-xs text-gray-400 font-mono truncate">{res.resource_id}</p>
                  </div>
                  <div className="flex gap-1 flex-wrap justify-end">
                    {res.metrics.map(m => (
                      <span key={m.metric_name}
                        className={`text-xs px-1.5 py-0.5 rounded font-mono ${
                          m.state === "critical" ? "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" :
                          m.state === "warning" ? "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-300" :
                          "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300"
                        }`}>
                        {METRIC_LABELS[m.metric_name] ?? m.metric_name}: {m.value?.toFixed(1) ?? "—"}{m.unit}
                      </span>
                    ))}
                  </div>
                </div>

                {isExp && (
                  <div className="border-t border-gray-100 dark:border-gray-800 p-4 bg-gray-50 dark:bg-gray-800/30 space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                      {res.metrics.map(m => (
                        <div key={m.metric_name} className="space-y-2">
                          <MetricBar m={m} />
                          <ForecastPanel resourceId={res.resource_id} metric={m.metric_name} />
                          {canOperate && (
                            configMetric?.resourceId === res.resource_id && configMetric?.metricName === m.metric_name ? (
                              <ThresholdForm
                                resourceId={res.resource_id}
                                metricName={m.metric_name}
                                existing={getThreshold(res.resource_id, m.metric_name)}
                                onSave={d => upsertMut.mutate(d)}
                                onDelete={id => deleteThreshMut.mutate(id)}
                                saving={upsertMut.isPending || deleteThreshMut.isPending}
                              />
                            ) : (
                              <button onClick={() => setConfigMetric({ resourceId: res.resource_id, metricName: m.metric_name })}
                                className="flex items-center gap-1 text-xs text-gray-400 hover:text-teal-600">
                                <Settings className="w-3 h-3" />
                                {getThreshold(res.resource_id, m.metric_name) ? "Editar threshold" : "Configurar threshold"}
                              </button>
                            )
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
