import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { PackageCheck, AlertTriangle, CheckCircle, Server, RefreshCw, Zap, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";

interface Props { tenantId: string }

const SEV_COLOR: Record<string, string> = {
  critical: "#ef4444", high: "#f97316", medium: "#eab308", low: "#3b82f6", info: "#6b7280",
};
const SEV_BG: Record<string, string> = {
  critical: "rgba(239,68,68,.12)", high: "rgba(249,115,22,.12)", medium: "rgba(234,179,8,.12)", low: "rgba(59,130,246,.12)", info: "rgba(107,114,128,.12)",
};
const STATUS_COLOR: Record<string, string> = {
  available: "#6b7280", approved: "#3b82f6", rejected: "#ef4444", installing: "#f97316",
  installed: "#22c55e", failed: "#ef4444", skipped: "#9ca3af",
  pending: "#6b7280", running: "#f97316", completed: "#22c55e", cancelled: "#9ca3af",
};

function StatCard({ label, value, icon: Icon, color }: { label: string; value: number | string; icon: React.ElementType; color?: string }) {
  return (
    <div className="rounded-xl p-4 flex items-center gap-3" style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}>
      <div className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0" style={{ background: color ? `color-mix(in srgb, ${color} 15%, transparent)` : "color-mix(in srgb, var(--brand) 15%, transparent)" }}>
        <Icon size={16} style={{ color: color ?? "var(--brand)" }} />
      </div>
      <div>
        <div className="text-xl font-bold leading-tight" style={{ color: "var(--text)" }}>{value}</div>
        <div className="text-xs" style={{ color: "var(--text-muted)" }}>{label}</div>
      </div>
    </div>
  );
}

function SevBadge({ severity }: { severity: string }) {
  return (
    <span className="text-[10px] font-bold px-1.5 py-0.5 rounded uppercase tracking-wide" style={{ background: SEV_BG[severity] ?? SEV_BG.info, color: SEV_COLOR[severity] ?? SEV_COLOR.info }}>
      {severity}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  return (
    <span className="text-[11px] font-medium px-2 py-0.5 rounded-full" style={{ background: `color-mix(in srgb, ${STATUS_COLOR[status] ?? "#6b7280"} 15%, transparent)`, color: STATUS_COLOR[status] ?? "#6b7280" }}>
      {status}
    </span>
  );
}

function ScanModal({ onClose, tenantId }: { onClose: () => void; tenantId: string }) {
  const qc = useQueryClient();
  const [host, setHost] = useState("");
  const [type, setType] = useState("host");
  const mut = useMutation({
    mutationFn: () => api.post("/patches/scans", { target_host: host, target_type: type }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["patches-scans", tenantId] }); onClose(); },
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.5)" }}>
      <div className="w-full max-w-md rounded-xl p-5 space-y-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <h3 className="font-semibold" style={{ color: "var(--text)" }}>Iniciar Scan de Patches</h3>
        <div className="space-y-3">
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>Host alvo</label>
            <input className="w-full px-3 py-2 rounded-lg text-sm" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }} placeholder="192.168.1.10 ou hostname" value={host} onChange={e => setHost(e.target.value)} />
          </div>
          <div>
            <label className="text-xs mb-1 block" style={{ color: "var(--text-muted)" }}>Tipo</label>
            <select className="w-full px-3 py-2 rounded-lg text-sm" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }} value={type} onChange={e => setType(e.target.value)}>
              <option value="host">Host único</option>
              <option value="device_group">Grupo de dispositivos</option>
              <option value="all">Todos os hosts</option>
            </select>
          </div>
        </div>
        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm" style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>Cancelar</button>
          <button onClick={() => mut.mutate()} disabled={!host || mut.isPending} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ background: "var(--brand)", color: "#fff", opacity: !host || mut.isPending ? 0.6 : 1 }}>Iniciar scan</button>
        </div>
      </div>
    </div>
  );
}

