import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { usePermission } from "@/hooks/useSession";
import {
  Webhook, Plus, Trash2, TestTube2, CheckCircle2, XCircle,
  Clock, ChevronDown, ChevronRight, Eye, EyeOff, Edit2,
} from "lucide-react";
import { Button } from "@/components/ui/button";

interface WebhookEndpoint {
  endpoint_id: string;
  name: string;
  url: string;
  event_types: string[];
  enabled: boolean;
  created_at: string;
  created_by: string;
  last_status: string | null;
  last_delivery_at: string | null;
}

interface Delivery {
  delivery_id: string;
  event_type: string;
  status: string;
  response_code: number | null;
  response_body: string | null;
  attempt_count: number;
  delivered_at: string | null;
  created_at: string;
}

const ALL_EVENTS = [
  "alert.triggered",
  "alert.resolved",
  "incident.opened",
  "incident.closed",
  "automation.run.succeeded",
  "automation.run.failed",
];

const EMPTY_FORM = { name: "", url: "", secret: "", event_types: ALL_EVENTS, enabled: true };

function statusBadge(status: string | null) {
  if (!status) return null;
  if (status === "success") return <span className="inline-flex items-center gap-1 text-xs text-green-700 dark:text-green-400"><CheckCircle2 className="w-3 h-3" />OK</span>;
  if (status === "failed") return <span className="inline-flex items-center gap-1 text-xs text-red-600 dark:text-red-400"><XCircle className="w-3 h-3" />Falhou</span>;
  return <span className="inline-flex items-center gap-1 text-xs text-gray-500"><Clock className="w-3 h-3" />{status}</span>;
}

