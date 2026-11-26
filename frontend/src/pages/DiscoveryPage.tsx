import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Radar, Plus, Play, RefreshCw, CheckCircle, XCircle,
  Clock, Edit2, Trash2, ChevronDown, ChevronRight,
  Search, Download, Wifi, Server
} from "lucide-react";

interface DiscoverySession {
  session_id: string;
  name: string;
  description: string | null;
  scan_type: string;
  cidr_ranges: string[];
  snmp_version: string;
  snmp_port: number;
  status: string;
  last_scan_at: string | null;
  last_scan_duration_s: number | null;
  discovered_count: number;
  enabled: boolean;
  created_at: string;
  last_scan: LastScanInfo | null;
}

interface LastScanInfo {
  log_id: string;
  log_status: string;
  total_scanned: number | null;
  new_devices: number | null;
  updated_devices: number | null;
  started_at: string;
  finished_at: string | null;
}

interface ScanLog {
  log_id: string;
  status: string;
  triggered_by: string;
  total_scanned: number | null;
  new_devices: number | null;
  updated_devices: number | null;
  error_message: string | null;
  started_at: string;
  finished_at: string | null;
  duration_s: number | null;
}

interface DiscoveryResult {
  result_id: string;
  ip_address: string;
  mac_address: string | null;
  hostname: string | null;
  sys_name: string | null;
  sys_descr: string | null;
  sys_location: string | null;
  device_type: string | null;
  os_hint: string | null;
  open_ports: number[];
  snmp_reachable: boolean;
  ping_rtt_ms: number | null;
  is_new: boolean;
  imported_to_inventory: boolean;
  first_seen_at: string;
  last_seen_at: string;
}

interface Stats {
  active_sessions: number;
  running_scans: number;
  total_discovered: number;
  new_devices: number;
  snmp_devices: number;
  pending_import: number;
}

type PanelView = "results" | "logs";