function JobModal({ onClose, tenantId, host, patchIds }: { onClose: () => void; tenantId: string; host: string; patchIds: string[] }) {
  const qc = useQueryClient();
  const [allowReboot, setAllowReboot] = useState(false);
  const mut = useMutation({
    mutationFn: () => api.post("/patches/jobs", { target_host: host, patch_ids: patchIds, allow_reboot: allowReboot }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["patches", tenantId] });
      qc.invalidateQueries({ queryKey: ["patches-jobs", tenantId] });
      onClose();
    },
  });
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" style={{ background: "rgba(0,0,0,.5)" }}>
      <div className="w-full max-w-md rounded-xl p-5 space-y-4" style={{ background: "var(--surface)", border: "1px solid var(--border)" }}>
        <h3 className="font-semibold" style={{ color: "var(--text)" }}>Criar Job de Instalação</h3>
        <p className="text-sm" style={{ color: "var(--text-muted)" }}>
          {patchIds.length} patches aprovados para <strong style={{ color: "var(--text)" }}>{host}</strong>
        </p>
        <label className="flex items-center gap-2 cursor-pointer">
          <input type="checkbox" checked={allowReboot} onChange={e => setAllowReboot(e.target.checked)} className="rounded" />
          <span className="text-sm" style={{ color: "var(--text)" }}>Permitir reboot automático</span>
        </label>
        <div className="flex gap-2 justify-end pt-1">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm" style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>Cancelar</button>
          <button onClick={() => mut.mutate()} disabled={mut.isPending} className="px-4 py-2 rounded-lg text-sm font-medium" style={{ background: "var(--brand)", color: "#fff", opacity: mut.isPending ? 0.6 : 1 }}>Criar job</button>
        </div>
      </div>
    </div>
  );
}

