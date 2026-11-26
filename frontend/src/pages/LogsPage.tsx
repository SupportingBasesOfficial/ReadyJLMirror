import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import { usePermission } from "@/hooks/useSession";
import { FileText, BarChart3, AlertCircle, Info, Bug, Zap, ChevronDown, ChevronUp, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";

interface LogEntry {
  entry_id: string;
  resource_id: string | null;
  level: string;
  message: string;
  source: string | null;
  metadata: Record<string, unknown> | null;
  logged_at: string;
}

interface LogsResponse {
  total: number;
  limit: number;
  offset: number;
  entries: LogEntry[];
}

interface LogStats {
  hours: number;
  by_level: Record<string, number>;
  top_resources: { resource_id: string; count: number }[];
  hourly_trend: { hour: string; count: number }[];
}

const LEVELS = ["ERROR", "WARN", "INFO", "DEBUG", "TRACE"] as const;
const HOURS_OPTIONS = [
  { label: "1h", value: 1 },
  { label: "6h", value: 6 },
  { label: "24h", value: 24 },
  { label: "7d", value: 168 },
  { label: "30d", value: 720 },
];

function levelColor(level: string): string {
  switch (level) {
    case "ERROR": return "bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300";
    case "WARN":  return "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/40 dark:text-yellow-300";
    case "INFO":  return "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300";
    case "DEBUG": return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
    case "TRACE": return "bg-purple-100 text-purple-700 dark:bg-purple-900/40 dark:text-purple-300";
    default:      return "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300";
  }
}

function LevelIcon({ level }: { level: string }) {
  switch (level) {
    case "ERROR": return <AlertCircle className="w-3 h-3" />;
    case "WARN":  return <Zap className="w-3 h-3" />;
    case "INFO":  return <Info className="w-3 h-3" />;
    default:      return <Bug className="w-3 h-3" />;
  }
}

function LogRow({ entry }: { entry: LogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasExtra = !!entry.metadata || !!entry.source;
  return (
    <div className="border-b border-gray-100 dark:border-gray-800 last:border-0">
      <div
        className="flex items-start gap-3 px-4 py-2 hover:bg-gray-50 dark:hover:bg-gray-800/40 cursor-pointer"
        onClick={() => hasExtra && setExpanded(!expanded)}
      >
        <span className="text-xs text-gray-400 w-32 flex-shrink-0 font-mono mt-0.5">
          {new Date(entry.logged_at).toLocaleString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit", day: "2-digit", month: "2-digit" })}
        </span>
        <span className={`inline-flex items-center gap-1 text-xs font-semibold px-1.5 py-0.5 rounded flex-shrink-0 ${levelColor(entry.level)}`}>
          <LevelIcon level={entry.level} />{entry.level}
        </span>
        {entry.resource_id && (
          <span className="text-xs text-gray-500 dark:text-gray-400 font-mono bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded flex-shrink-0">
            {entry.resource_id}
          </span>
        )}
        <span className="text-sm text-gray-800 dark:text-gray-100 flex-1 font-mono whitespace-pre-wrap break-all">
          {entry.message}
        </span>
        {hasExtra && (
          <span className="text-gray-400 flex-shrink-0 mt-0.5">
            {expanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </span>
        )}
      </div>
      {expanded && hasExtra && (
        <div className="px-4 pb-3 ml-32 text-xs text-gray-500 dark:text-gray-400 space-y-1">
          {entry.source && <div><span className="font-semibold">source:</span> {entry.source}</div>}
          {entry.metadata && (
            <pre className="bg-gray-100 dark:bg-gray-800 rounded p-2 text-xs overflow-auto max-h-40">
              {JSON.stringify(entry.metadata, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function StatsTab({ tenantId }: { tenantId: string }) {
  const [hours, setHours] = useState(24);
  const q = useQuery<LogStats>({
    queryKey: ["log-stats", tenantId, hours],
    queryFn: () => api.get<LogStats>(`/api/v1/logs/stats?hours=${hours}`),
  });

  const stats = q.data;
  const totalErrors = (stats?.by_level["ERROR"] ?? 0) + (stats?.by_level["WARN"] ?? 0);

  return (
    <div className="space-y-6">
      <div className="flex gap-2">
        {HOURS_OPTIONS.map(opt => (
          <button
            key={opt.value}
            onClick={() => setHours(opt.value)}
            className={`px-3 py-1 rounded text-sm ${hours === opt.value ? "bg-teal-700 text-white" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"}`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {q.isLoading ? (
        <div className="text-gray-400 text-sm">Carregando...</div>
      ) : stats ? (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {LEVELS.map(lvl => (
              <div key={lvl} className="rounded-lg border border-gray-100 dark:border-gray-800 p-3 text-center">
                <div className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded mb-2 ${levelColor(lvl)}`}>
                  <LevelIcon level={lvl} />{lvl}
                </div>
                <div className="text-2xl font-bold text-gray-800 dark:text-gray-100">
                  {(stats.by_level[lvl] ?? 0).toLocaleString()}
                </div>
              </div>
            ))}
          </div>

          {totalErrors > 0 && (
            <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3 text-sm text-red-700 dark:text-red-300">
              <AlertCircle className="inline w-4 h-4 mr-1" />
              {totalErrors.toLocaleString()} ocorrências de ERROR/WARN nas últimas {hours >= 168 ? `${hours / 24}d` : `${hours}h`}
            </div>
          )}

          {stats.top_resources.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Top recursos</h3>
              <div className="space-y-1">
                {stats.top_resources.map(r => (
                  <div key={r.resource_id} className="flex items-center gap-2 text-sm">
                    <span className="font-mono text-gray-600 dark:text-gray-300 text-xs bg-gray-100 dark:bg-gray-800 px-1.5 py-0.5 rounded w-48 truncate">
                      {r.resource_id}
                    </span>
                    <div className="flex-1 bg-gray-100 dark:bg-gray-800 rounded h-2 overflow-hidden">
                      <div
                        className="h-2 bg-teal-600 rounded"
                        style={{ width: `${Math.round((r.count / (stats.top_resources[0]?.count || 1)) * 100)}%` }}
                      />
                    </div>
                    <span className="text-gray-500 text-xs w-10 text-right">{r.count.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {stats.hourly_trend.length > 0 && (
            <div>
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-2">Tendência (últimas 24h)</h3>
              <div className="flex items-end gap-0.5 h-16">
                {stats.hourly_trend.map(h => {
                  const max = Math.max(...stats.hourly_trend.map(x => x.count), 1);
                  return (
                    <div key={h.hour} title={`${new Date(h.hour).getHours()}h: ${h.count}`}
                      className="flex-1 bg-teal-600 dark:bg-teal-500 rounded-t opacity-80 hover:opacity-100 min-w-[2px]"
                      style={{ height: `${Math.round((h.count / max) * 100)}%` }}
                    />
                  );
                })}
              </div>
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

export function LogsPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const canAdmin = usePermission("tenant:admin");

  const [tab, setTab] = useState<"logs" | "stats">("logs");
  const [level, setLevel] = useState<string>("");
  const [pattern, setPattern] = useState("");
  const [debouncedPattern, setDebouncedPattern] = useState("");
  const [hours, setHours] = useState(24);
  const [offset, setOffset] = useState(0);

  const q = useQuery<LogsResponse>({
    queryKey: ["logs", tenantId, level, debouncedPattern, hours, offset],
    queryFn: () => {
      const params = new URLSearchParams({
        hours: String(hours),
        limit: "100",
        offset: String(offset),
      });
      if (level) params.set("level", level);
      if (debouncedPattern) params.set("pattern", debouncedPattern);
      return api.get<LogsResponse>(`/api/v1/logs?${params}`);
    },
    enabled: tab === "logs",
  });

  const clearMut = useMutation({
    mutationFn: (days: number) => api.delete(`/api/v1/logs?days=${days}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["logs", tenantId] }); qc.invalidateQueries({ queryKey: ["log-stats", tenantId] }); },
  });

  function handlePatternChange(v: string) {
    setPattern(v);
    clearTimeout((window as unknown as Record<string, ReturnType<typeof setTimeout>>)["_logPatternDebounce"]);
    (window as unknown as Record<string, ReturnType<typeof setTimeout>>)["_logPatternDebounce"] = setTimeout(() => {
      setDebouncedPattern(v);
      setOffset(0);
    }, 400);
  }

  const entries = q.data?.entries ?? [];
  const total = q.data?.total ?? 0;

  return (
    <div className="p-4 md:p-6 max-w-6xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <FileText className="w-5 h-5 text-teal-600" />
            {t("nav.logs", "Logs")}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Ingestão e busca de logs por tenant</p>
        </div>
        {canAdmin && (
          <Button
            variant="outline"
            size="sm"
            className="text-red-600 border-red-200 hover:bg-red-50 dark:text-red-400 dark:border-red-800 dark:hover:bg-red-900/20"
            onClick={() => { if (confirm("Excluir logs com mais de 30 dias?")) clearMut.mutate(30); }}
            disabled={clearMut.isPending}
          >
            <Trash2 className="w-4 h-4 mr-1" />Limpar &gt;30d
          </Button>
        )}
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {([["logs", "Logs", FileText], ["stats", "Estatísticas", BarChart3]] as const).map(([id, label, Icon]) => (
          <button
            key={id}
            onClick={() => setTab(id as "logs" | "stats")}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${tab === id ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"}`}
          >
            <Icon className="w-4 h-4" />{label}
          </button>
        ))}
      </div>

      {tab === "stats" ? (
        <StatsTab tenantId={tenantId} />
      ) : (
        <>
          {/* Filters */}
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex gap-1">
              <button
                onClick={() => { setLevel(""); setOffset(0); }}
                className={`px-2 py-1 rounded text-xs ${level === "" ? "bg-gray-800 text-white dark:bg-gray-200 dark:text-gray-900" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-700"}`}
              >
                TODOS
              </button>
              {LEVELS.map(lvl => (
                <button
                  key={lvl}
                  onClick={() => { setLevel(lvl === level ? "" : lvl); setOffset(0); }}
                  className={`px-2 py-1 rounded text-xs font-semibold ${level === lvl ? levelColor(lvl) + " ring-1 ring-current" : "bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"}`}
                >
                  {lvl}
                </button>
              ))}
            </div>
            <input
              className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-white dark:bg-gray-900 text-gray-800 dark:text-gray-100 w-56 focus:outline-none focus:ring-1 focus:ring-teal-500"
              placeholder="Busca (regex)..."
              value={pattern}
              onChange={e => handlePatternChange(e.target.value)}
            />
            <div className="flex gap-1 ml-auto">
              {HOURS_OPTIONS.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => { setHours(opt.value); setOffset(0); }}
                  className={`px-2 py-1 rounded text-xs ${hours === opt.value ? "bg-teal-700 text-white" : "bg-gray-100 dark:bg-gray-800 text-gray-500 hover:bg-gray-200 dark:hover:bg-gray-700"}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Results */}
          <div className="bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
            <div className="px-4 py-2 border-b border-gray-100 dark:border-gray-800 flex items-center justify-between">
              <span className="text-xs text-gray-500 dark:text-gray-400">
                {q.isLoading ? "Carregando..." : `${total.toLocaleString()} entradas`}
              </span>
              {total > 100 && (
                <div className="flex gap-1">
                  <button disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - 100))}
                    className="px-2 py-0.5 text-xs rounded bg-gray-100 dark:bg-gray-800 disabled:opacity-30">‹</button>
                  <span className="text-xs text-gray-400 px-1">{Math.floor(offset / 100) + 1} / {Math.ceil(total / 100)}</span>
                  <button disabled={offset + 100 >= total} onClick={() => setOffset(offset + 100)}
                    className="px-2 py-0.5 text-xs rounded bg-gray-100 dark:bg-gray-800 disabled:opacity-30">›</button>
                </div>
              )}
            </div>
            {q.isError ? (
              <div className="p-6 text-sm text-red-600 dark:text-red-400">
                Erro ao carregar logs. Verifique se o padrão de busca é um regex válido.
              </div>
            ) : entries.length === 0 && !q.isLoading ? (
              <div className="p-8 text-center text-gray-400 text-sm">Nenhum log encontrado para os filtros selecionados.</div>
            ) : (
              <div className="font-mono text-xs">
                {entries.map(e => <LogRow key={e.entry_id} entry={e} />)}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