function StatusIcon({ status }: { status: string }) {
  if (status === "completed") return <CheckCircle size={13} className="text-green-500" />;
  if (status === "failed") return <XCircle size={13} className="text-red-500" />;
  if (status === "running") return <RefreshCw size={13} className="text-blue-500 animate-spin" />;
  return <Clock size={13} className="text-gray-400" />;
}

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    completed: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    idle: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cls[status] || cls.idle}`}>
      <StatusIcon status={status} />
      {status}
    </span>
  );
}

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4">
      <div className="text-2xl font-bold text-gray-900 dark:text-gray-100">{value.toLocaleString()}</div>
      <div className="text-xs font-medium text-gray-500 mt-0.5">{label}</div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session modal
// ---------------------------------------------------------------------------
function SessionModal({ session, onClose, tenantId }: { session?: DiscoverySession | null; onClose: () => void; tenantId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: session?.name ?? "",
    description: session?.description ?? "",
    scan_type: session?.scan_type ?? "ping+snmp",
    cidr_ranges: (session?.cidr_ranges ?? []).join("\n"),
    snmp_community: "public",
    snmp_version: session?.snmp_version ?? "v2c",
    snmp_port: session?.snmp_port ?? 161,
    snmp_timeout_ms: 2000,
    snmp_retries: 1,
    probe_ports: "",
    enabled: session?.enabled ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        name: form.name,
        description: form.description || null,
        scan_type: form.scan_type,
        cidr_ranges: form.cidr_ranges.split("\n").map(s => s.trim()).filter(Boolean),
        snmp_community: form.snmp_community,
        snmp_version: form.snmp_version,
        snmp_port: Number(form.snmp_port),
        snmp_timeout_ms: Number(form.snmp_timeout_ms),
        snmp_retries: Number(form.snmp_retries),
        probe_ports: form.probe_ports ? form.probe_ports.split(",").map(s => parseInt(s.trim())).filter(n => !isNaN(n)) : [],
        enabled: form.enabled,
      };
      const url = session ? `/api/v1/discovery/sessions/${session.session_id}` : "/api/v1/discovery/sessions";
      const r = await fetch(url, { method: session ? "PUT" : "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["disc-sessions", tenantId] }); onClose(); },
  });

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col">
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">{session ? "Editar sessão" : "Nova sessão de discovery"}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="flex-1 overflow-y-auto p-5 flex flex-col gap-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nome *</label>
            <input type="text" value={form.name} onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tipo de scan</label>
            <select value={form.scan_type} onChange={e => setForm(p => ({ ...p, scan_type: e.target.value }))}
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
              {["ping", "snmp", "ping+snmp", "port"].map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Ranges CIDR (um por linha)</label>
            <textarea value={form.cidr_ranges} onChange={e => setForm(p => ({ ...p, cidr_ranges: e.target.value }))} rows={3}
              placeholder="192.168.1.0/24&#10;10.0.0.0/8"
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono" />
          </div>
          {(form.scan_type === "snmp" || form.scan_type === "ping+snmp") && (
            <>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Community</label>
                  <input type="text" value={form.snmp_community} onChange={e => setForm(p => ({ ...p, snmp_community: e.target.value }))}
                    className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Versão SNMP</label>
                  <select value={form.snmp_version} onChange={e => setForm(p => ({ ...p, snmp_version: e.target.value }))}
                    className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500">
                    {["v1", "v2c", "v3"].map(v => <option key={v} value={v}>{v}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Porta SNMP</label>
                  <input type="number" value={form.snmp_port} onChange={e => setForm(p => ({ ...p, snmp_port: Number(e.target.value) }))}
                    className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Timeout (ms)</label>
                  <input type="number" value={form.snmp_timeout_ms} onChange={e => setForm(p => ({ ...p, snmp_timeout_ms: Number(e.target.value) }))}
                    className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>
            </>
          )}
          {form.scan_type === "port" && (
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Portas (vírgula)</label>
              <input type="text" value={form.probe_ports} onChange={e => setForm(p => ({ ...p, probe_ports: e.target.value }))}
                placeholder="22,80,443,3389"
                className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          )}
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
// Session detail (results + logs)
// ---------------------------------------------------------------------------
function SessionDetail({ session, tenantId }: { session: DiscoverySession; tenantId: string }) {
  const qc = useQueryClient();
  const [panel, setPanel] = useState<PanelView>("results");
  const [search, setSearch] = useState("");
  const [snmpOnly, setSnmpOnly] = useState(false);

  const { data: results = [] } = useQuery<DiscoveryResult[]>({
    queryKey: ["disc-results", session.session_id, search, snmpOnly],
    queryFn: async () => {
      const params = new URLSearchParams({ limit: "200" });
      if (search) params.set("search", search);
      if (snmpOnly) params.set("snmp_only", "true");
      const r = await fetch(`/api/v1/discovery/sessions/${session.session_id}/results?${params}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: panel === "results",
    refetchInterval: session.status === "running" ? 5000 : false,
  });

  const { data: logs = [] } = useQuery<ScanLog[]>({
    queryKey: ["disc-logs", session.session_id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/discovery/sessions/${session.session_id}/scan-logs`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: panel === "logs",
    refetchInterval: session.status === "running" ? 5000 : false,
  });

  const triggerScan = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/v1/discovery/sessions/${session.session_id}/scan`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["disc-sessions", tenantId] });
      qc.invalidateQueries({ queryKey: ["disc-logs", session.session_id] });
      setPanel("logs");
    },
  });

  const markImport = useMutation({
    mutationFn: async (result_id: string) => {
      const r = await fetch(`/api/v1/discovery/sessions/${session.session_id}/results/${result_id}/import`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["disc-results", session.session_id] }),
  });

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30">
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-gray-100 dark:border-gray-700 overflow-x-auto">
        {(["results", "logs"] as PanelView[]).map(p => (
          <button key={p} onClick={() => setPanel(p)}
            className={`px-2.5 py-1 text-xs rounded font-medium transition-colors flex-shrink-0 ${panel === p ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>
            {p === "results" ? `Dispositivos (${results.length})` : "Scan Logs"}
          </button>
        ))}
        {panel === "results" && (
          <>
            <div className="flex items-center gap-1 ml-2">
              <Search size={12} className="text-gray-400" />
              <input type="text" placeholder="IP, hostname..." value={search} onChange={e => setSearch(e.target.value)}
                className="w-28 px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500" />
            </div>
            <label className="flex items-center gap-1 ml-1 text-xs text-gray-500 cursor-pointer flex-shrink-0">
              <input type="checkbox" checked={snmpOnly} onChange={e => setSnmpOnly(e.target.checked)} className="rounded" />
              SNMP
            </label>
          </>
        )}
        <div className="flex-1" />
        <button
          onClick={() => triggerScan.mutate()}
          disabled={triggerScan.isPending || session.status === "running"}
          className="flex items-center gap-1 px-2.5 py-1 ml-1 rounded text-xs font-medium bg-green-600 text-white hover:bg-green-700 disabled:opacity-50 flex-shrink-0"
        >
          <Play size={11} className={session.status === "running" ? "opacity-50" : ""} />
          {session.status === "running" ? "Executando..." : "Scan"}
        </button>
      </div>

      {panel === "results" && (
        results.length === 0 ? (
          <div className="p-4 text-xs text-gray-400 text-center">Nenhum dispositivo descoberto ainda.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 bg-gray-100 dark:bg-gray-800">
                  {["IP", "Hostname/SysName", "Tipo", "SNMP", "RTT", "Portas", "Visto em", ""].map(h => (
                    <th key={h} className="px-3 py-1.5 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {results.map(r => (
                  <tr key={r.result_id} className="border-t border-gray-100 dark:border-gray-700/50">
                    <td className="px-3 py-1.5 font-mono text-gray-900 dark:text-gray-100">
                      {r.ip_address}
                      {r.is_new && <span className="ml-1 text-blue-500 font-medium">novo</span>}
                    </td>
                    <td className="px-3 py-1.5 text-gray-700 dark:text-gray-300">{r.sys_name || r.hostname || "—"}</td>
                    <td className="px-3 py-1.5 text-gray-500">{r.device_type || r.os_hint || "—"}</td>
                    <td className="px-3 py-1.5">
                      {r.snmp_reachable ? <Wifi size={12} className="text-green-500" /> : <span className="text-gray-300">—</span>}
                    </td>
                    <td className="px-3 py-1.5 text-gray-500">{r.ping_rtt_ms != null ? `${r.ping_rtt_ms.toFixed(1)}ms` : "—"}</td>
                    <td className="px-3 py-1.5 text-gray-500">{r.open_ports.length > 0 ? r.open_ports.slice(0, 5).join(", ") : "—"}</td>
                    <td className="px-3 py-1.5 text-gray-400">{new Date(r.last_seen_at).toLocaleString("pt-BR")}</td>
                    <td className="px-3 py-1.5">
                      {!r.imported_to_inventory && (
                        <button onClick={() => markImport.mutate(r.result_id)} title="Marcar como importado"
                          className="p-1 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30">
                          <Download size={12} />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {panel === "logs" && (
        logs.length === 0 ? (
          <div className="p-4 text-xs text-gray-400 text-center">Nenhum scan realizado.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 bg-gray-100 dark:bg-gray-800">
                {["Status", "Iniciado", "Duração", "Escaneados", "Novos", "Atualizados", "Trigger", "Erro"].map(h => (
                  <th key={h} className="px-3 py-1.5 text-left font-medium">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.map(l => (
                <tr key={l.log_id} className="border-t border-gray-100 dark:border-gray-700/50">
                  <td className="px-3 py-1.5"><StatusBadge status={l.status} /></td>
                  <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">{new Date(l.started_at).toLocaleString("pt-BR")}</td>
                  <td className="px-3 py-1.5 text-gray-500">{l.duration_s != null ? `${l.duration_s}s` : "—"}</td>
                  <td className="px-3 py-1.5 text-gray-500">{l.total_scanned ?? "—"}</td>
                  <td className="px-3 py-1.5 text-blue-500 font-medium">{l.new_devices ?? "—"}</td>
                  <td className="px-3 py-1.5 text-gray-500">{l.updated_devices ?? "—"}</td>
                  <td className="px-3 py-1.5 text-gray-400">{l.triggered_by}</td>
                  <td className="px-3 py-1.5 text-red-500 max-w-[180px] truncate" title={l.error_message || undefined}>{l.error_message || ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------
export function DiscoveryPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ open: boolean; session?: DiscoverySession | null }>({ open: false });

  const { data: stats } = useQuery<Stats>({
    queryKey: ["disc-stats", tenantId],
    queryFn: async () => {
      const r = await fetch("/api/v1/discovery/stats");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 15000,
  });

  const { data: sessions = [], isLoading } = useQuery<DiscoverySession[]>({
    queryKey: ["disc-sessions", tenantId],
    queryFn: async () => {
      const r = await fetch("/api/v1/discovery/sessions");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 10000,
  });

  const deleteSession = useMutation({
    mutationFn: async (id: string) => { await fetch(`/api/v1/discovery/sessions/${id}`, { method: "DELETE" }); },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["disc-sessions", tenantId] }),
  });

  const toggle = (id: string) => setExpanded(prev => {
    const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n;
  });

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Radar size={22} className="text-teal-500" />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Auto-Discovery</h1>
        </div>
        <button onClick={() => setModal({ open: true, session: null })}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
          <Plus size={15} /> Nova sessão
        </button>
      </div>

      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
          <StatCard label="Sessões ativas" value={stats.active_sessions} />
          <StatCard label="Scans em execução" value={stats.running_scans} />
          <StatCard label="Total descobertos" value={stats.total_discovered} />
          <StatCard label="Novos dispositivos" value={stats.new_devices} />
          <StatCard label="Com SNMP" value={stats.snmp_devices} />
          <StatCard label="Aguardando import" value={stats.pending_import} />
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-gray-400">Carregando sessões...</div>
      ) : sessions.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Radar size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhuma sessão de discovery configurada.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {sessions.map((s, idx) => {
            const isOpen = expanded.has(s.session_id);
            return (
              <div key={s.session_id} className={idx > 0 ? "border-t border-gray-100 dark:border-gray-700" : ""}>
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <button onClick={() => toggle(s.session_id)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{s.name}</span>
                      <span className="text-xs bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded">{s.scan_type}</span>
                      {!s.enabled && <span className="text-xs text-gray-400 italic">desabilitada</span>}
                    </div>
                    <div className="flex items-center gap-3 mt-0.5 flex-wrap">
                      <span className="text-xs text-gray-400 font-mono">{s.cidr_ranges.join(", ")}</span>
                      <span className="text-xs text-gray-500">{s.discovered_count} dispositivos</span>
                    </div>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    <StatusBadge status={s.status} />
                    {s.last_scan_at && (
                      <div className="text-xs text-gray-400 mt-0.5">
                        {new Date(s.last_scan_at).toLocaleDateString("pt-BR")}
                        {s.last_scan_duration_s != null ? ` · ${s.last_scan_duration_s}s` : ""}
                      </div>
                    )}
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1">
                    <button onClick={() => setModal({ open: true, session: s })} title="Editar"
                      className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700">
                      <Edit2 size={14} />
                    </button>
                    <button onClick={() => { if (confirm(`Excluir sessão "${s.name}"?`)) deleteSession.mutate(s.session_id); }} title="Excluir"
                      className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30">
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {isOpen && <SessionDetail session={s} tenantId={tenantId} />}
              </div>
            );
          })}
        </div>
      )}

      {modal.open && (
        <SessionModal session={modal.session} onClose={() => setModal({ open: false })} tenantId={tenantId} />
      )}
    </div>
  );
}