export function PatchesPage({ tenantId }: Props) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"patches" | "scans" | "jobs">("patches");
  const [filterSev, setFilterSev] = useState("");
  const [filterStatus, setFilterStatus] = useState("available");
  const [selected, setSelected] = useState<string[]>([]);
  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(new Set());
  const [showScanModal, setShowScanModal] = useState(false);
  const [jobModal, setJobModal] = useState<{ host: string; ids: string[] } | null>(null);

  const { data: stats } = useQuery({
    queryKey: ["patches-stats", tenantId],
    queryFn: () => api.get("/patches/stats").then(r => r.data),
    refetchInterval: 10000,
  });

  const { data: patches = [] } = useQuery({
    queryKey: ["patches", tenantId, filterSev, filterStatus],
    queryFn: () => {
      const params = new URLSearchParams();
      if (filterSev) params.set("severity", filterSev);
      if (filterStatus) params.set("status", filterStatus);
      params.set("limit", "300");
      return api.get(`/patches/?${params}`).then(r => r.data);
    },
    enabled: tab === "patches",
  });

  const { data: scans = [] } = useQuery({
    queryKey: ["patches-scans", tenantId],
    queryFn: () => api.get("/patches/scans").then(r => r.data),
    enabled: tab === "scans",
    refetchInterval: 5000,
  });

  const { data: jobs = [] } = useQuery({
    queryKey: ["patches-jobs", tenantId],
    queryFn: () => api.get("/patches/jobs").then(r => r.data),
    enabled: tab === "jobs",
    refetchInterval: 5000,
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => api.post(`/patches/${id}/approve`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["patches", tenantId] }); qc.invalidateQueries({ queryKey: ["patches-stats", tenantId] }); },
  });
  const rejectMut = useMutation({
    mutationFn: (id: string) => api.post(`/patches/${id}/reject`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["patches", tenantId] }); qc.invalidateQueries({ queryKey: ["patches-stats", tenantId] }); },
  });
  const bulkApproveMut = useMutation({
    mutationFn: () => api.post("/patches/bulk-approve", { patch_ids: selected }),
    onSuccess: () => { setSelected([]); qc.invalidateQueries({ queryKey: ["patches", tenantId] }); qc.invalidateQueries({ queryKey: ["patches-stats", tenantId] }); },
  });
  const cancelJobMut = useMutation({
    mutationFn: (id: string) => api.post(`/patches/jobs/${id}/cancel`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["patches-jobs", tenantId] }); },
  });

  const toggleSelect = (id: string) => setSelected(s => s.includes(id) ? s.filter(x => x !== id) : [...s, id]);
  const toggleJob = (id: string) => setExpandedJobs(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const approvedByHost = (host: string) => patches.filter((p: any) => p.target_host === host && p.status === "approved").map((p: any) => p.id);

  const TABS = [
    { id: "patches", label: "Patches" },
    { id: "scans", label: "Scans" },
    { id: "jobs", label: "Jobs" },
  ] as const;

  const fmtDate = (d: string | null) => d ? new Date(d).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";

  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold" style={{ color: "var(--text)" }}>Gerenciamento de Patches</h1>
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>Scan, aprovação e instalação de patches por host</p>
        </div>
        <button onClick={() => setShowScanModal(true)} className="flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-medium" style={{ background: "var(--brand)", color: "#fff" }}>
          <RefreshCw size={14} /> Novo scan
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard label="Disponíveis" value={stats?.available_count ?? 0} icon={PackageCheck} />
        <StatCard label="Críticos" value={stats?.critical_available ?? 0} icon={AlertTriangle} color="#ef4444" />
        <StatCard label="Aprovados" value={stats?.approved_count ?? 0} icon={CheckCircle} color="#3b82f6" />
        <StatCard label="Instalados" value={stats?.installed_count ?? 0} icon={CheckCircle} color="#22c55e" />
        <StatCard label="Jobs ativos" value={stats?.active_jobs ?? 0} icon={Zap} color="#f97316" />
        <StatCard label="Scans" value={stats?.total_scans ?? 0} icon={Server} />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 p-1 rounded-lg w-fit" style={{ background: "var(--surface-2)" }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} className="px-3 py-1.5 rounded-md text-sm transition-all"
            style={{ background: tab === t.id ? "var(--surface)" : "transparent", color: tab === t.id ? "var(--text)" : "var(--text-muted)", fontWeight: tab === t.id ? 500 : 400, boxShadow: tab === t.id ? "0 1px 3px rgba(0,0,0,.1)" : "none" }}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Patches tab */}
      {tab === "patches" && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 items-center">
            <select className="px-3 py-1.5 rounded-lg text-sm" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }} value={filterSev} onChange={e => setFilterSev(e.target.value)}>
              <option value="">Todas as severidades</option>
              {["critical", "high", "medium", "low", "info"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="px-3 py-1.5 rounded-lg text-sm" style={{ background: "var(--surface-2)", border: "1px solid var(--border)", color: "var(--text)" }} value={filterStatus} onChange={e => setFilterStatus(e.target.value)}>
              <option value="">Todos os status</option>
              {["available", "approved", "rejected", "installing", "installed", "failed", "skipped"].map(s => <option key={s} value={s}>{s}</option>)}
            </select>
            {selected.length > 0 && (
              <button onClick={() => bulkApproveMut.mutate()} disabled={bulkApproveMut.isPending} className="px-3 py-1.5 rounded-lg text-sm font-medium" style={{ background: "#3b82f6", color: "#fff" }}>
                Aprovar selecionados ({selected.length})
              </button>
            )}
          </div>

          <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                  <th className="px-3 py-2 text-left w-8">
                    <input type="checkbox" onChange={e => setSelected(e.target.checked ? patches.filter((p: any) => p.status === "available").map((p: any) => p.id) : [])} checked={selected.length > 0 && selected.length === patches.filter((p: any) => p.status === "available").length} />
                  </th>
                  {["Sev", "Pacote", "Host", "Versão", "CVEs", "Reboot", "Status", ""].map(h => (
                    <th key={h} className="px-3 py-2 text-left text-xs font-semibold" style={{ color: "var(--text-muted)" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {patches.map((p: any) => (
                  <tr key={p.id} style={{ borderBottom: "1px solid var(--border)" }}>
                    <td className="px-3 py-2">
                      {p.status === "available" && (
                        <input type="checkbox" checked={selected.includes(p.id)} onChange={() => toggleSelect(p.id)} />
                      )}
                    </td>
                    <td className="px-3 py-2"><SevBadge severity={p.severity} /></td>
                    <td className="px-3 py-2 font-mono text-xs" style={{ color: "var(--text)" }}>{p.package_name}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>{p.target_host}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>
                      <span style={{ color: "var(--text-dim)" }}>{p.current_version ?? "?"}</span>
                      <span className="mx-1">→</span>
                      <span style={{ color: "var(--text)" }}>{p.available_version}</span>
                    </td>
                    <td className="px-3 py-2">
                      {p.cve_ids?.length > 0 && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded font-bold" style={{ background: "rgba(239,68,68,.12)", color: "#ef4444" }}>
                          {p.cve_ids.length} CVE
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {p.requires_reboot && <RotateCcw size={12} style={{ color: "#f97316" }} title="Requer reboot" />}
                    </td>
                    <td className="px-3 py-2"><StatusBadge status={p.status} /></td>
                    <td className="px-3 py-2">
                      {p.status === "available" && (
                        <div className="flex gap-1">
                          <button onClick={() => approveMut.mutate(p.id)} className="text-[11px] px-2 py-0.5 rounded" style={{ background: "rgba(59,130,246,.15)", color: "#3b82f6" }}>Aprovar</button>
                          <button onClick={() => rejectMut.mutate(p.id)} className="text-[11px] px-2 py-0.5 rounded" style={{ background: "rgba(239,68,68,.1)", color: "#ef4444" }}>Rejeitar</button>
                        </div>
                      )}
                      {p.status === "approved" && (
                        <button onClick={() => { const ids = approvedByHost(p.target_host); setJobModal({ host: p.target_host, ids }); }} className="text-[11px] px-2 py-0.5 rounded" style={{ background: "rgba(34,197,94,.12)", color: "#22c55e" }}>
                          Instalar host
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
                {patches.length === 0 && (
                  <tr><td colSpan={9} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>Nenhum patch encontrado</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Scans tab */}
      {tab === "scans" && (
        <div className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)" }}>
          <table className="w-full text-sm">
            <thead>
              <tr style={{ background: "var(--surface-2)", borderBottom: "1px solid var(--border)" }}>
                {["Host", "Tipo", "Status", "Patches", "Críticos", "Iniciado", "Concluído"].map(h => (
                  <th key={h} className="px-3 py-2 text-left text-xs font-semibold" style={{ color: "var(--text-muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {scans.map((s: any) => (
                <tr key={s.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td className="px-3 py-2 font-mono text-xs" style={{ color: "var(--text)" }}>{s.target_host}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>{s.target_type}</td>
                  <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
                  <td className="px-3 py-2 text-sm" style={{ color: "var(--text)" }}>{s.patch_count ?? "—"}</td>
                  <td className="px-3 py-2">
                    {s.critical_count > 0 && <span className="text-[11px] font-bold" style={{ color: "#ef4444" }}>{s.critical_count}</span>}
                    {!s.critical_count && <span style={{ color: "var(--text-dim)" }}>—</span>}
                  </td>
                  <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>{fmtDate(s.started_at ?? s.created_at)}</td>
                  <td className="px-3 py-2 text-xs" style={{ color: "var(--text-muted)" }}>{fmtDate(s.completed_at)}</td>
                </tr>
              ))}
              {scans.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-sm" style={{ color: "var(--text-muted)" }}>Nenhum scan realizado ainda</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {/* Jobs tab */}
      {tab === "jobs" && (
        <div className="space-y-2">
          {jobs.map((j: any) => {
            const isOpen = expandedJobs.has(j.id);
            return (
              <div key={j.id} className="rounded-xl overflow-hidden" style={{ border: "1px solid var(--border)", background: "var(--surface)" }}>
                <div className="flex items-center gap-3 px-4 py-3 cursor-pointer" onClick={() => toggleJob(j.id)}>
                  {isOpen ? <ChevronDown size={14} style={{ color: "var(--text-muted)" }} /> : <ChevronRight size={14} style={{ color: "var(--text-muted)" }} />}
                  <span className="font-mono text-sm flex-1" style={{ color: "var(--text)" }}>{j.target_host}</span>
                  <StatusBadge status={j.status} />
                  <span className="text-xs" style={{ color: "var(--text-muted)" }}>{j.patch_ids?.length ?? 0} patches</span>
                  {j.installed_count != null && <span className="text-xs" style={{ color: "#22c55e" }}>✓ {j.installed_count}</span>}
                  {j.failed_count > 0 && <span className="text-xs" style={{ color: "#ef4444" }}>✗ {j.failed_count}</span>}
                  {j.allow_reboot && <RotateCcw size={12} style={{ color: "#f97316" }} title="Reboot permitido" />}
                  <span className="text-xs" style={{ color: "var(--text-dim)" }}>{fmtDate(j.created_at)}</span>
                  {j.status === "pending" && (
                    <button onClick={e => { e.stopPropagation(); cancelJobMut.mutate(j.id); }} className="text-[11px] px-2 py-0.5 rounded" style={{ background: "rgba(239,68,68,.1)", color: "#ef4444" }}>Cancelar</button>
                  )}
                </div>
                {isOpen && j.output && (
                  <div className="px-4 pb-3">
                    <pre className="text-xs p-3 rounded-lg overflow-x-auto whitespace-pre-wrap" style={{ background: "var(--surface-2)", color: "var(--text-muted)", fontFamily: "monospace" }}>
                      {j.output}
                    </pre>
                  </div>
                )}
                {isOpen && j.error_message && (
                  <div className="px-4 pb-3">
                    <div className="text-xs p-3 rounded-lg" style={{ background: "rgba(239,68,68,.08)", color: "#ef4444" }}>{j.error_message}</div>
                  </div>
                )}
              </div>
            );
          })}
          {jobs.length === 0 && (
            <div className="text-center py-8 text-sm" style={{ color: "var(--text-muted)" }}>Nenhum job de instalação criado ainda</div>
          )}
        </div>
      )}

      {showScanModal && <ScanModal onClose={() => setShowScanModal(false)} tenantId={tenantId} />}
      {jobModal && <JobModal onClose={() => setJobModal(null)} tenantId={tenantId} host={jobModal.host} patchIds={jobModal.ids} />}
    </div>
  );
}
