import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  Plus, MessageSquare, Clock, CheckCircle, AlertTriangle, XCircle,
  ChevronDown, ChevronRight, Lock,
} from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Category {
  category_id: string;
  name: string;
  description: string;
  response_secs?: number;
  resolve_secs?: number;
}

interface Ticket {
  ticket_id: string;
  category_id?: string;
  title: string;
  description: string;
  priority: string;
  status: string;
  requester_id: string;
  assignee_id?: string;
  response_sla_deadline_at?: string;
  resolve_sla_deadline_at?: string;
  first_response_at?: string;
  resolved_at?: string;
  created_at: string;
  updated_at: string;
}

interface Comment {
  comment_id: string;
  author_id: string;
  body: string;
  is_internal: boolean;
  created_at: string;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const PRIORITY_COLORS: Record<string, "muted" | "info" | "warning" | "danger"> = {
  low: "muted", medium: "info", high: "warning", critical: "danger",
};

const STATUS_COLORS: Record<string, "muted" | "info" | "warning" | "success" | "danger"> = {
  open: "warning", in_progress: "info", waiting: "muted",
  resolved: "success", closed: "muted",
};

const STATUS_LABELS: Record<string, string> = {
  open: "Aberto", in_progress: "Em atendimento", waiting: "Aguardando",
  resolved: "Resolvido", closed: "Encerrado",
};

const PRIORITY_LABELS: Record<string, string> = {
  low: "Baixa", medium: "Média", high: "Alta", critical: "Crítica",
};

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

function slaColor(deadline?: string): string {
  if (!deadline) return "text-[var(--text-muted)]";
  const diff = new Date(deadline).getTime() - Date.now();
  if (diff < 0) return "text-red-500";
  if (diff < 3600_000) return "text-orange-400";
  return "text-[var(--text-muted)]";
}

// ── Create Ticket Form ────────────────────────────────────────────────────────

function CreateTicketForm({
  tenantId, categories, onDone,
}: { tenantId: string; categories: Category[]; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [priority, setPriority] = useState("medium");
  const [categoryId, setCategoryId] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/helpdesk/tickets", {
        title, description: desc, priority,
        category_id: categoryId || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["helpdesk-tickets", tenantId] });
      onDone();
    },
    onError: (e: unknown) =>
      setErr((e as { detail?: string })?.detail ?? "Erro ao criar ticket."),
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-semibold">Novo chamado</h3>

      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Título *</label>
        <input
          value={title} onChange={e => setTitle(e.target.value)}
          placeholder="Resumo do problema ou solicitação"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Descrição</label>
        <textarea
          value={desc} onChange={e => setDesc(e.target.value)} rows={3}
          placeholder="Descreva o problema com detalhes..."
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)] resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Prioridade</label>
          <select
            value={priority} onChange={e => setPriority(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
          >
            <option value="low">Baixa</option>
            <option value="medium">Média</option>
            <option value="high">Alta</option>
            <option value="critical">Crítica</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Categoria</label>
          <select
            value={categoryId} onChange={e => setCategoryId(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
          >
            <option value="">Sem categoria</option>
            {categories.map(c => (
              <option key={c.category_id} value={c.category_id}>{c.name}</option>
            ))}
          </select>
        </div>
      </div>

      {err && <p className="text-xs text-red-400">{err}</p>}

      <div className="flex gap-2 justify-end">
        <Button variant="ghost" size="sm" onClick={onDone}>Cancelar</Button>
        <Button
          size="sm"
          onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !title.trim()}
        >
          {mut.isPending ? <Spinner className="w-3 h-3" /> : <Plus className="w-3 h-3" />}
          Abrir chamado
        </Button>
      </div>
    </Card>
  );
}

// ── Ticket Detail ─────────────────────────────────────────────────────────────

function TicketDetail({
  ticket, tenantId, canOperate,
}: { ticket: Ticket; tenantId: string; canOperate: boolean }) {
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [isInternal, setIsInternal] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const { data: comments = [], isLoading: loadingComments } = useQuery({
    queryKey: ["helpdesk-comments", ticket.ticket_id],
    queryFn: () => api.get<Comment[]>(`/api/v1/helpdesk/tickets/${ticket.ticket_id}/comments`),
  });

  const updateMut = useMutation({
    mutationFn: (body: { status?: string; priority?: string }) =>
      api.patch(`/api/v1/helpdesk/tickets/${ticket.ticket_id}`, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["helpdesk-tickets", tenantId] }),
  });

  async function submitComment() {
    if (!comment.trim()) return;
    setSubmitting(true);
    try {
      await api.post(`/api/v1/helpdesk/tickets/${ticket.ticket_id}/comments`, {
        body: comment, is_internal: isInternal,
      });
      setComment("");
      qc.invalidateQueries({ queryKey: ["helpdesk-comments", ticket.ticket_id] });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs text-[var(--text-muted)]">{ticket.ticket_id}</p>
          <h3 className="text-sm font-semibold mt-0.5">{ticket.title}</h3>
        </div>
        {canOperate && ticket.status !== "closed" && (
          <div className="flex gap-1.5 flex-wrap">
            {ticket.status !== "in_progress" && (
              <Button size="sm" variant="outline"
                onClick={() => updateMut.mutate({ status: "in_progress" })}>
                Em atendimento
              </Button>
            )}
            {ticket.status !== "resolved" && (
              <Button size="sm" variant="outline"
                onClick={() => updateMut.mutate({ status: "resolved" })}>
                <CheckCircle className="w-3 h-3" /> Resolver
              </Button>
            )}
            {ticket.status === "resolved" && (
              <Button size="sm" variant="outline"
                onClick={() => updateMut.mutate({ status: "closed" })}>
                <XCircle className="w-3 h-3" /> Encerrar
              </Button>
            )}
          </div>
        )}
      </div>

      {ticket.description && (
        <p className="text-xs text-[var(--text-muted)] bg-[var(--surface-2)] rounded p-3 leading-relaxed">
          {ticket.description}
        </p>
      )}

      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <div className="text-[var(--text-muted)]">SLA resposta</div>
        <div className={slaColor(ticket.response_sla_deadline_at)}>
          {fmtTs(ticket.response_sla_deadline_at)}
          {ticket.first_response_at && <span className="ml-1 text-green-500">✓</span>}
        </div>
        <div className="text-[var(--text-muted)]">SLA resolução</div>
        <div className={slaColor(ticket.resolve_sla_deadline_at)}>
          {fmtTs(ticket.resolve_sla_deadline_at)}
          {ticket.resolved_at && <span className="ml-1 text-green-500">✓</span>}
        </div>
        <div className="text-[var(--text-muted)]">Aberto em</div>
        <div>{fmtTs(ticket.created_at)}</div>
      </div>

      {/* Comments */}
      <div className="space-y-2">
        <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Comentários ({comments.length})
        </p>

        {loadingComments && <Spinner className="w-4 h-4" />}

        {comments.map(c => (
          <div key={c.comment_id}
            className={`rounded p-2.5 text-xs space-y-1 ${c.is_internal
              ? "bg-yellow-500/8 border border-yellow-500/20"
              : "bg-[var(--surface-2)]"}`}>
            <div className="flex items-center gap-2">
              <span className="font-medium text-[var(--text)]">{c.author_id.split(":").pop()}</span>
              {c.is_internal && (
                <span className="flex items-center gap-0.5 text-yellow-500 text-[10px]">
                  <Lock className="w-2.5 h-2.5" /> Nota interna
                </span>
              )}
              <span className="ml-auto text-[var(--text-muted)]">{fmtTs(c.created_at)}</span>
            </div>
            <p className="text-[var(--text-muted)] leading-relaxed whitespace-pre-wrap">{c.body}</p>
          </div>
        ))}

        {/* Add comment */}
        <div className="space-y-2 pt-1">
          <textarea
            value={comment} onChange={e => setComment(e.target.value)} rows={2}
            placeholder="Adicionar comentário..."
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)] resize-none"
          />
          <div className="flex items-center gap-3 justify-between">
            {canOperate && (
              <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer">
                <input type="checkbox" checked={isInternal}
                  onChange={e => setIsInternal(e.target.checked)}
                  className="w-3 h-3 rounded" />
                Nota interna
              </label>
            )}
            <Button size="sm" className="ml-auto"
              onClick={submitComment}
              disabled={submitting || !comment.trim()}>
              {submitting ? <Spinner className="w-3 h-3" /> : <MessageSquare className="w-3 h-3" />}
              Comentar
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export function HelpDeskPage({ tenantId, permissions = [] }: {
  tenantId: string;
  permissions?: string[];
}) {
  const { t } = useTranslation();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("open");

  const canOperate = permissions.includes("monitoring:operate") || permissions.includes("tenant:admin");

  const { data: categories = [] } = useQuery({
    queryKey: ["helpdesk-categories", tenantId],
    queryFn: () => api.get<Category[]>("/api/v1/helpdesk/categories"),
  });

  const { data: tickets = [], isLoading } = useQuery({
    queryKey: ["helpdesk-tickets", tenantId, statusFilter],
    queryFn: () =>
      api.get<Ticket[]>(`/api/v1/helpdesk/tickets${statusFilter ? `?ticket_status=${statusFilter}` : ""}`),
    refetchInterval: 30_000,
  });

  const selectedTicket = tickets.find(t => t.ticket_id === selected) ?? null;

  const catMap = Object.fromEntries(categories.map(c => [c.category_id, c.name]));

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-base font-semibold">{t("nav.helpdesk", "Helpdesk")}</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Chamados de suporte com SLA e histórico de comentários
          </p>
        </div>
        <Button size="sm" onClick={() => { setCreating(true); setSelected(null); }}>
          <Plus className="w-3 h-3" /> Novo chamado
        </Button>
      </div>

      {creating && (
        <CreateTicketForm
          tenantId={tenantId}
          categories={categories}
          onDone={() => setCreating(false)}
        />
      )}

      {/* Status filter tabs */}
      <div className="flex gap-1 flex-wrap">
        {["open", "in_progress", "waiting", "resolved", "closed", ""].map(s => (
          <button
            key={s}
            onClick={() => { setStatusFilter(s); setSelected(null); }}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              statusFilter === s
                ? "bg-[var(--brand)] text-white border-transparent"
                : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--brand)]"
            }`}
          >
            {s ? STATUS_LABELS[s] : "Todos"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Ticket list */}
        <div className="space-y-2">
          {isLoading && <Spinner className="w-4 h-4 mx-auto mt-8" />}

          {!isLoading && tickets.length === 0 && (
            <Card className="p-8 text-center">
              <CheckCircle className="w-8 h-8 mx-auto text-[var(--text-muted)] mb-2" />
              <p className="text-sm text-[var(--text-muted)]">Nenhum chamado encontrado</p>
            </Card>
          )}

          {tickets.map(ticket => (
            <Card
              key={ticket.ticket_id}
              className={`p-3 cursor-pointer transition-colors hover:border-[var(--brand)] ${
                selected === ticket.ticket_id ? "border-[var(--brand)] bg-[var(--surface-2)]" : ""
              }`}
              onClick={() => setSelected(selected === ticket.ticket_id ? null : ticket.ticket_id)}
            >
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 flex-wrap mb-1">
                    <Badge variant={STATUS_COLORS[ticket.status] ?? "muted"}>
                      {STATUS_LABELS[ticket.status] ?? ticket.status}
                    </Badge>
                    <Badge variant={PRIORITY_COLORS[ticket.priority] ?? "muted"}>
                      {PRIORITY_LABELS[ticket.priority] ?? ticket.priority}
                    </Badge>
                    {ticket.category_id && catMap[ticket.category_id] && (
                      <span className="text-[10px] text-[var(--text-muted)] bg-[var(--surface-2)] px-1.5 py-0.5 rounded">
                        {catMap[ticket.category_id]}
                      </span>
                    )}
                  </div>
                  <p className="text-xs font-medium text-[var(--text)] truncate">{ticket.title}</p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                      <Clock className="w-2.5 h-2.5" />
                      {fmtTs(ticket.created_at)}
                    </span>
                    {ticket.resolve_sla_deadline_at && !ticket.resolved_at && (
                      <span className={`text-[10px] flex items-center gap-0.5 ${slaColor(ticket.resolve_sla_deadline_at)}`}>
                        <AlertTriangle className="w-2.5 h-2.5" />
                        SLA {fmtTs(ticket.resolve_sla_deadline_at)}
                      </span>
                    )}
                  </div>
                </div>
                {selected === ticket.ticket_id
                  ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0" />
                  : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)] flex-shrink-0" />}
              </div>
            </Card>
          ))}
        </div>

        {/* Ticket detail panel */}
        {selectedTicket && (
          <Card className="p-4 h-fit sticky top-4">
            <TicketDetail
              ticket={selectedTicket}
              tenantId={tenantId}
              canOperate={canOperate}
            />
          </Card>
        )}
      </div>
    </div>
  );
}
