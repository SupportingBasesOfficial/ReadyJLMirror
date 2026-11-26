import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Download, Upload, FileText, Plus, RefreshCw, CheckCircle,
  XCircle, Clock, AlertTriangle, Loader2, ChevronDown, ChevronRight,
  Trash2, Play,
} from "lucide-react";

interface Props { tenantId: string; }

const API = "/api/v1/data-transfer";

const ENTITY_TYPES = [
  "devices", "users", "alerts", "monitors", "services",
  "vulnerabilities", "assets", "patches", "discovery_results",
];
const FORMATS = ["csv", "xlsx", "json"];

type ExportStatus = "pending" | "running" | "completed" | "failed";
type ImportStatus = "pending" | "validating" | "importing" | "completed" | "failed" | "cancelled";

interface ExportJob {
  id: string; entity_type: string; format: string; status: ExportStatus;
  row_count: number | null; file_size_bytes: number | null; file_key: string | null;
  error_message: string | null; template_name: string | null;
  created_by_name: string | null; created_at: string; completed_at: string | null;
}

interface ImportJob {
  id: string; entity_type: string; format: string; status: ImportStatus;
  file_name: string; file_size_bytes: number | null;
  row_count: number | null; imported_count: number | null; error_count: number | null;
  errors: Array<{ row: number; message: string }>; error_message: string | null;
  created_by_name: string | null; created_at: string; completed_at: string | null;
}

interface ExportTemplate {
  id: string; name: string; entity_type: string; format: string;
  columns: string[]; filters: Record<string, unknown>;
  created_by_name: string | null; created_at: string;
}

interface Stats {
  pending_exports: number; running_exports: number; completed_exports: number;
  failed_exports: number; active_imports: number; total_templates: number;
}

// ── helpers ──────────────────────────────────────────────────────────────────

function fmtBytes(b: number | null) {
  if (!b) return "—";
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(1)} MB`;
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

const EXPORT_STATUS: Record<ExportStatus, { label: string; cls: string; Icon: typeof Clock }> = {
  pending:   { label: "Aguardando", cls: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300", Icon: Clock },
  running:   { label: "Exportando", cls: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300", Icon: Loader2 },
  completed: { label: "Concluído",  cls: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300", Icon: CheckCircle },
  failed:    { label: "Falhou",     cls: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300", Icon: XCircle },
};

const IMPORT_STATUS: Record<ImportStatus, { label: string; cls: string; Icon: typeof Clock }> = {
  pending:    { label: "Aguardando",  cls: "bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300", Icon: Clock },
  validating: { label: "Validando",   cls: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900 dark:text-yellow-300", Icon: AlertTriangle },
  importing:  { label: "Importando",  cls: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300", Icon: Loader2 },
  completed:  { label: "Concluído",   cls: "bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300", Icon: CheckCircle },
  failed:     { label: "Falhou",      cls: "bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300", Icon: XCircle },
  cancelled:  { label: "Cancelado",   cls: "bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-400", Icon: XCircle },
};

function StatusBadge({ status, type }: { status: string; type: "export" | "import" }) {
  const map = type === "export" ? EXPORT_STATUS : IMPORT_STATUS;
  const cfg = (map as Record<string, { label: string; cls: string; Icon: typeof Clock }>)[status];
  if (!cfg) return <span>{status}</span>;
  const { label, cls, Icon } = cfg;
  const spin = status === "running" || status === "importing" || status === "validating";
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cls}`}>
      <Icon size={12} className={spin ? "animate-spin" : ""} />
      {label}
    </span>
  );
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: typeof Download; label: string; value: number; color: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${color}`}><Icon size={20} /></div>
      <div><p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
        <p className="text-xl font-semibold text-gray-900 dark:text-white">{value}</p></div>
    </div>
  );
}

// ── Export modal ──────────────────────────────────────────────────────────────

function ExportModal({ templates, onClose, onSave }: {
  templates: ExportTemplate[];
  onClose: () => void;
  onSave: (data: { entity_type: string; format: string; template_id?: string }) => void;
}) {
  const [entityType, setEntityType] = useState(ENTITY_TYPES[0]);
  const [format, setFormat] = useState("csv");
  const [templateId, setTemplateId] = useState("");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Nova Exportação</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Template (opcional)</label>
            <select value={templateId} onChange={e => setTemplateId(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
              <option value="">— sem template —</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Entidade</label>
            <select value={entityType} onChange={e => setEntityType(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
              {ENTITY_TYPES.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Formato</label>
            <div className="flex gap-2">
              {FORMATS.map(f => (
                <button key={f} onClick={() => setFormat(f)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors
                    ${format === f
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"}`}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancelar</button>
          <button onClick={() => onSave({ entity_type: entityType, format, template_id: templateId || undefined })}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
            Iniciar exportação
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Import modal ──────────────────────────────────────────────────────────────

