import { useState, useEffect, useRef } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  GitMerge, Plus, CheckCircle, XCircle, Clock, AlertTriangle,
  ChevronDown, ChevronRight, Edit2, Trash2, Zap, RefreshCw
} from "lucide-react";

interface CorrelationRule {
  rule_id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  match_severity: string[];
  match_source_kind: string;
  match_labels: Record<string, string>;
  group_by: string[];
  group_window_seconds: number;
  group_wait_seconds: number;
  auto_resolve_seconds: number | null;
  created_at: string;
}

interface AlertGroup {
  group_id: string;
  rule_id: string | null;
  rule_name: string | null;
  fingerprint: string;
  status: "firing" | "acknowledged" | "resolved";
  severity: string;
  alert_count: number;
  labels: Record<string, string>;
  summary: string | null;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  resolved_at: string | null;
  first_fired_at: string;
  last_updated_at: string;
  members?: AlertMember[];
}

interface AlertMember {
  member_id: string;
  alert_name: string;
  host_id: string | null;
  severity: string;
  labels: Record<string, string>;
  summary: string | null;
  added_at: string;
}

interface Stats {
  firing: number;
  acknowledged: number;
  resolved_24h: number;
  critical_active: number;
  new_last_hour: number;
  new_24h: number;
}

const SEV_STYLES: Record<string, string> = {
  critical: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  degraded: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  warning: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
  informational: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
  unknown: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
};

const STATUS_STYLES: Record<string, string> = {
  firing: "text-red-500",
  acknowledged: "text-yellow-500",
  resolved: "text-green-500",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "resolved") return <CheckCircle size={13} className="text-green-500" />;
  if (status === "acknowledged") return <Clock size={13} className="text-yellow-500" />;
  return <AlertTriangle size={13} className="text-red-500" />;
}

