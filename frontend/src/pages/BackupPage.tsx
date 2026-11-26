import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  HardDrive, Plus, Play, Trash2, ChevronDown, ChevronRight,
  CheckCircle, XCircle, Clock, AlertCircle, RefreshCw, Edit2
} from "lucide-react";

interface LastSnapshot {
  snapshot_id: string;
  status: string;
  created_at: string;
  size_bytes: number | null;
  finished_at: string | null;
}

interface BackupJob {
  job_id: string;
  name: string;
  description: string | null;
  schedule_cron: string | null;
  target_type: string;
  target_path: string;
  pre_commands: string[];
  post_commands: string[];
  retention_days: number;
  max_snapshots: number;
  enabled: boolean;
  created_at: string;
  last_snapshot: LastSnapshot | null;
}

interface Snapshot {
  snapshot_id: string;
  job_id: string;
  status: string;
  triggered_by: string;
  started_at: string | null;
  finished_at: string | null;
  size_bytes: number | null;
  checksum_sha256: string | null;
  snapshot_path: string | null;
  error_message: string | null;
  created_at: string;
  duration_s: number | null;
}

interface Stats {
  active_jobs: number;
  snapshots_24h: number;
  success_24h: number;
  failed_24h: number;
  pending_total: number;
  total_bytes_stored: number;
}

const TARGET_TYPES = ["local", "s3", "sftp", "nfs", "rsync"];

function formatBytes(bytes: number | null): string {
  if (bytes === null || bytes === 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${units[i]}`;
}

function formatDuration(s: number | null): string {
  if (s === null) return "—";
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

function StatusIcon({ status }: { status: string }) {
  if (status === "success") return <CheckCircle size={14} className="text-green-500" />;
  if (status === "failed") return <XCircle size={14} className="text-red-500" />;
  if (status === "running") return <RefreshCw size={14} className="text-blue-500 animate-spin" />;
  if (status === "pending") return <Clock size={14} className="text-yellow-500" />;
  if (status === "cancelled") return <AlertCircle size={14} className="text-gray-400" />;
  return <Clock size={14} className="text-gray-400" />;
}

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    success: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    pending: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cls[status] || cls.pending}`}>
      <StatusIcon status={status} />
      {status}
    </span>
  );
}

