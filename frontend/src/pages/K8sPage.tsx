import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Container, Plus, RefreshCw, ChevronDown, ChevronRight,
  CheckCircle, XCircle, Clock, Edit2, Trash2, Search
} from "lucide-react";

interface LastSync {
  sync_id: string;
  status: string;
  resource_count: number | null;
  created_at: string;
  finished_at: string | null;
}

interface Cluster {
  cluster_id: string;
  name: string;
  description: string | null;
  api_server: string;
  kubeconfig_ref: string | null;
  credential_ref: string | null;
  default_namespace: string;
  tls_verify: boolean;
  enabled: boolean;
  created_at: string;
  cached_resources: number;
  last_sync: LastSync | null;
}

interface K8sResource {
  resource_id: string;
  kind: string;
  api_version: string;
  name: string;
  namespace: string | null;
  labels: Record<string, string>;
  phase: string | null;
  ready: string | null;
  status_summary: string | null;
  last_synced_at: string;
}

interface SyncLog {
  sync_id: string;
  status: string;
  triggered_by: string;
  resource_count: number | null;
  kinds_synced: string[];
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  duration_s: number | null;
}

type ResourceKind = "Pod" | "Deployment" | "StatefulSet" | "DaemonSet" | "Service" | "Ingress" | "Node" | "Namespace" | "Job" | "SyncLogs";

const KIND_TABS: { id: ResourceKind; label: string }[] = [
  { id: "Pod", label: "Pods" },
  { id: "Deployment", label: "Deployments" },
  { id: "StatefulSet", label: "StatefulSets" },
  { id: "DaemonSet", label: "DaemonSets" },
  { id: "Service", label: "Services" },
  { id: "Ingress", label: "Ingress" },
  { id: "Node", label: "Nodes" },
  { id: "Namespace", label: "Namespaces" },
  { id: "SyncLogs", label: "Sync Logs" },
];

const PHASE_STYLES: Record<string, string> = {
  Running: "text-green-600 dark:text-green-400",
  Pending: "text-yellow-500",
  Succeeded: "text-blue-500",
  Failed: "text-red-500",
  Terminating: "text-orange-500",
  Active: "text-green-600 dark:text-green-400",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "success") return <CheckCircle size={13} className="text-green-500" />;
  if (status === "failed") return <XCircle size={13} className="text-red-500" />;
  if (status === "running") return <RefreshCw size={13} className="text-blue-500 animate-spin" />;
  return <Clock size={13} className="text-yellow-500" />;
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