function SevBadge({ severity }: { severity: string }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-xs font-medium ${SEV_STYLES[severity] || SEV_STYLES.unknown}`}>
      {severity}
    </span>
  );
}

function StatCard({ label, value, sub }: { label: string; value: number | string; sub?: string }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value}</div>
      <div className="text-xs font-medium text-gray-500 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rule modal
// ---------------------------------------------------------------------------
function RuleModal({ rule, onClose, tenantId }: { rule?: CorrelationRule | null; onClose: () => void; tenantId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: rule?.name ?? "",
    description: rule?.description ?? "",
    enabled: rule?.enabled ?? true,
    match_severity: (rule?.match_severity ?? []).join(", "),
    match_source_kind: rule?.match_source_kind ?? "*",
    group_by: (rule?.group_by ?? []).join(", "),
    group_window_seconds: rule?.group_window_seconds ?? 300,
    group_wait_seconds: rule?.group_wait_seconds ?? 30,
    auto_resolve_seconds: rule?.auto_resolve_seconds ?? "",
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name,
        description: form.description || null,
        enabled: form.enabled,
        match_severity: form.match_severity ? form.match_severity.split(",").map(s => s.trim()).filter(Boolean) : [],
        match_source_kind: form.match_source_kind || "*",
        group_by: form.group_by ? form.group_by.split(",").map(s => s.trim()).filter(Boolean) : [],
        group_window_seconds: Number(form.group_window_seconds),
        group_wait_seconds: Number(form.group_wait_seconds),
        auto_resolve_seconds: form.auto_resolve_seconds ? Number(form.auto_resolve_seconds) : null,
      };
      const url = rule ? `/api/v1/correlation/rules/${rule.rule_id}` : "/api/v1/correlation/rules";
      const r = await fetch(url, { method: rule ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["corr-rules", tenantId] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md">
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{rule ? "Editar regra" : "Nova regra de correlação"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5 flex flex-col gap-3">
          {[
            ["nome *", "name", "text"],
            ["descrição", "description", "text"],
            ["severidades (vírgula)", "match_severity", "text"],
            ["source kind (* = todos)", "match_source_kind", "text"],
            ["group by (campos, vírgula)", "group_by", "text"],
            ["janela de agrupamento (s)", "group_window_seconds", "number"],
            ["espera inicial (s)", "group_wait_seconds", "number"],
            ["auto-resolver (s, opcional)", "auto_resolve_seconds", "number"],
          ].map(([label, key, type]) => (
            <div key={key}>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{label}</label>
              <input
                type={type}
                value={String(form[key as keyof typeof form])}
                onChange={e => setForm(p => ({ ...p, [key]: e.target.value }))}
                className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          ))}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={e => setForm(p => ({ ...p, enabled: e.target.checked }))} className="rounded" />
            <span className="text-sm text-gray-700 dark:text-gray-300">Habilitada</span>
          </label>
          {save.isError && <p className="text-xs text-red-500">{String(save.error)}</p>}
        </div>
        <div className="p-5 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">Cancelar</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()} className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Alert group detail
// ---------------------------------------------------------------------------
function GroupDetail({ group, onClose, tenantId }: { group: AlertGroup; onClose: () => void; tenantId: string }) {
  const qc = useQueryClient();
  const { data } = useQuery<AlertGroup>({
    queryKey: ["corr-group-detail", group.group_id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/correlation/alert-groups/${group.group_id}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const ack = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/v1/correlation/alert-groups/${group.group_id}/acknowledge`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["corr-groups", tenantId] }); onClose(); },
  });

  const resolve = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/v1/correlation/alert-groups/${group.group_id}/resolve`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["corr-groups", tenantId] }); onClose(); },
  });

  const g = data ?? group;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-2xl max-h-[80vh] flex flex-col">
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <StatusIcon status={g.status} />
              <span className={`text-sm font-semibold ${STATUS_STYLES[g.status]}`}>{g.status}</span>
              <SevBadge severity={g.severity} />
              <span className="text-xs text-gray-400">{g.alert_count} alertas</span>
              {g.rule_name && <span className="text-xs text-gray-400">· {g.rule_name}</span>}
            </div>
            <p className="text-xs text-gray-500 font-mono mt-1">{g.fingerprint}</p>
            {g.summary && <p className="text-sm text-gray-700 dark:text-gray-300 mt-1">{g.summary}</p>}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl ml-4">×</button>
        </div>

        {/* Labels */}
        {Object.keys(g.labels).length > 0 && (
          <div className="px-5 pt-3 pb-0 flex flex-wrap gap-1.5">
            {Object.entries(g.labels).map(([k, v]) => (
              <span key={k} className="inline-flex items-center gap-1 px-2 py-0.5 bg-gray-100 dark:bg-gray-800 rounded text-xs text-gray-600 dark:text-gray-300">
                <span className="font-medium">{k}</span>=<span>{v}</span>
              </span>
            ))}
          </div>
        )}

        {/* Members */}
        <div className="flex-1 overflow-y-auto p-5">
          <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Alertas membros</h4>
          {!data ? (
            <div className="text-xs text-gray-400">Carregando...</div>
          ) : g.members?.length === 0 ? (
            <div className="text-xs text-gray-400">Sem membros registrados.</div>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 bg-gray-50 dark:bg-gray-800">
                  <th className="px-2 py-1.5 text-left font-medium">Alerta</th>
                  <th className="px-2 py-1.5 text-left font-medium">Host</th>
                  <th className="px-2 py-1.5 text-left font-medium">Sev</th>
                  <th className="px-2 py-1.5 text-left font-medium">Resumo</th>
                  <th className="px-2 py-1.5 text-left font-medium">Adicionado</th>
                </tr>
              </thead>
              <tbody>
                {g.members?.map(m => (
                  <tr key={m.member_id} className="border-t border-gray-100 dark:border-gray-700/50">
                    <td className="px-2 py-1.5 font-medium text-gray-900 dark:text-gray-100">{m.alert_name}</td>
                    <td className="px-2 py-1.5 text-gray-500">{m.host_id || "—"}</td>
                    <td className="px-2 py-1.5"><SevBadge severity={m.severity} /></td>
                    <td className="px-2 py-1.5 text-gray-500 max-w-[180px] truncate">{m.summary || "—"}</td>
                    <td className="px-2 py-1.5 text-gray-400">{new Date(m.added_at).toLocaleString("pt-BR")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="p-5 border-t border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <span className="text-xs text-gray-400">
            Iniciado {new Date(g.first_fired_at).toLocaleString("pt-BR")}
          </span>
          <div className="flex gap-2">
            {g.status === "firing" && (
              <button onClick={() => ack.mutate()} disabled={ack.isPending} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-yellow-500 text-white hover:bg-yellow-600 disabled:opacity-50">
                Reconhecer
              </button>
            )}
            {g.status !== "resolved" && (
              <button onClick={() => resolve.mutate()} disabled={resolve.isPending} className="px-3 py-1.5 rounded-lg text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50">
                Resolver
              </button>
            )}
            <button onClick={onClose} className="px-3 py-1.5 rounded-lg text-xs text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">
              Fechar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function CorrelationPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"groups" | "rules">("groups");
  const [statusFilter, setStatusFilter] = useState<string>("firing");
  const [ruleModal, setRuleModal] = useState<{ open: boolean; rule?: CorrelationRule | null }>({ open: false });
  const [selectedGroup, setSelectedGroup] = useState<AlertGroup | null>(null);
  const [liveUpdates, setLiveUpdates] = useState(0);
  const eventSourceRef = useRef<EventSource | null>(null);

  const { data: stats } = useQuery<Stats>({
    queryKey: ["corr-stats", tenantId],
    queryFn: async () => {
      const r = await fetch("/api/v1/correlation/stats");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 15000,
  });

  const { data: groups = [], isLoading: loadingGroups } = useQuery<AlertGroup[]>({
    queryKey: ["corr-groups", tenantId, statusFilter],
    queryFn: async () => {
      const params = new URLSearchParams({ status_filter: statusFilter, limit: "100" });
      const r = await fetch(`/api/v1/correlation/alert-groups?${params}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  const { data: rules = [] } = useQuery<CorrelationRule[]>({
    queryKey: ["corr-rules", tenantId],
    queryFn: async () => {
      const r = await fetch("/api/v1/correlation/rules");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });

  // SSE stream for live group updates
  useEffect(() => {
    const es = new EventSource("/api/v1/correlation/stream");
    eventSourceRef.current = es;
    es.onmessage = (e) => {
      if (e.data.startsWith(":")) return;
      try {
        const ev = JSON.parse(e.data);
        if (ev.type === "update" || ev.type === "resolved") {
          setLiveUpdates(n => n + 1);
          qc.invalidateQueries({ queryKey: ["corr-groups", tenantId] });
          qc.invalidateQueries({ queryKey: ["corr-stats", tenantId] });
        }
      } catch { /* ignore */ }
    };
    return () => es.close();
  }, [tenantId, qc]);

  const deleteRule = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/v1/correlation/rules/${id}`, { method: "DELETE" });
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["corr-rules", tenantId] }),
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      {/* header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <GitMerge size={22} className="text-purple-500" />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Correlação de Alertas</h1>
          {liveUpdates > 0 && (
            <span className="text-xs text-purple-500 flex items-center gap-1">
              <Zap size={11} /> live
            </span>
          )}
        </div>
      </div>

      {/* stats */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <StatCard label="Firing" value={stats.firing} />
          <StatCard label="Reconhecidos" value={stats.acknowledged} />
          <StatCard label="Críticos ativos" value={stats.critical_active} />
          <StatCard label="Resolvidos 24h" value={stats.resolved_24h} />
          <StatCard label="Novos última hora" value={stats.new_last_hour} />
          <StatCard label="Novos 24h" value={stats.new_24h} />
        </div>
      )}

      {/* tabs */}
      <div className="flex gap-1 mb-4">
        {[{ id: "groups", label: "Grupos" }, { id: "rules", label: "Regras de Correlação" }].map(t => (
          <button
            key={t.id}
            onClick={() => setTab(t.id as "groups" | "rules")}
            className={`px-4 py-2 text-sm font-medium rounded-lg transition-colors ${tab === t.id ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* groups tab */}
      {tab === "groups" && (
        <>
          <div className="flex gap-1 mb-3">
            {["firing", "acknowledged", "resolved"].map(s => (
              <button
                key={s}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 text-xs font-medium rounded-full border transition-colors ${statusFilter === s ? "border-blue-500 bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300" : "border-gray-200 dark:border-gray-700 text-gray-500 hover:border-gray-300"}`}
              >
                {s}
              </button>
            ))}
            <button onClick={() => { qc.invalidateQueries({ queryKey: ["corr-groups"] }); }} className="ml-auto p-1.5 text-gray-400 hover:text-gray-600 rounded">
              <RefreshCw size={14} />
            </button>
          </div>

          {loadingGroups ? (
            <div className="text-sm text-gray-400">Carregando grupos...</div>
          ) : groups.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <GitMerge size={32} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Nenhum grupo de alerta com status "{statusFilter}".</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              {groups.map((g, idx) => (
                <div
                  key={g.group_id}
                  className={`flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700/30 ${idx > 0 ? "border-t border-gray-100 dark:border-gray-700" : ""}`}
                  onClick={() => setSelectedGroup(g)}
                >
                  <StatusIcon status={g.status} />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <SevBadge severity={g.severity} />
                      <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
                        {g.summary || `Grupo ${g.fingerprint.slice(0, 8)}`}
                      </span>
                      {g.rule_name && <span className="text-xs text-gray-400">{g.rule_name}</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5">
                      <span className="text-xs text-gray-500">{g.alert_count} alertas</span>
                      {Object.entries(g.labels).slice(0, 3).map(([k, v]) => (
                        <span key={k} className="text-xs text-gray-400">{k}={v}</span>
                      ))}
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <div className="text-xs text-gray-400">
                      {new Date(g.last_updated_at).toLocaleString("pt-BR")}
                    </div>
                    {g.acknowledged_by && (
                      <div className="text-xs text-yellow-500">ack: {g.acknowledged_by}</div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* rules tab */}
      {tab === "rules" && (
        <>
          <div className="flex justify-end mb-3">
            <button
              onClick={() => setRuleModal({ open: true, rule: null })}
              className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
            >
              <Plus size={15} /> Nova regra
            </button>
          </div>

          {rules.length === 0 ? (
            <div className="text-center py-12 text-gray-400 text-sm">Nenhuma regra de correlação criada.</div>
          ) : (
            <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
              {rules.map((r, idx) => (
                <div key={r.rule_id} className={`flex items-center gap-3 px-4 py-3 ${idx > 0 ? "border-t border-gray-100 dark:border-gray-700" : ""}`}>
                  <div className={`w-2 h-2 rounded-full flex-shrink-0 ${r.enabled ? "bg-green-500" : "bg-gray-300"}`} />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-gray-900 dark:text-gray-100">{r.name}</div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      {r.match_severity.length > 0 && (
                        <span className="text-xs text-gray-500">sev: {r.match_severity.join(", ")}</span>
                      )}
                      {r.group_by.length > 0 && (
                        <span className="text-xs text-gray-500">group_by: {r.group_by.join(", ")}</span>
                      )}
                      <span className="text-xs text-gray-400">janela: {r.group_window_seconds}s</span>
                      {r.auto_resolve_seconds && (
                        <span className="text-xs text-gray-400">auto-resolve: {r.auto_resolve_seconds}s</span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1 flex-shrink-0">
                    <button onClick={() => setRuleModal({ open: true, rule: r })} className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => { if (confirm(`Excluir regra "${r.name}"?`)) deleteRule.mutate(r.rule_id); }}
                      className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {ruleModal.open && (
        <RuleModal rule={ruleModal.rule} onClose={() => setRuleModal({ open: false })} tenantId={tenantId} />
      )}
      {selectedGroup && (
        <GroupDetail group={selectedGroup} onClose={() => setSelectedGroup(null)} tenantId={tenantId} />
      )}
    </div>
  );
}
