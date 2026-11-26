import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  Plus, Zap, CheckCircle, XCircle, AlertTriangle, Trash2,
  Edit2, ChevronDown, ChevronRight, MessageSquare, Send,
  Link2, Terminal, Loader2, Clock,
} from "lucide-react";

interface Props { tenantId: string; }

const API = "/api/v1/chatops";

const ENTITY_TYPES = ["alert", "incident", "monitor", "device", "vulnerability", "deployment"];
const EVENT_TYPES = ["created", "resolved", "acknowledged", "escalated", "updated", "closed"];
const PLATFORMS = ["slack", "teams"] as const;
type Platform = typeof PLATFORMS[number];

interface Workspace {
  id: string; name: string; platform: Platform; webhook_url: string | null;
  bot_token_ref: string | null; status: "active" | "inactive" | "error";
  error_message: string | null; last_ping_at: string | null;
  binding_count: number; created_at: string;
}
interface Binding {
  id: string; workspace_id: string; channel_id: string; channel_name: string | null;
  entity_type: string; event_types: string[];
}
interface OutboundMessage {
  id: string; workspace_name: string | null; platform: string | null;
  channel_id: string; entity_type: string | null; event_type: string | null;
  status: "pending" | "sent" | "failed"; error_message: string | null;
  created_at: string; sent_at: string | null;
}
interface CommandLog {
  id: string; workspace_name: string | null; platform: string;
  channel_id: string | null; sender_name: string | null;
  command: string; args: string | null; response: string | null;
  status: "ok" | "error" | "ignored"; received_at: string;
}
interface Stats {
  total_workspaces: number; active_workspaces: number; total_bindings: number;
  messages_sent: number; messages_failed: number; commands_received: number;
}

function fmtDate(d: string | null) {
  if (!d) return "—";
  return new Date(d).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" });
}

// ── Platform badge ────────────────────────────────────────────────────────────

const PLATFORM_STYLES: Record<Platform, { cls: string; label: string }> = {
  slack: { cls: "bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300", label: "Slack" },
  teams: { cls: "bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300", label: "Teams" },
};

function PlatformBadge({ platform }: { platform: Platform }) {
  const { cls, label } = PLATFORM_STYLES[platform] ?? { cls: "bg-gray-100 text-gray-700", label: platform };
  return <span className={`px-2 py-0.5 rounded text-xs font-medium ${cls}`}>{label}</span>;
}

const STATUS_ICON: Record<string, { icon: typeof CheckCircle; cls: string }> = {
  active:   { icon: CheckCircle, cls: "text-green-500" },
  inactive: { icon: Clock, cls: "text-gray-400" },
  error:    { icon: XCircle, cls: "text-red-500" },
};

function StatusIcon({ status }: { status: string }) {
  const { icon: Icon, cls } = STATUS_ICON[status] ?? STATUS_ICON.inactive;
  return <Icon size={14} className={cls} />;
}