function ResourceTable({ resources, kind }: { resources: K8sResource[]; kind: string }) {
  const showNs = !["Node", "Namespace", "PersistentVolume"].includes(kind);
  if (resources.length === 0) {
    return <div className="p-4 text-xs text-gray-400 text-center">Nenhum {kind} no cache.</div>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-gray-500 bg-gray-100 dark:bg-gray-800">
            <th className="px-3 py-1.5 text-left font-medium">Nome</th>
            {showNs && <th className="px-3 py-1.5 text-left font-medium">Namespace</th>}
            <th className="px-3 py-1.5 text-left font-medium">Status</th>
            <th className="px-3 py-1.5 text-left font-medium">Ready</th>
            <th className="px-3 py-1.5 text-left font-medium">Atualizado</th>
          </tr>
        </thead>
        <tbody>
          {resources.map((r) => (
            <tr key={r.resource_id} className="border-t border-gray-100 dark:border-gray-700/50">
              <td className="px-3 py-1.5 font-mono text-gray-800 dark:text-gray-200">{r.name}</td>
              {showNs && <td className="px-3 py-1.5 text-gray-500">{r.namespace || "—"}</td>}
              <td className="px-3 py-1.5">
                {r.phase ? (
                  <span className={`font-medium ${PHASE_STYLES[r.phase] || "text-gray-500"}`}>{r.phase}</span>
                ) : (
                  <span className="text-gray-400">{r.status_summary || "—"}</span>
                )}
              </td>
              <td className="px-3 py-1.5 text-gray-500">{r.ready || "—"}</td>
              <td className="px-3 py-1.5 text-gray-400">
                {new Date(r.last_synced_at).toLocaleString("pt-BR")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SyncLogsTable({ logs }: { logs: SyncLog[] }) {
  if (logs.length === 0) {
    return <div className="p-4 text-xs text-gray-400 text-center">Nenhum sync realizado.</div>;
  }
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-gray-500 bg-gray-100 dark:bg-gray-800">
          <th className="px-3 py-1.5 text-left font-medium">Status</th>
          <th className="px-3 py-1.5 text-left font-medium">Data</th>
          <th className="px-3 py-1.5 text-left font-medium">Recursos</th>
          <th className="px-3 py-1.5 text-left font-medium">Duração</th>
          <th className="px-3 py-1.5 text-left font-medium">Trigger</th>
          <th className="px-3 py-1.5 text-left font-medium">Erro</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((s) => (
          <tr key={s.sync_id} className="border-t border-gray-100 dark:border-gray-700/50">
            <td className="px-3 py-1.5"><StatusBadge status={s.status} /></td>
            <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">
              {new Date(s.created_at).toLocaleString("pt-BR")}
            </td>
            <td className="px-3 py-1.5 text-gray-500">{s.resource_count ?? "—"}</td>
            <td className="px-3 py-1.5 text-gray-500">{s.duration_s !== null ? `${s.duration_s}s` : "—"}</td>
            <td className="px-3 py-1.5 text-gray-400">{s.triggered_by}</td>
            <td className="px-3 py-1.5 text-red-500 max-w-[180px] truncate" title={s.error_message || undefined}>
              {s.error_message || ""}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ClusterDetail({ cluster, tenantId }: { cluster: Cluster; tenantId: string }) {
  const qc = useQueryClient();
  const [activeKind, setActiveKind] = useState<ResourceKind>("Pod");
  const [search, setSearch] = useState("");

  const { data: resources = [] } = useQuery<K8sResource[]>({
    queryKey: ["k8s-resources", cluster.cluster_id, activeKind, search],
    queryFn: async () => {
      if (activeKind === "SyncLogs") return [];
      const params = new URLSearchParams({ kind: activeKind });
      if (search) params.set("search", search);
      const r = await fetch(`/api/v1/k8s/clusters/${cluster.cluster_id}/resources?${params}`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: activeKind !== "SyncLogs",
  });

  const { data: syncLogs = [] } = useQuery<SyncLog[]>({
    queryKey: ["k8s-sync-logs", cluster.cluster_id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/k8s/clusters/${cluster.cluster_id}/sync-logs`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: activeKind === "SyncLogs",
    refetchInterval: activeKind === "SyncLogs" ? 10000 : false,
  });

  const sync = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/v1/k8s/clusters/${cluster.cluster_id}/sync`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["k8s-clusters", tenantId] });
      qc.invalidateQueries({ queryKey: ["k8s-sync-logs", cluster.cluster_id] });
      setActiveKind("SyncLogs");
    },
  });

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30">
      {/* tabs */}
      <div className="flex items-center gap-0.5 px-3 py-2 border-b border-gray-100 dark:border-gray-700 overflow-x-auto">
        {KIND_TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveKind(t.id)}
            className={`flex-shrink-0 px-2.5 py-1 text-xs rounded font-medium transition-colors ${
              activeKind === t.id
                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
                : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
            }`}
          >
            {t.label}
          </button>
        ))}
        <div className="flex-1" />
        {activeKind !== "SyncLogs" && (
          <div className="flex items-center gap-1 ml-2">
            <Search size={12} className="text-gray-400" />
            <input
              type="text"
              placeholder="buscar..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-28 px-2 py-1 text-xs rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
        )}
        <button
          onClick={() => sync.mutate()}
          disabled={sync.isPending}
          className="flex items-center gap-1 px-2.5 py-1 ml-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex-shrink-0"
        >
          <RefreshCw size={11} className={sync.isPending ? "animate-spin" : ""} />
          Sync
        </button>
      </div>

      {/* content */}
      {activeKind === "SyncLogs" ? (
        <SyncLogsTable logs={syncLogs} />
      ) : (
        <ResourceTable resources={resources} kind={activeKind} />
      )}
    </div>
  );
}

function ClusterModal({
  cluster,
  onClose,
  tenantId,
}: {
  cluster?: Cluster | null;
  onClose: () => void;
  tenantId: string;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: cluster?.name ?? "",
    description: cluster?.description ?? "",
    api_server: cluster?.api_server ?? "",
    kubeconfig_ref: cluster?.kubeconfig_ref ?? "",
    credential_ref: cluster?.credential_ref ?? "",
    default_namespace: cluster?.default_namespace ?? "default",
    tls_verify: cluster?.tls_verify ?? true,
    enabled: cluster?.enabled ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        description: form.description || null,
        kubeconfig_ref: form.kubeconfig_ref || null,
        credential_ref: form.credential_ref || null,
      };
      const url = cluster ? `/api/v1/k8s/clusters/${cluster.cluster_id}` : "/api/v1/k8s/clusters";
      const r = await fetch(url, {
        method: cluster ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["k8s-clusters", tenantId] }); onClose(); },
  });

  const fld = (key: keyof typeof form, label: string, type = "text", extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={String(form[key])}
        onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
        className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        {...extra}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md">
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {cluster ? "Editar cluster" : "Novo cluster Kubernetes"}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5 flex flex-col gap-3">
          {fld("name", "Nome *")}
          {fld("description", "Descrição")}
          {fld("api_server", "API Server *", "text", { placeholder: "https://k8s.example.com:6443" })}
          {fld("default_namespace", "Namespace padrão")}
          {fld("kubeconfig_ref", "Ref. kubeconfig (opcional)", "text", { placeholder: "cred-kubeconfig-prod" })}
          {fld("credential_ref", "Ref. credencial (opcional)", "text", { placeholder: "cred-k8s-token" })}
          <div className="flex items-center gap-4">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.tls_verify} onChange={(e) => setForm((p) => ({ ...p, tls_verify: e.target.checked }))} className="rounded" />
              <span className="text-sm text-gray-700 dark:text-gray-300">Verificar TLS</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))} className="rounded" />
              <span className="text-sm text-gray-700 dark:text-gray-300">Habilitado</span>
            </label>
          </div>
          {save.isError && <p className="text-xs text-red-500">{String(save.error)}</p>}
        </div>
        <div className="p-5 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">Cancelar</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending || !form.name.trim() || !form.api_server.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