function ImportModal({ onClose, onSave }: {
  onClose: () => void;
  onSave: (data: { entity_type: string; format: string; file_name: string }) => void;
}) {
  const [entityType, setEntityType] = useState(ENTITY_TYPES[0]);
  const [format, setFormat] = useState("csv");
  const [fileName, setFileName] = useState("");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Nova Importação</h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Entidade</label>
            <select value={entityType} onChange={e => setEntityType(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
              {ENTITY_TYPES.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Formato</label>
            <div className="flex gap-2">
              {FORMATS.map(f => (
                <button key={f} onClick={() => setFormat(f)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors
                    ${format === f
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"}`}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome do arquivo</label>
            <input value={fileName} onChange={e => setFileName(e.target.value)} placeholder="devices_2026-11.csv"
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancelar</button>
          <button onClick={() => onSave({ entity_type: entityType, format, file_name: fileName })}
            disabled={!fileName}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
            Criar importação
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Template modal ────────────────────────────────────────────────────────────

function TemplateModal({ initial, onClose, onSave }: {
  initial?: ExportTemplate | null;
  onClose: () => void;
  onSave: (data: { name: string; entity_type: string; format: string }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [entityType, setEntityType] = useState(initial?.entity_type ?? ENTITY_TYPES[0]);
  const [format, setFormat] = useState(initial?.format ?? "csv");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {initial ? "Editar template" : "Novo template"}
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Entidade</label>
            <select value={entityType} onChange={e => setEntityType(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
              {ENTITY_TYPES.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Formato padrão</label>
            <div className="flex gap-2">
              {FORMATS.map(f => (
                <button key={f} onClick={() => setFormat(f)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors
                    ${format === f
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"}`}>
                  {f.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancelar</button>
          <button onClick={() => onSave({ name, entity_type: entityType, format })}
            disabled={!name}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Import row detail ─────────────────────────────────────────────────────────

function ImportRow({ job, onConfirm, onCancel }: {
  job: ImportJob;
  onConfirm: (id: string) => void;
  onCancel: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const hasErrors = job.errors && job.errors.length > 0;

  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 p-3 bg-white dark:bg-gray-800">
        <button onClick={() => setExpanded(v => !v)} className="text-gray-400 hover:text-gray-600">
          {expanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 dark:text-white truncate">{job.file_name}</p>
          <p className="text-xs text-gray-500">{job.entity_type} · {job.format.toUpperCase()} · {fmtDate(job.created_at)}</p>
        </div>
        <StatusBadge status={job.status} type="import" />
        {job.row_count != null && (
          <span className="text-xs text-gray-500">
            {job.imported_count ?? 0}/{job.row_count} linhas
          </span>
        )}
        {job.status === "validating" && (
          <button onClick={() => onConfirm(job.id)}
            className="flex items-center gap-1 px-2 py-1 bg-green-600 text-white text-xs rounded hover:bg-green-700">
            <Play size={12} /> Importar
          </button>
        )}
        {(job.status === "pending" || job.status === "validating") && (
          <button onClick={() => onCancel(job.id)}
            className="text-xs text-red-500 hover:text-red-700 px-2">
            Cancelar
          </button>
        )}
      </div>
      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-3 bg-gray-50 dark:bg-gray-900/50 text-xs space-y-1">
          <p><span className="text-gray-500">Tamanho:</span> <span className="text-gray-800 dark:text-gray-200">{fmtBytes(job.file_size_bytes)}</span></p>
          {job.error_message && <p className="text-red-600">{job.error_message}</p>}
          {hasErrors && (
            <div className="mt-2">
              <p className="font-medium text-gray-700 dark:text-gray-300 mb-1">{job.error_count} erro(s):</p>
              <div className="max-h-40 overflow-y-auto space-y-1">
                {job.errors.slice(0, 20).map((e, i) => (
                  <p key={i} className="text-red-500">Linha {e.row}: {e.message}</p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = "exports" | "imports" | "templates";

export function DataTransferPage({ tenantId }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("exports");
  const [showExportModal, setShowExportModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [templateModal, setTemplateModal] = useState<ExportTemplate | null | "new">(null);

  const { data: stats } = useQuery<Stats>({
    queryKey: ["data-transfer-stats", tenantId],
    queryFn: () => fetch(`${API}/stats`).then(r => r.json()),
    refetchInterval: 10_000,
  });

  const { data: exports = [], refetch: refetchExports } = useQuery<ExportJob[]>({
    queryKey: ["export-jobs", tenantId],
    queryFn: () => fetch(`${API}/exports?limit=100`).then(r => r.json()),
    refetchInterval: (data) =>
      data?.some((j: ExportJob) => j.status === "running" || j.status === "pending") ? 5_000 : 30_000,
  });

  const { data: imports = [], refetch: refetchImports } = useQuery<ImportJob[]>({
    queryKey: ["import-jobs", tenantId],
    queryFn: () => fetch(`${API}/imports?limit=100`).then(r => r.json()),
    refetchInterval: (data) =>
      data?.some((j: ImportJob) => ["pending", "validating", "importing"].includes(j.status)) ? 5_000 : 30_000,
  });

  const { data: templates = [], refetch: refetchTemplates } = useQuery<ExportTemplate[]>({
    queryKey: ["export-templates", tenantId],
    queryFn: () => fetch(`${API}/templates`).then(r => r.json()),
  });

  const createExport = useMutation({
    mutationFn: (body: object) => fetch(`${API}/exports`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["export-jobs"] }); setShowExportModal(false); },
  });

  const createImport = useMutation({
    mutationFn: (body: object) => fetch(`${API}/imports`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["import-jobs"] }); setShowImportModal(false); },
  });

  const confirmImport = useMutation({
    mutationFn: (id: string) => fetch(`${API}/imports/${id}/confirm`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["import-jobs"] }),
  });

  const cancelImport = useMutation({
    mutationFn: (id: string) => fetch(`${API}/imports/${id}/cancel`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["import-jobs"] }),
  });

  const saveTemplate = useMutation({
    mutationFn: (body: { id?: string; name: string; entity_type: string; format: string }) => {
      const { id, ...data } = body;
      return fetch(id ? `${API}/templates/${id}` : `${API}/templates`, {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(r => r.json());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["export-templates"] }); setTemplateModal(null); },
  });

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => fetch(`${API}/templates/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["export-templates"] }),
  });

  const TABS: { id: Tab; label: string; count?: number }[] = [
    { id: "exports", label: "Exportações", count: exports.length },
    { id: "imports", label: "Importações", count: imports.length },
    { id: "templates", label: "Templates", count: templates.length },
  ];

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t("nav.data_transfer", "Transferência de Dados")}
        </h1>
        <div className="flex gap-2">
          {tab === "exports" && (
            <button onClick={() => setShowExportModal(true)}
              className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
              <Download size={16} /> Nova exportação
            </button>
          )}
          {tab === "imports" && (
            <button onClick={() => setShowImportModal(true)}
              className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
              <Upload size={16} /> Nova importação
            </button>
          )}
          {tab === "templates" && (
            <button onClick={() => setTemplateModal("new")}
              className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
              <Plus size={16} /> Novo template
            </button>
          )}
        </div>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard icon={Clock} label="Exports pendentes" value={stats.pending_exports} color="bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300" />
          <StatCard icon={Loader2} label="Exports em andamento" value={stats.running_exports} color="bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300" />
          <StatCard icon={CheckCircle} label="Exports concluídos" value={stats.completed_exports} color="bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300" />
          <StatCard icon={XCircle} label="Exports falharam" value={stats.failed_exports} color="bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-300" />
          <StatCard icon={Upload} label="Imports ativos" value={stats.active_imports} color="bg-yellow-100 text-yellow-600 dark:bg-yellow-900 dark:text-yellow-300" />
          <StatCard icon={FileText} label="Templates" value={stats.total_templates} color="bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300" />
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700 flex gap-6">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`pb-3 text-sm font-medium transition-colors flex items-center gap-1.5
              ${tab === t.id
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>
            {t.label}
            {t.count !== undefined && (
              <span className="bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-300 text-xs px-1.5 py-0.5 rounded-full">
                {t.count}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Exports tab */}
      {tab === "exports" && (
        <div className="space-y-2">
          {exports.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <Download size={40} className="mx-auto mb-3 opacity-30" />
              <p>Nenhuma exportação ainda</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Entidade</th>
                    <th className="text-left px-4 py-3 font-medium">Formato</th>
                    <th className="text-left px-4 py-3 font-medium">Template</th>
                    <th className="text-left px-4 py-3 font-medium">Status</th>
                    <th className="text-right px-4 py-3 font-medium">Linhas</th>
                    <th className="text-right px-4 py-3 font-medium">Tamanho</th>
                    <th className="text-left px-4 py-3 font-medium">Criado em</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {exports.map(j => (
                    <tr key={j.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{j.entity_type}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-xs">
                          {j.format.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{j.template_name ?? "—"}</td>
                      <td className="px-4 py-3"><StatusBadge status={j.status} type="export" /></td>
                      <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-300">
                        {j.row_count != null ? j.row_count.toLocaleString("pt-BR") : "—"}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600 dark:text-gray-300">{fmtBytes(j.file_size_bytes)}</td>
                      <td className="px-4 py-3 text-gray-500">{fmtDate(j.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Imports tab */}
      {tab === "imports" && (
        <div className="space-y-2">
          {imports.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <Upload size={40} className="mx-auto mb-3 opacity-30" />
              <p>Nenhuma importação ainda</p>
            </div>
          ) : imports.map(j => (
            <ImportRow key={j.id} job={j}
              onConfirm={id => confirmImport.mutate(id)}
              onCancel={id => cancelImport.mutate(id)} />
          ))}
        </div>
      )}

      {/* Templates tab */}
      {tab === "templates" && (
        <div className="space-y-2">
          {templates.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <FileText size={40} className="mx-auto mb-3 opacity-30" />
              <p>Nenhum template ainda</p>
            </div>
          ) : (
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium">Nome</th>
                    <th className="text-left px-4 py-3 font-medium">Entidade</th>
                    <th className="text-left px-4 py-3 font-medium">Formato</th>
                    <th className="text-left px-4 py-3 font-medium">Criado por</th>
                    <th className="text-left px-4 py-3 font-medium">Data</th>
                    <th className="px-4 py-3"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                  {templates.map(t => (
                    <tr key={t.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-3 font-medium text-gray-900 dark:text-white">{t.name}</td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{t.entity_type}</td>
                      <td className="px-4 py-3">
                        <span className="px-2 py-0.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded text-xs">
                          {t.format.toUpperCase()}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-gray-500">{t.created_by_name ?? "—"}</td>
                      <td className="px-4 py-3 text-gray-500">{fmtDate(t.created_at)}</td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <button onClick={() => setTemplateModal(t)}
                            className="text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400">
                            Editar
                          </button>
                          <button onClick={() => { if (confirm("Excluir template?")) deleteTemplate.mutate(t.id); }}
                            className="text-gray-400 hover:text-red-500">
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Modals */}
      {showExportModal && (
        <ExportModal templates={templates} onClose={() => setShowExportModal(false)}
          onSave={data => createExport.mutate(data)} />
      )}
      {showImportModal && (
        <ImportModal onClose={() => setShowImportModal(false)}
          onSave={data => createImport.mutate(data)} />
      )}
      {templateModal && (
        <TemplateModal
          initial={templateModal === "new" ? null : templateModal}
          onClose={() => setTemplateModal(null)}
          onSave={data => saveTemplate.mutate(templateModal === "new" ? data : { ...data, id: (templateModal as ExportTemplate).id })} />
      )}
    </div>
  );
}