function SnapshotList({ jobId, tenantId }: { jobId: string; tenantId: string }) {
  const { data: snaps = [], isLoading } = useQuery<Snapshot[]>({
    queryKey: ["backup-snapshots", tenantId, jobId],
    queryFn: async () => {
      const r = await fetch(`/api/v1/backup/jobs/${jobId}/snapshots`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
  });
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: async (sid: string) => {
      await fetch(`/api/v1/backup/snapshots/${sid}`, { method: "DELETE" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["backup-snapshots", tenantId, jobId] }); qc.invalidateQueries({ queryKey: ["backup-jobs", tenantId] }); },
  });

  if (isLoading) return <div className="p-4 text-sm text-gray-400">Carregando...</div>;
  if (!snaps.length) return <div className="p-4 text-sm text-gray-400">Nenhum snapshot.</div>;

  return (
    <div className="border-t border-gray-200 dark:border-gray-700">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 bg-gray-50 dark:bg-gray-800/50">
            <th className="px-3 py-2 text-left font-medium">Status</th>
            <th className="px-3 py-2 text-left font-medium">Iniciado</th>
            <th className="px-3 py-2 text-left font-medium">Duração</th>
            <th className="px-3 py-2 text-left font-medium">Tamanho</th>
            <th className="px-3 py-2 text-left font-medium">Trigger</th>
            <th className="px-3 py-2 text-left font-medium">SHA256</th>
            <th className="px-3 py-2 text-left font-medium">Caminho</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {snaps.map((s) => (
            <tr key={s.snapshot_id} className="border-t border-gray-100 dark:border-gray-700/50">
              <td className="px-3 py-2"><StatusBadge status={s.status} /></td>
              <td className="px-3 py-2 text-gray-600 dark:text-gray-300">
                {s.started_at ? new Date(s.started_at).toLocaleString("pt-BR") : "—"}
              </td>
              <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{formatDuration(s.duration_s)}</td>
              <td className="px-3 py-2 text-gray-600 dark:text-gray-300">{formatBytes(s.size_bytes)}</td>
              <td className="px-3 py-2 text-gray-500">{s.triggered_by}</td>
              <td className="px-3 py-2 font-mono text-gray-400 max-w-[120px] truncate" title={s.checksum_sha256 || undefined}>
                {s.checksum_sha256 ? s.checksum_sha256.slice(0, 12) + "…" : "—"}
              </td>
              <td className="px-3 py-2 text-gray-400 max-w-[160px] truncate" title={s.snapshot_path || undefined}>
                {s.snapshot_path || "—"}
              </td>
              <td className="px-3 py-2">
                {s.error_message && (
                  <span className="text-red-500" title={s.error_message}>⚠</span>
                )}
                <button
                  onClick={() => { if (confirm("Excluir snapshot?")) del.mutate(s.snapshot_id); }}
                  className="ml-2 text-gray-400 hover:text-red-500"
                >
                  <Trash2 size={12} />
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function JobModal({
  job,
  onClose,
  tenantId,
}: {
  job?: BackupJob | null;
  onClose: () => void;
  tenantId: string;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: job?.name ?? "",
    description: job?.description ?? "",
    schedule_cron: job?.schedule_cron ?? "",
    target_type: job?.target_type ?? "local",
    target_path: job?.target_path ?? "",
    pre_commands: (job?.pre_commands ?? []).join("\n"),
    post_commands: (job?.post_commands ?? []).join("\n"),
    retention_days: job?.retention_days ?? 30,
    max_snapshots: job?.max_snapshots ?? 10,
    enabled: job?.enabled ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        pre_commands: form.pre_commands.split("\n").map((s) => s.trim()).filter(Boolean),
        post_commands: form.post_commands.split("\n").map((s) => s.trim()).filter(Boolean),
      };
      const url = job ? `/api/v1/backup/jobs/${job.job_id}` : "/api/v1/backup/jobs";
      const method = job ? "PUT" : "POST";
      const r = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["backup-jobs", tenantId] });
      onClose();
    },
  });

  const fld = (key: keyof typeof form, label: string, type: string = "text", extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={String(form[key])}
        onChange={(e) => setForm((p) => ({ ...p, [key]: type === "number" ? Number(e.target.value) : e.target.value }))}
        className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        {...extra}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {job ? "Editar job" : "Novo job de backup"}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl leading-none">×</button>
        </div>
        <div className="p-5 flex flex-col gap-4">
          {fld("name", "Nome *")}
          {fld("description", "Descrição")}
          {fld("schedule_cron", "Agendamento (cron)", "text", { placeholder: "ex: 0 2 * * *" })}
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tipo de destino</label>
            <select
              value={form.target_type}
              onChange={(e) => setForm((p) => ({ ...p, target_type: e.target.value }))}
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {TARGET_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          {fld("target_path", "Caminho / URL de destino", "text", { placeholder: "/backups ou s3://bucket/path" })}
          <div className="grid grid-cols-2 gap-3">
            {fld("retention_days", "Retenção (dias)", "number")}
            {fld("max_snapshots", "Máx. snapshots", "number")}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Comandos pré-backup (um por linha)</label>
            <textarea
              value={form.pre_commands}
              onChange={(e) => setForm((p) => ({ ...p, pre_commands: e.target.value }))}
              rows={3}
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="pg_dump -U postgres mydb > /tmp/db.sql"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Comandos pós-backup (um por linha)</label>
            <textarea
              value={form.post_commands}
              onChange={(e) => setForm((p) => ({ ...p, post_commands: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="rm /tmp/db.sql"
            />
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))}
              className="rounded"
            />
            <span className="text-sm text-gray-700 dark:text-gray-300">Habilitado</span>
          </label>
          {save.isError && (
            <p className="text-xs text-red-500">{String(save.error)}</p>
          )}
        </div>
        <div className="p-5 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">
            Cancelar
          </button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.name.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function BackupPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ open: boolean; job?: BackupJob | null }>({ open: false });

  const { data: jobs = [], isLoading } = useQuery<BackupJob[]>({
    queryKey: ["backup-jobs", tenantId],
    queryFn: async () => {
      const r = await fetch("/api/v1/backup/jobs");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 15000,
  });

  const { data: stats } = useQuery<Stats>({
    queryKey: ["backup-stats", tenantId],
    queryFn: async () => {
      const r = await fetch("/api/v1/backup/stats");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 15000,
  });

  const trigger = useMutation({
    mutationFn: async (jobId: string) => {
      const r = await fetch(`/api/v1/backup/jobs/${jobId}/trigger`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["backup-jobs", tenantId] }); },
  });

  const deleteJob = useMutation({
    mutationFn: async (jobId: string) => {
      await fetch(`/api/v1/backup/jobs/${jobId}`, { method: "DELETE" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["backup-jobs", tenantId] }); },
  });

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const statCards = [
    { label: "Jobs ativos", value: stats?.active_jobs ?? "—", color: "text-blue-600 dark:text-blue-400" },
    { label: "Snapshots 24h", value: stats?.snapshots_24h ?? "—", color: "text-gray-700 dark:text-gray-300" },
    { label: "Sucesso 24h", value: stats?.success_24h ?? "—", color: "text-green-600 dark:text-green-400" },
    { label: "Falhas 24h", value: stats?.failed_24h ?? "—", color: "text-red-600 dark:text-red-400" },
    { label: "Pendentes", value: stats?.pending_total ?? "—", color: "text-yellow-600 dark:text-yellow-400" },
    { label: "Total armazenado", value: formatBytes(stats?.total_bytes_stored ?? null), color: "text-gray-700 dark:text-gray-300" },
  ];

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <HardDrive size={22} className="text-blue-500" />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Backup</h1>
        </div>
        <button
          onClick={() => setModal({ open: true, job: null })}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          <Plus size={15} /> Novo job
        </button>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
        {statCards.map((c) => (
          <div key={c.label} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-3 text-center">
            <div className={`text-2xl font-bold ${c.color}`}>{c.value}</div>
            <div className="text-xs text-gray-500 mt-0.5">{c.label}</div>
          </div>
        ))}
      </div>

      {/* Job list */}
      {isLoading ? (
        <div className="text-sm text-gray-400">Carregando jobs...</div>
      ) : jobs.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <HardDrive size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum job de backup configurado.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {jobs.map((job, idx) => {
            const isOpen = expanded.has(job.job_id);
            return (
              <div key={job.job_id} className={idx > 0 ? "border-t border-gray-100 dark:border-gray-700" : ""}>
                {/* Job row */}
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <button onClick={() => toggleExpand(job.job_id)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{job.name}</span>
                      <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">{job.target_type}</span>
                      {!job.enabled && <span className="text-xs text-gray-400 italic">desabilitado</span>}
                      {job.schedule_cron && (
                        <span className="text-xs text-gray-400 font-mono">{job.schedule_cron}</span>
                      )}
                    </div>
                    {job.description && (
                      <p className="text-xs text-gray-400 mt-0.5 truncate">{job.description}</p>
                    )}
                    <p className="text-xs text-gray-400 mt-0.5 font-mono truncate">{job.target_path || "—"}</p>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    {job.last_snapshot ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <StatusBadge status={job.last_snapshot.status} />
                        <span className="text-xs text-gray-400">
                          {new Date(job.last_snapshot.created_at).toLocaleDateString("pt-BR")}
                          {job.last_snapshot.size_bytes ? ` · ${formatBytes(job.last_snapshot.size_bytes)}` : ""}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">sem snapshot</span>
                    )}
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1">
                    <button
                      onClick={() => trigger.mutate(job.job_id)}
                      disabled={trigger.isPending}
                      title="Executar agora"
                      className="p-1.5 rounded text-gray-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-900/30"
                    >
                      <Play size={14} />
                    </button>
                    <button
                      onClick={() => setModal({ open: true, job })}
                      title="Editar"
                      className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => { if (confirm(`Excluir job "${job.name}"?`)) deleteJob.mutate(job.job_id); }}
                      title="Excluir"
                      className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>

                {/* Snapshots expandable */}
                {isOpen && <SnapshotList jobId={job.job_id} tenantId={tenantId} />}
              </div>
            );
          })}
        </div>
      )}

      {modal.open && (
        <JobModal job={modal.job} onClose={() => setModal({ open: false })} tenantId={tenantId} />
      )}
    </div>
  );
}
