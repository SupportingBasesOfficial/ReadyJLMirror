import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Bug, CheckCircle, Clock, XCircle, AlertTriangle } from "lucide-react";

interface BugReport {
  report_id: string;
  screen_id: string;
  screen_url: string;
  title: string;
  description: string;
  status: "open" | "in_progress" | "resolved" | "wont_fix";
  resolution: string | null;
  reported_by: string;
  created_at: string;
}

const STATUS_LABEL: Record<BugReport["status"], string> = {
  open: "Aberto",
  in_progress: "Em andamento",
  resolved: "Resolvido",
  wont_fix: "Não será corrigido",
};

const STATUS_ICON: Record<BugReport["status"], React.ElementType> = {
  open: AlertTriangle,
  in_progress: Clock,
  resolved: CheckCircle,
  wont_fix: XCircle,
};

const STATUS_COLOR: Record<BugReport["status"], string> = {
  open: "var(--red, #ef4444)",
  in_progress: "var(--yellow, #f59e0b)",
  resolved: "var(--green, #22c55e)",
  wont_fix: "var(--text-muted)",
};

function StatusBadge({ status }: { status: BugReport["status"] }) {
  const Icon = STATUS_ICON[status];
  return (
    <span className="flex items-center gap-1 text-[11px] font-medium px-2 py-0.5 rounded-full border"
      style={{
        color: STATUS_COLOR[status],
        borderColor: STATUS_COLOR[status],
        background: `color-mix(in srgb, ${STATUS_COLOR[status]} 10%, transparent)`,
      }}>
      <Icon size={10} />
      {STATUS_LABEL[status]}
    </span>
  );
}

interface DetailModalProps {
  report: BugReport;
  onClose: () => void;
}

function DetailModal({ report, onClose }: DetailModalProps) {
  const qc = useQueryClient();
  const [status, setStatus] = useState<BugReport["status"]>(report.status);
  const [resolution, setResolution] = useState(report.resolution ?? "");

  const mut = useMutation({
    mutationFn: () => api.patch(`/api/v1/bugs/${report.report_id}`, { status, resolution: resolution.trim() || null }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["bug-reports"] });
      onClose();
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="bg-[var(--surface-1)] border border-[var(--border)] rounded-xl shadow-xl w-full max-w-lg mx-4 p-5 space-y-4">
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Bug size={14} className="text-[var(--red,#ef4444)]" />
              <span className="text-sm font-semibold">{report.title}</span>
            </div>
            <div className="flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
              <span className="font-mono bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-0.5 rounded">{report.screen_id}</span>
              <span>{new Date(report.created_at).toLocaleString("pt-BR")}</span>
            </div>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)] text-lg leading-none">×</button>
        </div>

        {report.description && (
          <div className="text-xs text-[var(--text-secondary)] bg-[var(--surface-2)] rounded-lg p-3 border border-[var(--border)]">
            {report.description}
          </div>
        )}

        <div className="text-[11px] text-[var(--text-muted)]">
          URL: <span className="font-mono">{report.screen_url}</span>
        </div>

        <div className="space-y-3 pt-1 border-t border-[var(--border)]">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as BugReport["status"])}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm focus:outline-none focus:ring-1 focus:ring-[var(--brand,#6366f1)]"
            >
              {Object.entries(STATUS_LABEL).map(([v, l]) => (
                <option key={v} value={v}>{l}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Resolução (opcional)</label>
            <textarea
              value={resolution}
              onChange={(e) => setResolution(e.target.value)}
              placeholder="Descreva como foi tratado ou por que não será corrigido..."
              rows={3}
              className="w-full rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-sm resize-none focus:outline-none focus:ring-1 focus:ring-[var(--brand,#6366f1)]"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button onClick={onClose}
              className="text-xs px-3 py-1.5 rounded-md border border-[var(--border)] hover:bg-[var(--surface-2)]">
              Cancelar
            </button>
            <button
              onClick={() => mut.mutate()}
              disabled={mut.isPending}
              className="text-xs px-3 py-1.5 rounded-md bg-[var(--brand,#6366f1)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {mut.isPending ? "Salvando…" : "Salvar"}
            </button>
          </div>
          {mut.isError && <p className="text-[11px] text-[var(--red,#ef4444)]">Erro ao salvar.</p>}
        </div>
      </div>
    </div>
  );
}

interface Props {
  tenantId: string;
}

export function BugReportsPage({ tenantId }: Props) {
  const [statusFilter, setStatusFilter] = useState<string>("open");
  const [selected, setSelected] = useState<BugReport | null>(null);

  const { data, isLoading } = useQuery<BugReport[]>({
    queryKey: ["bug-reports", tenantId, statusFilter],
    queryFn: () => api.get<BugReport[]>(`/api/v1/bugs${statusFilter ? `?status=${statusFilter}` : ""}`),
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold flex items-center gap-2">
          <Bug size={15} className="text-[var(--red,#ef4444)]" />
          Bug Reports
        </h2>
        <div className="flex items-center gap-2">
          <label className="text-xs text-[var(--text-muted)]">Status:</label>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="text-xs rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 focus:outline-none"
          >
            <option value="">Todos</option>
            {Object.entries(STATUS_LABEL).map(([v, l]) => (
              <option key={v} value={v}>{l}</option>
            ))}
          </select>
        </div>
      </div>

      {isLoading && (
        <div className="text-xs text-[var(--text-muted)] text-center py-8">Carregando…</div>
      )}

      {!isLoading && (!data || data.length === 0) && (
        <div className="text-xs text-[var(--text-muted)] text-center py-12 border border-[var(--border)] rounded-xl bg-[var(--surface-2)]">
          Nenhum bug report encontrado.
        </div>
      )}

      {data && data.length > 0 && (
        <div className="rounded-xl border border-[var(--border)] overflow-hidden">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)]">Título</th>
                <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)]">Tela</th>
                <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)]">Status</th>
                <th className="text-left px-4 py-2 font-medium text-[var(--text-muted)]">Data</th>
              </tr>
            </thead>
            <tbody>
              {data.map((r, i) => (
                <tr
                  key={r.report_id}
                  onClick={() => setSelected(r)}
                  className={`cursor-pointer hover:bg-[var(--surface-2)] transition-colors ${i > 0 ? "border-t border-[var(--border)]" : ""}`}
                >
                  <td className="px-4 py-2.5 font-medium text-[var(--text)]">{r.title}</td>
                  <td className="px-4 py-2.5">
                    <span className="font-mono bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-0.5 rounded text-[10px]">
                      {r.screen_id}
                    </span>
                  </td>
                  <td className="px-4 py-2.5"><StatusBadge status={r.status} /></td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)]">
                    {new Date(r.created_at).toLocaleDateString("pt-BR")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && <DetailModal report={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}
