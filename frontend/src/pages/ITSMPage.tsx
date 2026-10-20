import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  CheckCircle, Circle, Clock, AlertTriangle, XCircle,
  ChevronRight, Plus, UserCheck,
} from "lucide-react";

interface RFC {
  rfc_id: string;
  title: string;
  description: string;
  category: string;
  risk: string;
  state: string;
  planned_start?: string;
  planned_end?: string;
  incident_id?: string;
  created_by: string;
  created_at: string;
  updated_at: string;
  tasks?: Task[];
  approvals?: Approval[];
}

interface Task {
  task_id: string;
  title: string;
  state: string;
  assignee_ref?: string;
  updated_at: string;
}

interface Approval {
  approval_id: string;
  approver_ref: string;
  decision: string;
  notes?: string;
  decided_at?: string;
}

interface Member {
  principal_id: string;
  display_name?: string;
  email?: string;
  role: string;
}

// ── State machine ─────────────────────────────────────────────────────────────

const STATES = [
  "draft", "review", "approved", "scheduled", "implementing", "complete",
] as const;

type RFCState = typeof STATES[number];

const STATE_LABELS: Record<string, string> = {
  draft: "Rascunho", review: "Em revisão", approved: "Aprovado",
  scheduled: "Agendado", implementing: "Implementando", complete: "Concluído",
  cancelled: "Cancelado",
};

const STATE_COLORS: Record<string, "muted" | "info" | "warning" | "success" | "danger"> = {
  draft: "muted", review: "warning", approved: "info",
  scheduled: "info", implementing: "warning", complete: "success", cancelled: "muted",
};

const RISK_COLORS: Record<string, "muted" | "info" | "warning" | "danger"> = {
  low: "muted", medium: "info", high: "warning", critical: "danger",
};

const CATEGORY_LABELS: Record<string, string> = {
  standard: "Padrão", normal: "Normal", emergency: "Emergência",
};

function fmtDate(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("pt-BR"); } catch { return iso; }
}

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      day: "2-digit", month: "2-digit", year: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch { return iso; }
}

// ── Progress stepper ──────────────────────────────────────────────────────────

