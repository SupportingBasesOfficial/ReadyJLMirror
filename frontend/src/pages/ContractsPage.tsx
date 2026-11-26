import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { usePermission } from "@/hooks/useSession";
import {
  FileText, Plus, Trash2, ChevronDown, ChevronRight,
  Clock, CheckCircle2, AlertCircle, PauseCircle, Archive,
  Edit2, PlusCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface Contract {
  contract_id: string;
  name: string;
  contract_type: string;
  status: string;
  start_date: string;
  end_date: string | null;
  monthly_hours: number | null;
  hourly_rate: number | null;
  currency: string;
  client_id: string | null;
  created_at: string;
  used_hours_total: number;
}

interface HourEntry {
  entry_id: string;
  description: string;
  hours: number;
  entry_date: string;
  recorded_by: string;
  created_at: string;
}

interface Closure {
  closure_id: string;
  period_start: string;
  period_end: string;
  contracted_hours: number | null;
  used_hours: number;
  total_amount: number | null;
  status: string;
  closed_at: string | null;
  notes: string | null;
  created_at: string;
}

const CONTRACT_TYPES = ["recurring", "project", "sla", "retainer"];
const CONTRACT_STATUSES = ["draft", "active", "suspended", "closed"];

const TYPE_LABELS: Record<string, string> = {
  recurring: "Recorrente", project: "Projeto", sla: "SLA", retainer: "Retainer",
};

function statusIcon(s: string) {
  if (s === "active") return <CheckCircle2 className="w-3.5 h-3.5 text-green-500" />;
  if (s === "draft") return <Clock className="w-3.5 h-3.5 text-gray-400" />;
  if (s === "suspended") return <PauseCircle className="w-3.5 h-3.5 text-yellow-500" />;
  if (s === "closed") return <Archive className="w-3.5 h-3.5 text-gray-400" />;
  return <AlertCircle className="w-3.5 h-3.5 text-gray-400" />;
}

function HoursGauge({ used, contracted }: { used: number; contracted: number | null }) {
  if (!contracted) return <span className="text-sm text-gray-500">{used.toFixed(1)}h lançadas</span>;
  const pct = Math.min((used / contracted) * 100, 100);
  const color = pct >= 90 ? "bg-red-500" : pct >= 70 ? "bg-yellow-500" : "bg-teal-500";
  return (
    <div className="flex items-center gap-2 min-w-0">
      <div className="flex-1 bg-gray-200 dark:bg-gray-700 rounded-full h-1.5 min-w-0">
        <div className={`${color} h-1.5 rounded-full transition-all`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-xs text-gray-500 whitespace-nowrap">{used.toFixed(1)}/{contracted}h</span>
    </div>
  );
}

type TabType = "details" | "hours" | "closures";

function ContractDetail({ contractId, tenantId, canOperate }: { contractId: string; tenantId: string; canOperate: boolean }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<TabType>("hours");
  const [hourForm, setHourForm] = useState({ description: "", hours: "", date: "" });
  const [closureForm, setClosureForm] = useState({ period_start: "", period_end: "", notes: "" });

  const hoursQ = useQuery<HourEntry[]>({
    queryKey: ["contract-hours", contractId],
    queryFn: () => api.get<HourEntry[]>(`/api/v1/contracts/${contractId}/hours`),
  });

  const closuresQ = useQuery<Closure[]>({
    queryKey: ["contract-closures", contractId],
    queryFn: () => api.get<Closure[]>(`/api/v1/contracts/${contractId}/closures`),
  });

  const addHourMut = useMutation({
    mutationFn: (data: { description: string; hours: number; entry_date?: string }) =>
      api.post(`/api/v1/contracts/${contractId}/hours`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contract-hours", contractId] });
      qc.invalidateQueries({ queryKey: ["contracts", tenantId] });
      setHourForm({ description: "", hours: "", date: "" });
    },
  });

  const deleteHourMut = useMutation({
    mutationFn: (entryId: string) => api.delete(`/api/v1/contracts/${contractId}/hours/${entryId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contract-hours", contractId] });
      qc.invalidateQueries({ queryKey: ["contracts", tenantId] });
    },
  });

  const createClosureMut = useMutation({
    mutationFn: (data: { period_start: string; period_end: string; notes?: string }) =>
      api.post(`/api/v1/contracts/${contractId}/closures`, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["contract-closures", contractId] });
      setClosureForm({ period_start: "", period_end: "", notes: "" });
    },
  });

  const updateClosureMut = useMutation({
    mutationFn: ({ closureId, status }: { closureId: string; status: string }) =>
      api.put(`/api/v1/contracts/${contractId}/closures/${closureId}?status=${status}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contract-closures", contractId] }),
  });

  const tabs: { id: TabType; label: string }[] = [
    { id: "hours", label: "Lançamentos de horas" },
    { id: "closures", label: "Fechamentos" },
  ];

  return (
    <div className="border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/30 p-4 space-y-3">
      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`text-xs px-3 py-1.5 font-medium border-b-2 transition-colors ${tab === t.id ? "border-teal-600 text-teal-700 dark:text-teal-400" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "hours" && (
        <div className="space-y-3">
          {canOperate && (
            <div className="flex gap-2 items-end flex-wrap">
              <input className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 flex-1 min-w-48"
                placeholder="Descrição do serviço" value={hourForm.description}
                onChange={e => setHourForm(f => ({ ...f, description: e.target.value }))} />
              <input type="number" min="0.1" max="24" step="0.25"
                className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 w-24"
                placeholder="Horas" value={hourForm.hours}
                onChange={e => setHourForm(f => ({ ...f, hours: e.target.value }))} />
              <input type="date"
                className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                value={hourForm.date}
                onChange={e => setHourForm(f => ({ ...f, date: e.target.value }))} />
              <Button size="sm" disabled={addHourMut.isPending || !hourForm.description || !hourForm.hours}
                onClick={() => addHourMut.mutate({
                  description: hourForm.description,
                  hours: parseFloat(hourForm.hours),
                  ...(hourForm.date ? { entry_date: hourForm.date } : {}),
                })}
                className="bg-teal-700 hover:bg-teal-800 text-white">
                <PlusCircle className="w-3.5 h-3.5 mr-1" />Lançar
              </Button>
            </div>
          )}
          <div className="space-y-1 max-h-56 overflow-y-auto">
            {hoursQ.isLoading ? <div className="text-xs text-gray-400">Carregando...</div> :
              (hoursQ.data ?? []).length === 0 ? <div className="text-xs text-gray-400 text-center py-4">Nenhum lançamento ainda.</div> :
              (hoursQ.data ?? []).map(e => (
                <div key={e.entry_id} className="flex items-center gap-2 text-xs py-1 border-b border-gray-100 dark:border-gray-700 last:border-0">
                  <span className="flex-1 text-gray-700 dark:text-gray-300 truncate">{e.description}</span>
                  <span className="font-mono text-teal-700 dark:text-teal-400 font-medium">{e.hours}h</span>
                  <span className="text-gray-400">{new Date(e.entry_date).toLocaleDateString("pt-BR")}</span>
                  {canOperate && (
                    <button onClick={() => { if (confirm("Excluir lançamento?")) deleteHourMut.mutate(e.entry_id); }}
                      className="text-gray-300 hover:text-red-500">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              ))
            }
          </div>
        </div>
      )}

      {tab === "closures" && (
        <div className="space-y-3">
          {canOperate && (
            <div className="flex gap-2 items-end flex-wrap">
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">Início</label>
                <input type="date" className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  value={closureForm.period_start} onChange={e => setClosureForm(f => ({ ...f, period_start: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-0.5">Fim</label>
                <input type="date" className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
                  value={closureForm.period_end} onChange={e => setClosureForm(f => ({ ...f, period_end: e.target.value }))} />
              </div>
              <Button size="sm" disabled={createClosureMut.isPending || !closureForm.period_start || !closureForm.period_end}
                onClick={() => createClosureMut.mutate({ period_start: closureForm.period_start, period_end: closureForm.period_end })}
                className="bg-teal-700 hover:bg-teal-800 text-white mt-4">
                Fechar período
              </Button>
            </div>
          )}
          <div className="space-y-1">
            {closuresQ.isLoading ? <div className="text-xs text-gray-400">Carregando...</div> :
              (closuresQ.data ?? []).length === 0 ? <div className="text-xs text-gray-400 text-center py-4">Nenhum fechamento.</div> :
              (closuresQ.data ?? []).map(c => (
                <div key={c.closure_id} className="flex items-center gap-3 text-xs py-1.5 border-b border-gray-100 dark:border-gray-700 last:border-0">
                  <span className="text-gray-600 dark:text-gray-300 w-32 flex-shrink-0">
                    {new Date(c.period_start).toLocaleDateString("pt-BR")} – {new Date(c.period_end).toLocaleDateString("pt-BR")}
                  </span>
                  <span className="font-mono text-teal-700 dark:text-teal-400">{c.used_hours.toFixed(1)}h</span>
                  {c.total_amount != null && (
                    <span className="text-gray-500">R$ {c.total_amount.toFixed(2)}</span>
                  )}
                  <span className={`px-1.5 py-0.5 rounded text-xs font-medium ${
                    c.status === "invoiced" ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" :
                    c.status === "closed" ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" :
                    "bg-gray-100 text-gray-500 dark:bg-gray-800"
                  }`}>{c.status}</span>
                  {canOperate && c.status === "open" && (
                    <button onClick={() => updateClosureMut.mutate({ closureId: c.closure_id, status: "closed" })}
                      className="text-gray-400 hover:text-blue-600 text-xs">Fechar</button>
                  )}
                  {canOperate && c.status === "closed" && (
                    <button onClick={() => updateClosureMut.mutate({ closureId: c.closure_id, status: "invoiced" })}
                      className="text-gray-400 hover:text-green-600 text-xs">Faturar</button>
                  )}
                </div>
              ))
            }
          </div>
        </div>
      )}
    </div>
  );
}

type ContractFormData = {
  name: string; contract_type: string; status: string;
  start_date: string; end_date: string; monthly_hours: string;
  hourly_rate: string; currency: string; client_id: string; notes: string;
};

const EMPTY_FORM: ContractFormData = {
  name: "", contract_type: "recurring", status: "active",
  start_date: "", end_date: "", monthly_hours: "", hourly_rate: "", currency: "BRL", client_id: "", notes: "",
};

function ContractModal({
  initial, onSave, onClose, saving,
}: {
  initial: ContractFormData & { contract_id?: string };
  onSave: (data: ContractFormData) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<ContractFormData>({ ...initial });

  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {initial.contract_id ? "Editar contrato" : "Novo contrato"}
        </h2>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nome do contrato</label>
            <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-teal-500"
              value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Tipo</label>
            <select className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              value={form.contract_type} onChange={e => setForm(f => ({ ...f, contract_type: e.target.value }))}>
              {CONTRACT_TYPES.map(t => <option key={t} value={t}>{TYPE_LABELS[t] ?? t}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Status</label>
            <select className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}>
              {CONTRACT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Início</label>
            <input type="date" className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              value={form.start_date} onChange={e => setForm(f => ({ ...f, start_date: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Fim (opcional)</label>
            <input type="date" className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              value={form.end_date} onChange={e => setForm(f => ({ ...f, end_date: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Horas/mês</label>
            <input type="number" min="0" step="0.5"
              className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              placeholder="ex: 40" value={form.monthly_hours}
              onChange={e => setForm(f => ({ ...f, monthly_hours: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Valor/hora</label>
            <input type="number" min="0" step="0.01"
              className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              placeholder="ex: 150.00" value={form.hourly_rate}
              onChange={e => setForm(f => ({ ...f, hourly_rate: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">ID do cliente</label>
            <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              placeholder="tenant_id do cliente" value={form.client_id}
              onChange={e => setForm(f => ({ ...f, client_id: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Moeda</label>
            <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100"
              value={form.currency} onChange={e => setForm(f => ({ ...f, currency: e.target.value.toUpperCase() }))} />
          </div>
          <div className="col-span-2">
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Observações</label>
            <textarea rows={2}
              className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 resize-none"
              value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" disabled={saving || !form.name || !form.start_date}
            onClick={() => onSave(form)}
            className="bg-teal-700 hover:bg-teal-800 text-white">
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function ContractsPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const canOperate = usePermission("monitoring:operate") || usePermission("tenant:admin");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [modalContract, setModalContract] = useState<(ContractFormData & { contract_id?: string }) | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("active");

  const q = useQuery<Contract[]>({
    queryKey: ["contracts", tenantId, statusFilter],
    queryFn: () => api.get<Contract[]>(`/api/v1/contracts${statusFilter ? `?status=${statusFilter}` : ""}`),
  });

  const createMut = useMutation({
    mutationFn: (data: ContractFormData) => api.post("/api/v1/contracts", {
      ...data,
      monthly_hours: data.monthly_hours ? parseFloat(data.monthly_hours) : null,
      hourly_rate: data.hourly_rate ? parseFloat(data.hourly_rate) : null,
      end_date: data.end_date || null,
      client_id: data.client_id || null,
      notes: data.notes || null,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["contracts", tenantId] }); setModalContract(null); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<ContractFormData> }) =>
      api.put(`/api/v1/contracts/${id}`, {
        ...data,
        monthly_hours: data.monthly_hours ? parseFloat(data.monthly_hours as string) : undefined,
        hourly_rate: data.hourly_rate ? parseFloat(data.hourly_rate as string) : undefined,
        end_date: data.end_date || null,
        client_id: data.client_id || null,
      }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["contracts", tenantId] }); setModalContract(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/contracts/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["contracts", tenantId] }),
  });

  function handleSave(form: ContractFormData & { contract_id?: string }) {
    if (form.contract_id) updateMut.mutate({ id: form.contract_id, data: form });
    else createMut.mutate(form);
  }

  const contracts = q.data ?? [];

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <FileText className="w-5 h-5 text-teal-600" />
            Contratos
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">Gestão de contratos, banco de horas e fechamento mensal</p>
        </div>
        <div className="flex gap-2 items-center">
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}
            className="border border-gray-200 dark:border-gray-700 rounded px-2 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-300">
            <option value="">Todos</option>
            {CONTRACT_STATUSES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          {canOperate && (
            <Button size="sm" onClick={() => setModalContract({ ...EMPTY_FORM })}
              className="bg-teal-700 hover:bg-teal-800 text-white">
              <Plus className="w-4 h-4 mr-1" />Novo contrato
            </Button>
          )}
        </div>
      </div>

      {q.isLoading ? (
        <div className="text-gray-400 text-sm">Carregando...</div>
      ) : contracts.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum contrato encontrado.</p>
        </div>
      ) : (
        <div className="space-y-2">
          {contracts.map(c => (
            <div key={c.contract_id} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-gray-900">
                <button onClick={() => setExpanded(expanded === c.contract_id ? null : c.contract_id)}
                  className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                  {expanded === c.contract_id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex items-center gap-2">
                    {statusIcon(c.status)}
                    <span className="font-medium text-gray-800 dark:text-gray-100 text-sm">{c.name}</span>
                    <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-500 px-1.5 py-0.5 rounded">
                      {TYPE_LABELS[c.contract_type] ?? c.contract_type}
                    </span>
                    {c.client_id && <span className="text-xs text-gray-400 font-mono truncate">{c.client_id}</span>}
                  </div>
                  <div className="flex items-center gap-4">
                    <HoursGauge used={c.used_hours_total} contracted={c.monthly_hours} />
                    <span className="text-xs text-gray-400 flex-shrink-0">
                      {new Date(c.start_date).toLocaleDateString("pt-BR")}
                      {c.end_date ? ` → ${new Date(c.end_date).toLocaleDateString("pt-BR")}` : " (aberto)"}
                    </span>
                  </div>
                </div>
                {canOperate && (
                  <div className="flex gap-1 flex-shrink-0">
                    <button onClick={() => setModalContract({ ...EMPTY_FORM, ...c, contract_id: c.contract_id,
                      monthly_hours: c.monthly_hours?.toString() ?? "", hourly_rate: c.hourly_rate?.toString() ?? "",
                      end_date: c.end_date ?? "", client_id: c.client_id ?? "", notes: "" })}
                      className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-blue-600">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button disabled={deleteMut.isPending}
                      onClick={() => { if (confirm(`Excluir contrato "${c.name}"?`)) deleteMut.mutate(c.contract_id); }}
                      className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-red-600 disabled:opacity-40">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>
              {expanded === c.contract_id && (
                <ContractDetail contractId={c.contract_id} tenantId={tenantId} canOperate={canOperate} />
              )}
            </div>
          ))}
        </div>
      )}

      {modalContract && (
        <ContractModal
          initial={modalContract}
          onSave={handleSave}
          onClose={() => setModalContract(null)}
          saving={createMut.isPending || updateMut.isPending}
        />
      )}
    </div>
  );
}
