import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Gauge, TrendingUp, AlertCircle, Clock, BarChart2 } from "lucide-react";
import { api } from "@/api/client";

interface ApmSummary {
  total_requests: number;
  error_count: number;
  client_error_count: number;
  avg_ms: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

interface ApmEndpoint {
  method: string;
  path: string;
  request_count: number;
  error_count: number;
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
}

interface ApmHourly {
  hour: string;
  requests: number;
  errors: number;
}

interface ApmOverview {
  scope: string;
  summary: ApmSummary;
  endpoints: ApmEndpoint[];
  hourly: ApmHourly[];
}

const METHOD_COLORS: Record<string, string> = {
  GET: "var(--brand)",
  POST: "var(--green, #22c55e)",
  PUT: "var(--yellow, #eab308)",
  PATCH: "var(--yellow, #eab308)",
  DELETE: "var(--red, #ef4444)",
};

function StatTile({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4 flex flex-col gap-1">
      <span className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">{label}</span>
      <span className="text-2xl font-bold text-[var(--text)]">{value}</span>
      {sub && <span className="text-xs text-[var(--text-muted)]">{sub}</span>}
    </div>
  );
}

function HourlyChart({ data }: { data: ApmHourly[] }) {
  if (!data.length) return <div className="text-[var(--text-muted)] text-sm py-8 text-center">Sem dados nas últimas 24 h</div>;

  const maxReqs = Math.max(...data.map((d) => d.requests), 1);
  const W = 600;
  const H = 120;
  const barW = Math.max(4, Math.floor((W - 20) / data.length) - 2);
  const pad = 10;

  return (
    <svg viewBox={`0 0 ${W} ${H + 20}`} className="w-full" style={{ maxHeight: 160 }}>
      {data.map((d, i) => {
        const x = pad + i * ((W - pad * 2) / data.length);
        const reqH = (d.requests / maxReqs) * H;
        const errH = (d.errors / maxReqs) * H;
        const hour = new Date(d.hour).getHours();
        return (
          <g key={d.hour}>
            <rect x={x} y={H - reqH} width={barW} height={reqH} fill="var(--brand)" opacity={0.35} rx={2} />
            {errH > 0 && (
              <rect x={x} y={H - errH} width={barW} height={errH} fill="var(--red, #ef4444)" opacity={0.75} rx={2} />
            )}
            {i % 4 === 0 && (
              <text x={x + barW / 2} y={H + 14} textAnchor="middle" fontSize={9} fill="var(--text-dim)">
                {String(hour).padStart(2, "0")}h
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}

function latencyColor(ms: number): string {
  if (ms > 2000) return "var(--red, #ef4444)";
  if (ms > 500) return "var(--yellow, #eab308)";
  return "var(--green, #22c55e)";
}

export function APMPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();

  const { data, isLoading, isError } = useQuery<ApmOverview>({
    queryKey: ["apm-overview", tenantId],
    queryFn: () => api.get<ApmOverview>("/api/v1/apm/overview"),
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return <div className="text-[var(--text-muted)] text-sm p-6">{t("common.loading")}</div>;
  }

  if (isError || !data) {
    return <div className="text-[var(--red)] text-sm p-6">{t("common.error")}</div>;
  }

  const s = data.summary;
  const errorRate = s.total_requests > 0 ? ((s.error_count / s.total_requests) * 100).toFixed(1) : "0.0";

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex items-center gap-2">
        <Gauge size={18} className="text-[var(--brand)]" />
        <h1 className="text-lg font-semibold">{t("apm.title", "API Performance Monitor")}</h1>
        <span className="text-xs text-[var(--text-muted)] ml-2">{t("apm.last24h", "Últimas 24 h")}</span>
      </div>

      {/* Stat tiles */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatTile label={t("apm.requests", "Requisições")} value={s.total_requests.toLocaleString()} />
        <StatTile
          label={t("apm.errorRate", "Taxa de erro")}
          value={`${errorRate}%`}
          sub={`${s.error_count} 5xx`}
        />
        <StatTile
          label="p50"
          value={`${s.p50_ms} ms`}
        />
        <StatTile
          label="p95"
          value={`${s.p95_ms} ms`}
        />
        <StatTile
          label="p99"
          value={`${s.p99_ms} ms`}
        />
        <StatTile
          label={t("apm.avgLatency", "Média")}
          value={`${s.avg_ms} ms`}
        />
      </div>

      {/* Hourly chart */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <BarChart2 size={14} className="text-[var(--text-muted)]" />
          <span className="text-sm font-medium">{t("apm.requestsPerHour", "Requisições por hora")}</span>
          <span className="flex items-center gap-1 ml-auto text-xs text-[var(--text-muted)]">
            <span className="inline-block w-2 h-2 rounded-sm" style={{ background: "var(--brand)", opacity: 0.5 }} />
            {t("apm.total", "Total")}
            <span className="inline-block w-2 h-2 rounded-sm ml-2" style={{ background: "var(--red, #ef4444)", opacity: 0.8 }} />
            {t("apm.errors", "Erros")}
          </span>
        </div>
        <HourlyChart data={data.hourly} />
      </div>

      {/* Top endpoints */}
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <TrendingUp size={14} className="text-[var(--text-muted)]" />
          <span className="text-sm font-medium">{t("apm.topEndpoints", "Top 20 endpoints — 24 h")}</span>
        </div>

        {data.endpoints.length === 0 ? (
          <div className="text-[var(--text-muted)] text-sm text-center py-8">
            {t("apm.noData", "Nenhuma requisição registrada ainda. Os dados aparecem assim que a API recebe chamadas.")}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[var(--text-muted)] text-xs border-b border-[var(--border)]">
                  <th className="text-left py-2 pr-4 font-medium">{t("apm.method", "Método")}</th>
                  <th className="text-left py-2 pr-4 font-medium">{t("apm.path", "Path")}</th>
                  <th className="text-right py-2 pr-4 font-medium">{t("apm.count", "Req")}</th>
                  <th className="text-right py-2 pr-4 font-medium">
                    <span className="flex items-center justify-end gap-1">
                      <AlertCircle size={10} />
                      {t("apm.errors", "Erros")}
                    </span>
                  </th>
                  <th className="text-right py-2 pr-4 font-medium">p50</th>
                  <th className="text-right py-2 pr-4 font-medium">p95</th>
                  <th className="text-right py-2 font-medium">p99</th>
                </tr>
              </thead>
              <tbody>
                {data.endpoints.map((ep, i) => {
                  const errPct = ep.request_count > 0 ? (ep.error_count / ep.request_count) * 100 : 0;
                  return (
                    <tr
                      key={`${ep.method}:${ep.path}:${i}`}
                      className="border-b border-[var(--border)] last:border-0"
                      style={{ color: "var(--text)" }}
                    >
                      <td className="py-2 pr-4">
                        <span
                          className="text-[10px] font-bold px-1.5 py-0.5 rounded"
                          style={{
                            background: `color-mix(in srgb, ${METHOD_COLORS[ep.method] ?? "var(--text-muted)"} 15%, transparent)`,
                            color: METHOD_COLORS[ep.method] ?? "var(--text-muted)",
                          }}
                        >
                          {ep.method}
                        </span>
                      </td>
                      <td className="py-2 pr-4 font-mono text-xs text-[var(--text-muted)] max-w-[280px] truncate">
                        {ep.path}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums">{ep.request_count.toLocaleString()}</td>
                      <td className="py-2 pr-4 text-right tabular-nums">
                        {ep.error_count > 0 ? (
                          <span style={{ color: "var(--red, #ef4444)" }}>
                            {ep.error_count} ({errPct.toFixed(0)}%)
                          </span>
                        ) : (
                          <span className="text-[var(--text-muted)]">—</span>
                        )}
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-xs" style={{ color: latencyColor(ep.p50_ms) }}>
                        {ep.p50_ms} ms
                      </td>
                      <td className="py-2 pr-4 text-right tabular-nums text-xs" style={{ color: latencyColor(ep.p95_ms) }}>
                        {ep.p95_ms} ms
                      </td>
                      <td className="py-2 text-right tabular-nums text-xs" style={{ color: latencyColor(ep.p99_ms) }}>
                        {ep.p99_ms} ms
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Legend for latency colors */}
      <div className="flex items-center gap-4 text-xs text-[var(--text-muted)]">
        <span className="flex items-center gap-1">
          <Clock size={10} />
          {t("apm.latencyLegend", "Latência:")}
        </span>
        <span style={{ color: "var(--green, #22c55e)" }}>≤500 ms OK</span>
        <span style={{ color: "var(--yellow, #eab308)" }}>≤2 s Atenção</span>
        <span style={{ color: "var(--red, #ef4444)" }}>&gt;2 s Crítico</span>
      </div>
    </div>
  );
}