function DeliveryHistory({ endpointId }: { endpointId: string }) {
  const q = useQuery<Delivery[]>({
    queryKey: ["webhook-deliveries", endpointId],
    queryFn: () => api.get<Delivery[]>(`/api/v1/webhooks/${endpointId}/deliveries`),
  });
  const rows = q.data ?? [];
  return (
    <div className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden text-sm">
      {q.isLoading ? (
        <div className="p-4 text-gray-400">Carregando...</div>
      ) : rows.length === 0 ? (
        <div className="p-4 text-gray-400 text-center">Nenhuma entrega ainda</div>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
              <th className="text-left px-3 py-2 font-medium text-gray-500">Evento</th>
              <th className="text-left px-3 py-2 font-medium text-gray-500">Status</th>
              <th className="text-left px-3 py-2 font-medium text-gray-500">Código</th>
              <th className="text-left px-3 py-2 font-medium text-gray-500">Data</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(d => (
              <tr key={d.delivery_id} className="border-b border-gray-100 dark:border-gray-800 last:border-0">
                <td className="px-3 py-2 font-mono text-gray-700 dark:text-gray-300">{d.event_type}</td>
                <td className="px-3 py-2">{statusBadge(d.status)}</td>
                <td className="px-3 py-2 text-gray-500">{d.response_code ?? "—"}</td>
                <td className="px-3 py-2 text-gray-400">
                  {new Date(d.created_at).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

type FormData = typeof EMPTY_FORM;

function EndpointModal({
  initial,
  onSave,
  onClose,
  saving,
}: {
  initial: FormData & { endpoint_id?: string };
  onSave: (data: FormData) => void;
  onClose: () => void;
  saving: boolean;
}) {
  const [form, setForm] = useState<FormData>({ ...initial });
  const [showSecret, setShowSecret] = useState(!initial.endpoint_id);

  function toggleEvent(evt: string) {
    setForm(f => ({
      ...f,
      event_types: f.event_types.includes(evt)
        ? f.event_types.filter(e => e !== evt)
        : [...f.event_types, evt],
    }));
  }

  return (
    <div className="fixed inset-0 bg-black/50 dark:bg-black/70 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl max-w-lg w-full p-6 space-y-4" onClick={e => e.stopPropagation()}>
        <h2 className="text-lg font-bold text-gray-900 dark:text-gray-100">
          {initial.endpoint_id ? "Editar endpoint" : "Novo endpoint"}
        </h2>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Nome</label>
            <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-teal-500"
              value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Ex: Slack alertas" />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">URL (https://)</label>
            <input className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-teal-500"
              value={form.url} onChange={e => setForm(f => ({ ...f, url: e.target.value }))} placeholder="https://..." />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">
              Secret (mín. 16 chars — usado no HMAC-SHA256)
            </label>
            <div className="relative">
              <input
                className="w-full border border-gray-200 dark:border-gray-700 rounded px-3 py-1.5 text-sm bg-white dark:bg-gray-800 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-teal-500 pr-9"
                type={showSecret ? "text" : "password"}
                value={form.secret}
                onChange={e => setForm(f => ({ ...f, secret: e.target.value }))}
                placeholder={initial.endpoint_id ? "Deixe em branco para manter" : "Mínimo 16 caracteres"}
              />
              <button type="button" onClick={() => setShowSecret(!showSecret)}
                className="absolute right-2 top-1.5 text-gray-400 hover:text-gray-600">
                {showSecret ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-2">Eventos</label>
            <div className="grid grid-cols-2 gap-1">
              {ALL_EVENTS.map(evt => (
                <label key={evt} className="flex items-center gap-2 text-xs cursor-pointer">
                  <input type="checkbox" checked={form.event_types.includes(evt)}
                    onChange={() => toggleEvent(evt)} className="accent-teal-600" />
                  <span className="font-mono text-gray-700 dark:text-gray-300">{evt}</span>
                </label>
              ))}
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm cursor-pointer">
            <input type="checkbox" checked={form.enabled}
              onChange={e => setForm(f => ({ ...f, enabled: e.target.checked }))} className="accent-teal-600" />
            <span className="text-gray-700 dark:text-gray-300">Habilitado</span>
          </label>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onClose}>Cancelar</Button>
          <Button size="sm" disabled={saving || !form.name || !form.url}
            onClick={() => onSave(form)}
            className="bg-teal-700 hover:bg-teal-800 text-white">
            {saving ? "Salvando..." : "Salvar"}
          </Button>
        </div>
      </div>
    </div>
  );
}

export function WebhooksPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const canOperate = usePermission("monitoring:operate") || usePermission("tenant:admin");

  const [expanded, setExpanded] = useState<string | null>(null);
  const [modalEndpoint, setModalEndpoint] = useState<(FormData & { endpoint_id?: string }) | null>(null);

  const q = useQuery<WebhookEndpoint[]>({
    queryKey: ["webhooks", tenantId],
    queryFn: () => api.get<WebhookEndpoint[]>("/api/v1/webhooks"),
  });

  const createMut = useMutation({
    mutationFn: (data: FormData) => api.post("/api/v1/webhooks", data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["webhooks", tenantId] }); setModalEndpoint(null); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<FormData> }) =>
      api.put(`/api/v1/webhooks/${id}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["webhooks", tenantId] }); setModalEndpoint(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/webhooks/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["webhooks", tenantId] }),
  });

  const testMut = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/webhooks/${id}/test`),
    onSuccess: (_, id) => qc.invalidateQueries({ queryKey: ["webhooks", tenantId] }),
  });

  function handleSave(form: FormData & { endpoint_id?: string }) {
    if (form.endpoint_id) {
      const payload: Partial<FormData> = { ...form };
      if (!payload.secret) delete payload.secret;
      updateMut.mutate({ id: form.endpoint_id, data: payload });
    } else {
      createMut.mutate(form);
    }
  }

  const endpoints = q.data ?? [];

  return (
    <div className="p-4 md:p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100 flex items-center gap-2">
            <Webhook className="w-5 h-5 text-teal-600" />
            Webhooks de Saída
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
            Endpoints HTTPS com assinatura HMAC-SHA256 no header <code className="font-mono bg-gray-100 dark:bg-gray-800 px-1 rounded text-xs">X-JLMirror-Signature</code>
          </p>
        </div>
        {canOperate && (
          <Button size="sm" onClick={() => setModalEndpoint({ ...EMPTY_FORM })}
            className="bg-teal-700 hover:bg-teal-800 text-white">
            <Plus className="w-4 h-4 mr-1" />Adicionar
          </Button>
        )}
      </div>

      {q.isLoading ? (
        <div className="text-gray-400 text-sm">Carregando...</div>
      ) : endpoints.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <Webhook className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum webhook configurado.</p>
          {canOperate && (
            <Button size="sm" variant="outline" className="mt-3" onClick={() => setModalEndpoint({ ...EMPTY_FORM })}>
              Adicionar endpoint
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-2">
          {endpoints.map(ep => (
            <div key={ep.endpoint_id} className="border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
              <div className="flex items-center gap-3 px-4 py-3 bg-white dark:bg-gray-900">
                <button onClick={() => setExpanded(expanded === ep.endpoint_id ? null : ep.endpoint_id)}
                  className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                  {expanded === ep.endpoint_id ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-gray-800 dark:text-gray-100 text-sm">{ep.name}</span>
                    <span className={`text-xs px-1.5 py-0.5 rounded ${ep.enabled ? "bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" : "bg-gray-100 text-gray-500 dark:bg-gray-800"}`}>
                      {ep.enabled ? "ativo" : "inativo"}
                    </span>
                    {statusBadge(ep.last_status)}
                  </div>
                  <p className="text-xs text-gray-400 font-mono truncate">{ep.url}</p>
                </div>
                {canOperate && (
                  <div className="flex gap-1 flex-shrink-0">
                    <button
                      title="Testar"
                      disabled={testMut.isPending}
                      onClick={() => testMut.mutate(ep.endpoint_id)}
                      className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-teal-600 disabled:opacity-40">
                      <TestTube2 className="w-4 h-4" />
                    </button>
                    <button
                      title="Editar"
                      onClick={() => setModalEndpoint({ ...ep, secret: "" })}
                      className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-blue-600">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button
                      title="Excluir"
                      disabled={deleteMut.isPending}
                      onClick={() => { if (confirm(`Excluir webhook "${ep.name}"?`)) deleteMut.mutate(ep.endpoint_id); }}
                      className="p-1.5 rounded hover:bg-gray-100 dark:hover:bg-gray-800 text-gray-400 hover:text-red-600 disabled:opacity-40">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                )}
              </div>

              {expanded === ep.endpoint_id && (
                <div className="border-t border-gray-100 dark:border-gray-800 p-4 space-y-3 bg-gray-50 dark:bg-gray-800/30">
                  <div className="flex flex-wrap gap-1">
                    {ep.event_types.map(evt => (
                      <span key={evt} className="text-xs font-mono bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 px-1.5 py-0.5 rounded">
                        {evt}
                      </span>
                    ))}
                  </div>
                  <div>
                    <h4 className="text-xs font-semibold text-gray-600 dark:text-gray-400 mb-2">Histórico de entregas (últimas 50)</h4>
                    <DeliveryHistory endpointId={ep.endpoint_id} />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {modalEndpoint && (
        <EndpointModal
          initial={modalEndpoint}
          onSave={handleSave}
          onClose={() => setModalEndpoint(null)}
          saving={createMut.isPending || updateMut.isPending}
        />
      )}
    </div>
  );
}