function StatCard({ icon: Icon, label, value, color }: {
  icon: typeof MessageSquare; label: string; value: number; color: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${color}`}><Icon size={18} /></div>
      <div>
        <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
        <p className="text-xl font-semibold text-gray-900 dark:text-white">{value}</p>
      </div>
    </div>
  );
}

// ── Workspace modal ───────────────────────────────────────────────────────────

function WorkspaceModal({ initial, onClose, onSave }: {
  initial?: Workspace | null;
  onClose: () => void;
  onSave: (data: {
    name: string; platform: string; webhook_url: string;
    bot_token_ref: string; inbound_secret: string;
  }) => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [platform, setPlatform] = useState<Platform>(initial?.platform ?? "slack");
  const [webhookUrl, setWebhookUrl] = useState(initial?.webhook_url ?? "");
  const [botTokenRef, setBotTokenRef] = useState(initial?.bot_token_ref ?? "");
  const [inboundSecret, setInboundSecret] = useState("");

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
          {initial ? "Editar workspace" : "Novo workspace"}
        </h2>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome</label>
            <input value={name} onChange={e => setName(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Plataforma</label>
            <div className="flex gap-2">
              {PLATFORMS.map(p => (
                <button key={p} onClick={() => setPlatform(p)}
                  className={`flex-1 py-2 rounded-lg text-sm font-medium border transition-colors
                    ${platform === p
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"}`}>
                  {PLATFORM_STYLES[p].label}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Webhook URL {platform === "slack" ? "(Incoming Webhook)" : "(Power Automate / Bot)"}
            </label>
            <input value={webhookUrl} onChange={e => setWebhookUrl(e.target.value)}
              placeholder="https://hooks.slack.com/..." type="url"
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm font-mono" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Referência do Bot Token (credential_ref)
            </label>
            <input value={botTokenRef} onChange={e => setBotTokenRef(e.target.value)}
              placeholder="cred-slack-bot-1"
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm font-mono" />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
              Secret do Webhook Inbound (para validar comandos recebidos)
            </label>
            <input value={inboundSecret} onChange={e => setInboundSecret(e.target.value)}
              placeholder={initial ? "Deixe em branco para manter o atual" : "token secreto"}
              type="password"
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm font-mono" />
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancelar</button>
          <button onClick={() => onSave({ name, platform, webhook_url: webhookUrl, bot_token_ref: botTokenRef, inbound_secret: inboundSecret })}
            disabled={!name}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
            Salvar
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Binding modal ─────────────────────────────────────────────────────────────

function BindingModal({ workspaceId, onClose, onSave }: {
  workspaceId: string;
  onClose: () => void;
  onSave: (data: { channel_id: string; channel_name: string; entity_type: string; event_types: string[] }) => void;
}) {
  const [channelId, setChannelId] = useState("");
  const [channelName, setChannelName] = useState("");
  const [entityType, setEntityType] = useState(ENTITY_TYPES[0]);
  const [selectedEvents, setSelectedEvents] = useState<string[]>(["created", "resolved"]);

  function toggleEvent(e: string) {
    setSelectedEvents(prev => prev.includes(e) ? prev.filter(x => x !== e) : [...prev, e]);
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">Novo canal vinculado</h2>
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Channel ID</label>
              <input value={channelId} onChange={e => setChannelId(e.target.value)}
                placeholder="#general ou C1234567"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm font-mono" />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Nome (exibição)</label>
              <input value={channelName} onChange={e => setChannelName(e.target.value)}
                placeholder="#alertas-prod"
                className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">Entidade</label>
            <select value={entityType} onChange={e => setEntityType(e.target.value)}
              className="w-full border border-gray-300 dark:border-gray-600 rounded-lg px-3 py-2 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm">
              {ENTITY_TYPES.map(e => <option key={e} value={e}>{e}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Eventos</label>
            <div className="flex flex-wrap gap-2">
              {EVENT_TYPES.map(e => (
                <button key={e} onClick={() => toggleEvent(e)}
                  className={`px-2 py-1 rounded text-xs font-medium border transition-colors
                    ${selectedEvents.includes(e)
                      ? "bg-blue-600 text-white border-blue-600"
                      : "border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"}`}>
                  {e}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="flex justify-end gap-2 mt-6">
          <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800">Cancelar</button>
          <button onClick={() => onSave({ channel_id: channelId, channel_name: channelName, entity_type: entityType, event_types: selectedEvents })}
            disabled={!channelId}
            className="px-4 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700 disabled:opacity-50">
            Vincular canal
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Workspace card ────────────────────────────────────────────────────────────

function WorkspaceCard({ ws, onEdit, onDelete, onPing }: {
  ws: Workspace;
  onEdit: () => void;
  onDelete: () => void;
  onPing: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [bindingModal, setBindingModal] = useState(false);
  const qc = useQueryClient();

  const { data: bindings = [] } = useQuery<Binding[]>({
    queryKey: ["chatops-bindings", ws.id],
    queryFn: () => fetch(`${API}/workspaces/${ws.id}/bindings`).then(r => r.json()),
    enabled: expanded,
  });

  const deleteBinding = useMutation({
    mutationFn: (bindingId: string) => fetch(`${API}/workspaces/${ws.id}/bindings/${bindingId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chatops-bindings", ws.id] }),
  });

  const createBinding = useMutation({
    mutationFn: (body: object) => fetch(`${API}/workspaces/${ws.id}/bindings`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then(r => r.json()),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["chatops-bindings", ws.id] }); setBindingModal(false); },
  });

  return (
    <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
      <div className="flex items-center gap-3 p-4">
        <StatusIcon status={ws.status} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-900 dark:text-white">{ws.name}</span>
            <PlatformBadge platform={ws.platform} />
            {ws.status === "error" && ws.error_message && (
              <span className="text-xs text-red-500 truncate max-w-xs">{ws.error_message}</span>
            )}
          </div>
          <p className="text-xs text-gray-500 mt-0.5">
            {ws.binding_count} canal{ws.binding_count !== 1 ? "is" : ""} vinculado{ws.binding_count !== 1 ? "s" : ""}
            {ws.last_ping_at && <> · último ping {fmtDate(ws.last_ping_at)}</>}
          </p>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onPing} title="Testar webhook"
            className="p-1.5 text-gray-400 hover:text-blue-600 rounded hover:bg-blue-50 dark:hover:bg-blue-900/20">
            <Zap size={15} />
          </button>
          <button onClick={onEdit}
            className="p-1.5 text-gray-400 hover:text-gray-600 rounded hover:bg-gray-100 dark:hover:bg-gray-700">
            <Edit2 size={15} />
          </button>
          <button onClick={onDelete}
            className="p-1.5 text-gray-400 hover:text-red-500 rounded hover:bg-red-50 dark:hover:bg-red-900/20">
            <Trash2 size={15} />
          </button>
          <button onClick={() => setExpanded(v => !v)}
            className="p-1.5 text-gray-400 hover:text-gray-600">
            {expanded ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-gray-200 dark:border-gray-700 p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-medium text-gray-700 dark:text-gray-300">Canais vinculados</h4>
            <button onClick={() => setBindingModal(true)}
              className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800 dark:text-blue-400">
              <Plus size={12} /> Vincular canal
            </button>
          </div>
          {bindings.length === 0 ? (
            <p className="text-xs text-gray-400">Nenhum canal vinculado ainda.</p>
          ) : (
            <div className="space-y-2">
              {bindings.map(b => (
                <div key={b.id} className="flex items-center gap-2 text-sm bg-gray-50 dark:bg-gray-700/40 rounded-lg px-3 py-2">
                  <Link2 size={13} className="text-blue-500 shrink-0" />
                  <span className="font-mono text-gray-700 dark:text-gray-300 text-xs">
                    {b.channel_name || b.channel_id}
                  </span>
                  <span className="text-gray-500 text-xs">→ {b.entity_type}</span>
                  <div className="flex flex-wrap gap-1 ml-auto">
                    {b.event_types.map(e => (
                      <span key={e} className="px-1.5 py-0.5 bg-gray-200 dark:bg-gray-600 text-gray-700 dark:text-gray-300 rounded text-xs">{e}</span>
                    ))}
                  </div>
                  <button onClick={() => deleteBinding.mutate(b.id)}
                    className="text-gray-400 hover:text-red-500 ml-1">
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {bindingModal && (
        <BindingModal workspaceId={ws.id} onClose={() => setBindingModal(false)}
          onSave={data => createBinding.mutate(data)} />
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

type Tab = "workspaces" | "messages" | "commands";

export function ChatOpsPage({ tenantId }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("workspaces");
  const [modal, setModal] = useState<Workspace | null | "new">(null);

  const { data: stats } = useQuery<Stats>({
    queryKey: ["chatops-stats", tenantId],
    queryFn: () => fetch(`${API}/stats`).then(r => r.json()),
    refetchInterval: 15_000,
  });

  const { data: workspaces = [] } = useQuery<Workspace[]>({
    queryKey: ["chatops-workspaces", tenantId],
    queryFn: () => fetch(`${API}/workspaces`).then(r => r.json()),
  });

  const { data: messages = [] } = useQuery<OutboundMessage[]>({
    queryKey: ["chatops-messages", tenantId],
    queryFn: () => fetch(`${API}/messages?limit=100`).then(r => r.json()),
    enabled: tab === "messages",
  });

  const { data: commands = [] } = useQuery<CommandLog[]>({
    queryKey: ["chatops-commands", tenantId],
    queryFn: () => fetch(`${API}/commands?limit=100`).then(r => r.json()),
    enabled: tab === "commands",
  });

  const saveWorkspace = useMutation({
    mutationFn: (body: { id?: string } & object) => {
      const { id, ...data } = body as { id?: string } & Record<string, unknown>;
      return fetch(id ? `${API}/workspaces/${id}` : `${API}/workspaces`, {
        method: id ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      }).then(r => r.json());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["chatops-workspaces"] }); setModal(null); },
  });

  const deleteWorkspace = useMutation({
    mutationFn: (id: string) => fetch(`${API}/workspaces/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chatops-workspaces"] }),
  });

  const pingWorkspace = useMutation({
    mutationFn: (id: string) => fetch(`${API}/workspaces/${id}/ping`, { method: "POST" }).then(r => r.json()),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["chatops-workspaces"] }),
  });

  const TABS: { id: Tab; label: string }[] = [
    { id: "workspaces", label: "Workspaces" },
    { id: "messages", label: "Mensagens enviadas" },
    { id: "commands", label: "Comandos recebidos" },
  ];

  const MSG_STATUS: Record<string, { cls: string; icon: typeof CheckCircle }> = {
    pending: { cls: "text-gray-500", icon: Clock },
    sent:    { cls: "text-green-500", icon: CheckCircle },
    failed:  { cls: "text-red-500", icon: XCircle },
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t("nav.chatops", "ChatOps")}
        </h1>
        {tab === "workspaces" && (
          <button onClick={() => setModal("new")}
            className="flex items-center gap-2 px-3 py-2 bg-blue-600 text-white text-sm rounded-lg hover:bg-blue-700">
            <Plus size={16} /> Novo workspace
          </button>
        )}
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          <StatCard icon={MessageSquare} label="Workspaces" value={stats.total_workspaces} color="bg-blue-100 text-blue-600 dark:bg-blue-900 dark:text-blue-300" />
          <StatCard icon={CheckCircle} label="Ativos" value={stats.active_workspaces} color="bg-green-100 text-green-600 dark:bg-green-900 dark:text-green-300" />
          <StatCard icon={Link2} label="Canais vinculados" value={stats.total_bindings} color="bg-purple-100 text-purple-600 dark:bg-purple-900 dark:text-purple-300" />
          <StatCard icon={Send} label="Mensagens enviadas" value={stats.messages_sent} color="bg-teal-100 text-teal-600 dark:bg-teal-900 dark:text-teal-300" />
          <StatCard icon={AlertTriangle} label="Mensagens falharam" value={stats.messages_failed} color="bg-red-100 text-red-600 dark:bg-red-900 dark:text-red-300" />
          <StatCard icon={Terminal} label="Comandos recebidos" value={stats.commands_received} color="bg-gray-100 text-gray-600 dark:bg-gray-700 dark:text-gray-300" />
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-gray-200 dark:border-gray-700 flex gap-6">
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={`pb-3 text-sm font-medium transition-colors
              ${tab === t.id
                ? "border-b-2 border-blue-600 text-blue-600"
                : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Workspaces */}
      {tab === "workspaces" && (
        <div className="space-y-3">
          {workspaces.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <MessageSquare size={40} className="mx-auto mb-3 opacity-30" />
              <p>Nenhum workspace configurado</p>
              <p className="text-xs mt-1 text-gray-400">Adicione um workspace do Slack ou Microsoft Teams para começar.</p>
            </div>
          ) : workspaces.map(ws => (
            <WorkspaceCard key={ws.id} ws={ws}
              onEdit={() => setModal(ws)}
              onDelete={() => { if (confirm(`Excluir workspace "${ws.name}"?`)) deleteWorkspace.mutate(ws.id); }}
              onPing={() => pingWorkspace.mutate(ws.id)} />
          ))}
        </div>
      )}

      {/* Messages */}
      {tab === "messages" && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          {messages.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <Send size={36} className="mx-auto mb-3 opacity-30" />
              <p>Nenhuma mensagem enviada ainda</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Workspace</th>
                  <th className="text-left px-4 py-3 font-medium">Canal</th>
                  <th className="text-left px-4 py-3 font-medium">Entidade</th>
                  <th className="text-left px-4 py-3 font-medium">Evento</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                  <th className="text-left px-4 py-3 font-medium">Enviado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {messages.map(m => {
                  const cfg = MSG_STATUS[m.status] ?? MSG_STATUS.pending;
                  const Icon = cfg.icon;
                  return (
                    <tr key={m.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1.5">
                          {m.platform && <PlatformBadge platform={m.platform as Platform} />}
                          <span className="text-gray-800 dark:text-gray-200">{m.workspace_name ?? "—"}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-600 dark:text-gray-300">{m.channel_id}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">{m.entity_type ?? "—"}</td>
                      <td className="px-4 py-2.5 text-gray-600 dark:text-gray-300">{m.event_type ?? "—"}</td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-1">
                          <Icon size={13} className={cfg.cls} />
                          <span className={`text-xs ${cfg.cls}`}>{m.status}</span>
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500">{fmtDate(m.sent_at ?? m.created_at)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Commands */}
      {tab === "commands" && (
        <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg overflow-hidden">
          {commands.length === 0 ? (
            <div className="text-center py-16 text-gray-500">
              <Terminal size={36} className="mx-auto mb-3 opacity-30" />
              <p>Nenhum comando recebido ainda</p>
              <p className="text-xs mt-1 text-gray-400">Configure o endpoint de webhook inbound no seu app do Slack/Teams.</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-gray-50 dark:bg-gray-900/50 text-xs text-gray-500">
                <tr>
                  <th className="text-left px-4 py-3 font-medium">Recebido</th>
                  <th className="text-left px-4 py-3 font-medium">Workspace</th>
                  <th className="text-left px-4 py-3 font-medium">De</th>
                  <th className="text-left px-4 py-3 font-medium">Comando</th>
                  <th className="text-left px-4 py-3 font-medium">Resposta</th>
                  <th className="text-left px-4 py-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                {commands.map(c => (
                  <tr key={c.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                    <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">{fmtDate(c.received_at)}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <PlatformBadge platform={c.platform as Platform} />
                        <span className="text-xs text-gray-600 dark:text-gray-300">{c.workspace_name ?? "—"}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-600 dark:text-gray-300">{c.sender_name ?? c.channel_id ?? "—"}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-800 dark:text-gray-200">
                      {c.command}{c.args ? ` ${c.args}` : ""}
                    </td>
                    <td className="px-4 py-2.5 text-xs text-gray-500 max-w-xs truncate">{c.response ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <span className={`text-xs font-medium ${c.status === "ok" ? "text-green-500" : c.status === "error" ? "text-red-500" : "text-gray-400"}`}>
                        {c.status}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* Modal */}
      {modal && (
        <WorkspaceModal
          initial={modal === "new" ? null : modal}
          onClose={() => setModal(null)}
          onSave={data => saveWorkspace.mutate(modal === "new" ? data : { ...data, id: (modal as Workspace).id })}
        />
      )}
    </div>
  );
}