function StateProgress({ state }: { state: string }) {
  if (state === "cancelled") {
    return (
      <div className="flex items-center gap-2 py-3">
        <XCircle className="w-4 h-4 text-[var(--text-muted)]" />
        <span className="text-xs text-[var(--text-muted)]">RFC cancelado</span>
      </div>
    );
  }

  const activeIdx = STATES.indexOf(state as RFCState);

  return (
    <div className="flex items-center gap-0 overflow-x-auto pb-1">
      {STATES.map((s, i) => {
        const done = i < activeIdx;
        const active = i === activeIdx;
        const future = i > activeIdx;
        return (
          <div key={s} className="flex items-center min-w-0">
            <div className={`flex items-center gap-1.5 px-2 py-1 rounded-full text-[10px] font-medium whitespace-nowrap
              ${active ? "bg-[var(--brand)] text-white" : done ? "text-[var(--brand)]" : "text-[var(--text-muted)]"}`}>
              {done
                ? <CheckCircle className="w-3 h-3 flex-shrink-0" />
                : active
                ? <Circle className="w-3 h-3 flex-shrink-0 fill-current" />
                : <Circle className="w-3 h-3 flex-shrink-0" />}
              {STATE_LABELS[s]}
            </div>
            {i < STATES.length - 1 && (
              <ChevronRight className={`w-3 h-3 flex-shrink-0 mx-0.5 ${future ? "text-[var(--border)]" : "text-[var(--brand)]"}`} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── Create form ───────────────────────────────────────────────────────────────

function CreateRFCForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("normal");
  const [risk, setRisk] = useState("medium");
  const [plannedStart, setPlannedStart] = useState("");
  const [plannedEnd, setPlannedEnd] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/itsm/changes", {
        title, description: desc, category, risk,
        planned_start: plannedStart || undefined,
        planned_end: plannedEnd || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-changes", tenantId] });
      onDone();
    },
    onError: (e: unknown) => setErr((e as { detail?: string })?.detail ?? "Erro ao criar RFC."),
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-semibold">Nova solicitação de mudança (RFC)</h3>

      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Título *</label>
        <input value={title} onChange={e => setTitle(e.target.value)}
          placeholder="Resumo breve da mudança"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Descrição — impacto, plano de rollback, passos de teste *</label>
        <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={4}
          placeholder="Descreva o impacto esperado, como reverter se necessário e os passos para validar..."
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)] resize-none" />
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Categoria</label>
          <select value={category} onChange={e => setCategory(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
            <option value="standard">Padrão</option>
            <option value="normal">Normal</option>
            <option value="emergency">Emergência</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Risco</label>
          <select value={risk} onChange={e => setRisk(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
            <option value="low">Baixo</option>
            <option value="medium">Médio</option>
            <option value="high">Alto</option>
            <option value="critical">Crítico</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Início planejado</label>
          <input type="datetime-local" value={plannedStart} onChange={e => setPlannedStart(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Fim planejado</label>
          <input type="datetime-local" value={plannedEnd} onChange={e => setPlannedEnd(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
        </div>
      </div>

      {err && <p className="text-xs text-[var(--red)]">{err}</p>}

      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !title.trim()}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}
          Criar RFC
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>Cancelar</Button>
      </div>
    </Card>
  );
}

// ── RFC Detail ────────────────────────────────────────────────────────────────

function RFCDetail({ rfc, tenantId, onBack }: {
  rfc: RFC; tenantId: string; onBack: () => void;
}) {
  const qc = useQueryClient();
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [approver, setApprover] = useState("");
  const [approvalNotes, setApprovalNotes] = useState("");
  const [schedStart, setSchedStart] = useState(rfc.planned_start?.slice(0, 16) ?? "");
  const [schedEnd, setSchedEnd] = useState(rfc.planned_end?.slice(0, 16) ?? "");

  const detail = useQuery({
    queryKey: ["itsm-rfc", rfc.rfc_id],
    queryFn: () => api.get<RFC>(`/api/v1/itsm/changes/${rfc.rfc_id}`),
  });

  const membersQ = useQuery({
    queryKey: ["members", tenantId],
    queryFn: () => api.get<Member[]>("/api/v1/tenant/members"),
    staleTime: 60_000,
  });

  const transition = (state: string, extra?: Record<string, unknown>) =>
    api.put(`/api/v1/itsm/changes/${rfc.rfc_id}`, { state, ...extra });

  const transMut = useMutation({
    mutationFn: (payload: { state: string; [k: string]: unknown }) =>
      transition(payload.state, payload),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-rfc", rfc.rfc_id] });
      qc.invalidateQueries({ queryKey: ["itsm-changes", tenantId] });
    },
  });

  const addTaskMut = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/itsm/changes/${rfc.rfc_id}/tasks`, {
        title: taskTitle,
        assignee_ref: taskAssignee || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-rfc", rfc.rfc_id] });
      setTaskTitle(""); setTaskAssignee("");
    },
  });

  const taskStateMut = useMutation({
    mutationFn: ({ task_id, state }: { task_id: string; state: string }) =>
      api.put(`/api/v1/itsm/changes/${rfc.rfc_id}/tasks/${task_id}`, { state }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["itsm-rfc", rfc.rfc_id] }),
  });

  const approvalMut = useMutation({
    mutationFn: (decision: "approved" | "rejected") =>
      api.post(`/api/v1/itsm/changes/${rfc.rfc_id}/approvals`, {
        approver_ref: approver, decision, notes: approvalNotes || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-rfc", rfc.rfc_id] });
      qc.invalidateQueries({ queryKey: ["itsm-changes", tenantId] });
      setApprover(""); setApprovalNotes("");
    },
  });

  const d = detail.data ?? rfc;
  const tasks = d.tasks ?? [];
  const approvals = d.approvals ?? [];
  const members: Member[] = membersQ.data ?? [];

  const tasksDone = tasks.length > 0 &&
    tasks.every(t => t.state === "done" || t.state === "skipped");
  const hasRejection = approvals.some(a => a.decision === "rejected");

  const isCancellable = !["complete", "cancelled"].includes(d.state);

  function memberLabel(m: Member) {
    return m.display_name || m.email || m.principal_id;
  }

  return (
    <div className="space-y-4">
      {/* Back + meta */}
      <div className="flex items-center gap-3 flex-wrap">
        <button onClick={onBack}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--brand)] underline flex-shrink-0">
          ← Mudanças
        </button>
        <Badge variant={STATE_COLORS[d.state] ?? "muted"}>{STATE_LABELS[d.state] ?? d.state}</Badge>
        <Badge variant={RISK_COLORS[d.risk] ?? "muted"}>Risco: {d.risk}</Badge>
        <span className="text-xs text-[var(--text-muted)] capitalize">{CATEGORY_LABELS[d.category] ?? d.category}</span>
        {isCancellable && (
          <button
            onClick={() => { if (confirm("Cancelar esta RFC?")) transMut.mutate({ state: "cancelled" }); }}
            className="ml-auto text-xs text-[var(--text-muted)] hover:text-[var(--red)] transition-colors">
            Cancelar RFC
          </button>
        )}
      </div>

      {/* Progress */}
      <Card className="p-3">
        <StateProgress state={d.state} />
      </Card>

      {/* Detail card */}
      <Card className="p-4 space-y-2">
        <h2 className="text-sm font-semibold">{d.title}</h2>
        {d.description && (
          <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap">{d.description}</p>
        )}
        <div className="flex flex-wrap gap-4 text-xs text-[var(--text-muted)] pt-1">
          <span>Criado por <strong className="text-[var(--text)]">{d.created_by}</strong></span>
          <span>Em {fmtDate(d.created_at)}</span>
          {d.planned_start && <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{fmtTs(d.planned_start)}</span>}
          {d.planned_end && <span>até {fmtTs(d.planned_end)}</span>}
          {d.incident_id && <span>Incidente: {d.incident_id}</span>}
        </div>

        {/* Transition actions */}
        <div className="flex flex-wrap gap-2 pt-2">
          {d.state === "draft" && (
            <Button size="sm" onClick={() => transMut.mutate({ state: "review" })}
              disabled={transMut.isPending}>
              Enviar para revisão →
            </Button>
          )}

          {d.state === "approved" && (
            <div className="flex items-end gap-2 flex-wrap">
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-muted)]">Início</label>
                <input type="datetime-local" value={schedStart}
                  onChange={e => setSchedStart(e.target.value)}
                  className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-[var(--text-muted)]">Fim</label>
                <input type="datetime-local" value={schedEnd}
                  onChange={e => setSchedEnd(e.target.value)}
                  className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
              </div>
              <Button size="sm"
                onClick={() => transMut.mutate({ state: "scheduled", planned_start: schedStart || undefined, planned_end: schedEnd || undefined })}
                disabled={transMut.isPending || !schedStart}>
                Agendar →
              </Button>
            </div>
          )}

          {d.state === "scheduled" && (
            <Button size="sm" onClick={() => transMut.mutate({ state: "implementing" })}
              disabled={transMut.isPending}>
              Iniciar implementação →
            </Button>
          )}

          {d.state === "implementing" && tasksDone && (
            <Button size="sm"
              onClick={() => transMut.mutate({ state: "complete" })}
              disabled={transMut.isPending}>
              <CheckCircle className="w-3.5 h-3.5 mr-1" />
              Concluir RFC
            </Button>
          )}

          {d.state === "implementing" && tasks.length > 0 && !tasksDone && (
            <p className="text-xs text-[var(--text-muted)] flex items-center gap-1">
              <Clock className="w-3 h-3" />
              {tasks.filter(t => t.state === "done" || t.state === "skipped").length}/{tasks.length} tarefas concluídas
            </p>
          )}
        </div>
      </Card>

      {/* Tasks */}
      {(d.state !== "draft" || tasks.length > 0) && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Tarefas
            {tasks.length > 0 && (
              <span className="ml-2 normal-case font-normal">
                {tasks.filter(t => t.state === "done" || t.state === "skipped").length}/{tasks.length}
              </span>
            )}
          </h3>

          {tasks.length === 0 && (
            <p className="text-xs text-[var(--text-muted)]">Nenhuma tarefa. Adicione as etapas de execução.</p>
          )}

          {tasks.map(t => {
            const done = t.state === "done" || t.state === "skipped";
            return (
              <Card key={t.task_id} className={`p-3 flex items-center gap-3 ${done ? "opacity-60" : ""}`}>
                <div className="flex-1 min-w-0">
                  <p className={`text-xs font-medium ${done ? "line-through" : ""}`}>{t.title}</p>
                  {t.assignee_ref && (
                    <p className="text-[10px] text-[var(--text-muted)] flex items-center gap-1 mt-0.5">
                      <UserCheck className="w-3 h-3" />{t.assignee_ref}
                    </p>
                  )}
                </div>
                <select value={t.state}
                  onChange={e => taskStateMut.mutate({ task_id: t.task_id, state: e.target.value })}
                  disabled={["complete", "cancelled"].includes(d.state)}
                  className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--text)] focus:outline-none flex-shrink-0">
                  <option value="open">Aberta</option>
                  <option value="in_progress">Em andamento</option>
                  <option value="done">Concluída</option>
                  <option value="skipped">Ignorada</option>
                </select>
              </Card>
            );
          })}

          {!["complete", "cancelled"].includes(d.state) && (
            <div className="flex gap-2">
              <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)}
                placeholder="Nova tarefa…"
                className="flex-1 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
              {members.length > 0 ? (
                <select value={taskAssignee} onChange={e => setTaskAssignee(e.target.value)}
                  className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
                  <option value="">Responsável</option>
                  {members.map(m => (
                    <option key={m.principal_id} value={m.principal_id}>{memberLabel(m)}</option>
                  ))}
                </select>
              ) : (
                <input value={taskAssignee} onChange={e => setTaskAssignee(e.target.value)}
                  placeholder="Responsável"
                  className="w-32 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
              )}
              <Button size="sm" onClick={() => addTaskMut.mutate()}
                disabled={addTaskMut.isPending || !taskTitle.trim()}>
                <Plus className="w-3.5 h-3.5" />
              </Button>
            </div>
          )}
        </div>
      )}

      {/* Approvals */}
      {(d.state === "review" || approvals.length > 0) && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Aprovações
          </h3>

          {hasRejection && (
            <div className="flex items-center gap-2 p-3 rounded-lg bg-[var(--red)]/10 border border-[var(--red)]/20 text-xs text-[var(--red)]">
              <AlertTriangle className="w-3.5 h-3.5 flex-shrink-0" />
              RFC rejeitado — revise e reenvie para revisão se necessário.
            </div>
          )}

          {approvals.map(a => (
            <Card key={a.approval_id} className="p-3 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <p className="text-xs font-medium truncate">{a.approver_ref}</p>
                {a.notes && <p className="text-[10px] text-[var(--text-muted)] mt-0.5">{a.notes}</p>}
                {a.decided_at && <p className="text-[10px] text-[var(--text-muted)]">{fmtTs(a.decided_at)}</p>}
              </div>
              <Badge variant={a.decision === "approved" ? "success" : a.decision === "rejected" ? "danger" : "muted"}>
                {a.decision === "approved" ? "Aprovado" : a.decision === "rejected" ? "Rejeitado" : "Pendente"}
              </Badge>
            </Card>
          ))}

          {d.state === "review" && (
            <Card className="p-3 space-y-2">
              <p className="text-xs font-medium">Registrar decisão</p>
              <div className="flex gap-2">
                {members.length > 0 ? (
                  <select value={approver} onChange={e => setApprover(e.target.value)}
                    className="flex-1 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
                    <option value="">Selecionar aprovador…</option>
                    {members.map(m => (
                      <option key={m.principal_id} value={m.principal_id}>{memberLabel(m)}</option>
                    ))}
                  </select>
                ) : (
                  <input value={approver} onChange={e => setApprover(e.target.value)}
                    placeholder="Nome ou ID do aprovador"
                    className="flex-1 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
                )}
              </div>
              <textarea value={approvalNotes} onChange={e => setApprovalNotes(e.target.value)}
                placeholder="Notas (opcional)" rows={2}
                className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)] resize-none" />
              <div className="flex gap-2">
                <Button size="sm"
                  onClick={() => approvalMut.mutate("approved")}
                  disabled={approvalMut.isPending || !approver.trim()}>
                  <CheckCircle className="w-3.5 h-3.5 mr-1" />
                  Aprovar
                </Button>
                <Button variant="danger" size="sm"
                  onClick={() => approvalMut.mutate("rejected")}
                  disabled={approvalMut.isPending || !approver.trim()}>
                  <XCircle className="w-3.5 h-3.5 mr-1" />
                  Rejeitar
                </Button>
              </div>
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

// ── List ──────────────────────────────────────────────────────────────────────

export function ITSMPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<RFC | null>(null);
  const [filterState, setFilterState] = useState<string>("active");

  const q = useQuery({
    queryKey: ["itsm-changes", tenantId],
    queryFn: () => api.get<RFC[]>("/api/v1/itsm/changes"),
  });

  if (selected) {
    return (
      <RFCDetail
        rfc={selected}
        tenantId={tenantId}
        onBack={() => {
          setSelected(null);
          qc.invalidateQueries({ queryKey: ["itsm-changes", tenantId] });
        }}
      />
    );
  }

  const rfcs = q.data ?? [];

  const filtered = filterState === "active"
    ? rfcs.filter(r => !["complete", "cancelled"].includes(r.state))
    : filterState === "done"
    ? rfcs.filter(r => ["complete", "cancelled"].includes(r.state))
    : rfcs;

  const counts = {
    active: rfcs.filter(r => !["complete", "cancelled"].includes(r.state)).length,
    done: rfcs.filter(r => ["complete", "cancelled"].includes(r.state)).length,
    all: rfcs.length,
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div>
          <h2 className="text-base font-semibold">{t("itsm.title")}</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            RFCs, aprovações e tarefas de mudança.
          </p>
        </div>
        {!creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            <Plus className="w-3.5 h-3.5 mr-1" />
            Nova RFC
          </Button>
        )}
      </div>

      {creating && (
        <CreateRFCForm tenantId={tenantId} onDone={() => setCreating(false)} />
      )}

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-[var(--border)] pb-0">
        {(["active", "done", "all"] as const).map(f => (
          <button key={f}
            onClick={() => setFilterState(f)}
            className={`px-3 py-1.5 text-xs font-medium rounded-t border-b-2 transition-colors ${
              filterState === f
                ? "border-[var(--brand)] text-[var(--brand)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}>
            {f === "active" ? "Em andamento" : f === "done" ? "Concluídos" : "Todos"}
            <span className="ml-1.5 text-[10px] opacity-70">
              {counts[f]}
            </span>
          </button>
        ))}
      </div>

      <Card className="p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)] p-4">Falha ao carregar mudanças.</p>
        ) : filtered.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] p-4">
            {filterState === "active"
              ? "Nenhuma RFC em andamento. Crie uma para começar."
              : "Nenhuma RFC nesta categoria."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">Estado</th>
                  <th className="px-4 py-2.5 font-medium">Título</th>
                  <th className="px-4 py-2.5 font-medium">Categoria</th>
                  <th className="px-4 py-2.5 font-medium">Risco</th>
                  <th className="px-4 py-2.5 font-medium">Agendado</th>
                  <th className="px-4 py-2.5 font-medium">Criado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {filtered.map(r => (
                  <tr key={r.rfc_id}
                    onClick={() => setSelected(r)}
                    className="hover:bg-[var(--surface-2)] cursor-pointer transition-colors">
                    <td className="px-4 py-2.5">
                      <Badge variant={STATE_COLORS[r.state] ?? "muted"}>
                        {STATE_LABELS[r.state] ?? r.state}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 font-medium text-[var(--text)] max-w-xs truncate">
                      {r.title}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {CATEGORY_LABELS[r.category] ?? r.category}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={RISK_COLORS[r.risk] ?? "muted"}>{r.risk}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {r.planned_start ? fmtTs(r.planned_start) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtDate(r.created_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