export function K8sPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ open: boolean; cluster?: Cluster | null }>({ open: false });

  const { data: clusters = [], isLoading } = useQuery<Cluster[]>({
    queryKey: ["k8s-clusters", tenantId],
    queryFn: async () => {
      const r = await fetch("/api/v1/k8s/clusters");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 20000,
  });

  const deleteCluster = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/v1/k8s/clusters/${id}`, { method: "DELETE" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["k8s-clusters", tenantId] }); },
  });

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Container size={22} className="text-blue-500" />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Kubernetes</h1>
        </div>
        <button
          onClick={() => setModal({ open: true, cluster: null })}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          <Plus size={15} /> Novo cluster
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-400">Carregando clusters...</div>
      ) : clusters.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Container size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum cluster Kubernetes configurado.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {clusters.map((cluster, idx) => {
            const isOpen = expanded.has(cluster.cluster_id);
            return (
              <div key={cluster.cluster_id} className={idx > 0 ? "border-t border-gray-100 dark:border-gray-700" : ""}>
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <button onClick={() => toggleExpand(cluster.cluster_id)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{cluster.name}</span>
                      {!cluster.enabled && <span className="text-xs text-gray-400 italic">desabilitado</span>}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5 font-mono truncate">{cluster.api_server}</p>
                    <p className="text-xs text-gray-400">
                      {cluster.cached_resources} recursos em cache · ns: {cluster.default_namespace}
                    </p>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    {cluster.last_sync ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <StatusBadge status={cluster.last_sync.status} />
                        <span className="text-xs text-gray-400">
                          {new Date(cluster.last_sync.created_at).toLocaleDateString("pt-BR")}
                          {cluster.last_sync.resource_count != null ? ` · ${cluster.last_sync.resource_count} recursos` : ""}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">sem sync</span>
                    )}
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1">
                    <button
                      onClick={() => setModal({ open: true, cluster })}
                      title="Editar"
                      className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => { if (confirm(`Excluir cluster "${cluster.name}"?`)) deleteCluster.mutate(cluster.cluster_id); }}
                      title="Excluir"
                      className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {isOpen && <ClusterDetail cluster={cluster} tenantId={tenantId} />}
              </div>
            );
          })}
        </div>
      )}

      {modal.open && (
        <ClusterModal cluster={modal.cluster} onClose={() => setModal({ open: false })} tenantId={tenantId} />
      )}
    </div>
  );
}
