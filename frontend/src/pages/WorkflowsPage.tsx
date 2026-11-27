import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import {
  Plus, Play, Settings, Archive, ChevronDown, ChevronRight,
  CheckCircle2, Clock, XCircle, AlertCircle, Loader2, Copy,
  Trash2, Pencil, ArrowUp, ArrowDown
} from "lucide-react";

// ── Types ────────────────────────────────────────────────────────────────────

interface Workflow {
  id: string;
  name: string;
  description: string;
  status: "active" | "archived";
  cloned_from: string | null;
  step_count: number;
  last_run_status: string | null;
  created_at: string;
}

interface WorkflowStep {
  id: string;
  position: number;
  name: string;
  description: string;
  step_type: "manual" | "noop" | "webhook";
  config: Record<string, unknown>;
  approval_required: boolean;
}

interface WorkflowDetail extends Workflow {
  steps: WorkflowStep[];
}

interface WorkflowRun {
  id: string;
  workflow_id: string;
  workflow_name: string;
  status: "running" | "waiting_approval" | "completed" | "failed" | "cancelled";
  current_step_position: number | null;
  started_at: string;
  finished_at: string | null;
  total_steps: number;
  done_steps: number;
}

interface StepRun {
  id: string;
  step_id: string;
  position: number;
  status: "pending" | "running" | "waiting_approval" | "approved" | "completed" | "rejected" | "failed";
  step_name: string;
  step_description: string;
  step_type: string;
  approval_required: boolean;
  approved_by: string | null;
  approved_at: string | null;
  rejection_reason: string | null;
  output: string | null;
  started_at: string | null;
  finished_at: string | null;
}

interface RunDetail extends WorkflowRun {
  step_runs: StepRun[];
}

// ── Helpers ──────────────────────────────────────────────────────────────────

const RUN_VARIANTS: Record<string, string> = {
  running:          "#2563eb",
  waiting_approval: "#d97706",
  completed:        "#16a34a",
  failed:           "#dc2626",
  cancelled:        "#6b7280",
};

const STEP_VARIANTS: Record<string, string> = {
  pending:          "#9ca3af",
  running:          "#2563eb",
  waiting_approval: "#d97706",
  approved:         "#16a34a",
  completed:        "#16a34a",
  rejected:         "#dc2626",
  failed:           "#dc2626",
};

const RUN_LABELS: Record<string, string> = {
  running:          "Executando",
  waiting_approval: "Ag. aprovação",
  completed:        "Concluído",
  failed:           "Falhou",
  cancelled:        "Cancelado",
};

const STEP_LABELS: Record<string, string> = {
  pending:          "Pendente",
  running:          "Executando",
  waiting_approval: "Ag. aprovação",
  approved:         "Aprovado",
  completed:        "Concluído",
  rejected:         "Rejeitado",
  failed:           "Falhou",
};

function StatusBadge({ status, map, labels }: { status: string; map: Record<string, string>; labels: Record<string, string> }) {
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 8px", borderRadius: 12, fontSize: 11, fontWeight: 600,
      background: (map[status] || "#6b7280") + "22",
      color: map[status] || "#6b7280",
    }}>
      {labels[status] || status}
    </span>
  );
}

function fmt(dt: string | null) {
  if (!dt) return "—";
  return new Date(dt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
}

// ── Step Editor Modal ─────────────────────────────────────────────────────────

function StepEditorModal({
  workflowId,
  steps,
  onClose,
}: {
  workflowId: string;
  steps: WorkflowStep[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", description: "", step_type: "manual", approval_required: false });
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const addMut = useMutation({
    mutationFn: (data: typeof form) => api.post(`/workflows/${workflowId}/steps`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workflow", workflowId] }); setForm({ name: "", description: "", step_type: "manual", approval_required: false }); },
  });

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<typeof form> }) =>
      api.put(`/workflows/${workflowId}/steps/${id}`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workflow", workflowId] }); setEditingId(null); },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/workflows/${workflowId}/steps/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workflow", workflowId] }); setConfirmDeleteId(null); },
  });

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: "var(--bg)", borderRadius: 12, width: "100%", maxWidth: 600,
        maxHeight: "85vh", display: "flex", flexDirection: "column",
        border: "1px solid var(--border)",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <span style={{ fontWeight: 600 }}>Passos do fluxo</span>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-muted)", fontSize: 20 }}>×</button>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: 20 }}>
          {steps.length === 0 && <p style={{ color: "var(--fg-muted)", textAlign: "center", marginBottom: 24 }}>Nenhum passo. Adicione abaixo.</p>}
          {steps.map((s, idx) => (
            <div key={s.id} style={{
              display: "flex", alignItems: "flex-start", gap: 10, marginBottom: 10,
              padding: 10, borderRadius: 8, border: "1px solid var(--border)", background: "var(--bg-subtle)",
            }}>
              <span style={{ minWidth: 24, textAlign: "center", fontWeight: 700, color: "var(--fg-muted)", paddingTop: 2 }}>{idx + 1}</span>
              {editingId === s.id ? (
                <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
                  <input
                    defaultValue={s.name}
                    id={`edit-name-${s.id}`}
                    style={inputStyle}
                    placeholder="Nome do passo"
                  />
                  <div style={{ display: "flex", gap: 8 }}>
                    <select defaultValue={s.step_type} id={`edit-type-${s.id}`} style={inputStyle}>
                      <option value="manual">Manual</option>
                      <option value="webhook">Webhook</option>
                      <option value="noop">Noop</option>
                    </select>
                    <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                      <input type="checkbox" defaultChecked={s.approval_required} id={`edit-approval-${s.id}`} />
                      Requer aprovação
                    </label>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      onClick={() => updateMut.mutate({
                        id: s.id,
                        data: {
                          name: (document.getElementById(`edit-name-${s.id}`) as HTMLInputElement)?.value,
                          step_type: (document.getElementById(`edit-type-${s.id}`) as HTMLSelectElement)?.value as "manual",
                          approval_required: (document.getElementById(`edit-approval-${s.id}`) as HTMLInputElement)?.checked,
                        },
                      })}
                      style={btnPrimary}
                    >Salvar</button>
                    <button onClick={() => setEditingId(null)} style={btnSecondary}>Cancelar</button>
                  </div>
                </div>
              ) : (
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500 }}>{s.name}</div>
                  <div style={{ fontSize: 12, color: "var(--fg-muted)", display: "flex", gap: 8, marginTop: 2 }}>
                    <span>{s.step_type}</span>
                    {s.approval_required && <span style={{ color: "#d97706" }}>Requer aprovação</span>}
                  </div>
                </div>
              )}
              {editingId !== s.id && (
                <div style={{ display: "flex", gap: 4 }}>
                  <button onClick={() => setEditingId(s.id)} title="Editar" style={iconBtn}><Pencil size={14} /></button>
                  <button onClick={() => setConfirmDeleteId(s.id)} title="Remover" style={{ ...iconBtn, color: "#dc2626" }}><Trash2 size={14} /></button>
                </div>
              )}
            </div>
          ))}

          <div style={{ marginTop: 16, padding: 12, borderRadius: 8, border: "1px dashed var(--border)" }}>
            <div style={{ fontWeight: 500, marginBottom: 10, fontSize: 13 }}>+ Novo passo</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                placeholder="Nome do passo"
                style={inputStyle}
              />
              <div style={{ display: "flex", gap: 8 }}>
                <select
                  value={form.step_type}
                  onChange={e => setForm(f => ({ ...f, step_type: e.target.value }))}
                  style={inputStyle}
                >
                  <option value="manual">Manual</option>
                  <option value="webhook">Webhook</option>
                  <option value="noop">Noop</option>
                </select>
                <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={form.approval_required}
                    onChange={e => setForm(f => ({ ...f, approval_required: e.target.checked }))}
                  />
                  Requer aprovação
                </label>
              </div>
              <button
                onClick={() => form.name.trim() && addMut.mutate(form)}
                disabled={!form.name.trim() || addMut.isPending}
                style={btnPrimary}
              >
                {addMut.isPending ? "Adicionando…" : "Adicionar passo"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {confirmDeleteId && (
        <ConfirmModal
          title="Remover passo"
          message="Remover este passo permanentemente?"
          confirmLabel="Remover"
          onConfirm={() => deleteMut.mutate(confirmDeleteId)}
          onCancel={() => setConfirmDeleteId(null)}
        />
      )}
    </div>
  );
}

// ── Run Detail Panel ──────────────────────────────────────────────────────────

function RunDetailPanel({
  runId,
  tenantId,
  onClose,
}: {
  runId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { data: run, isLoading } = useQuery<RunDetail>({
    queryKey: ["workflow-run", runId],
    queryFn: () => api.get(`/workflows/runs/${runId}`).then(r => r.data),
    refetchInterval: 5000,
  });
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [outputInput, setOutputInput] = useState<Record<string, string>>({});

  const completeMut = useMutation({
    mutationFn: ({ stepRunId, output }: { stepRunId: string; output?: string }) =>
      api.post(`/workflows/runs/${runId}/steps/${stepRunId}/complete`, { output }).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-run", runId] }),
  });
  const approveMut = useMutation({
    mutationFn: (stepRunId: string) =>
      api.post(`/workflows/runs/${runId}/steps/${stepRunId}/approve`, {}).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-run", runId] }),
  });
  const rejectMut = useMutation({
    mutationFn: ({ stepRunId, reason }: { stepRunId: string; reason: string }) =>
      api.post(`/workflows/runs/${runId}/steps/${stepRunId}/reject`, { reason }).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workflow-run", runId] }); setRejectId(null); setRejectReason(""); },
  });
  const cancelMut = useMutation({
    mutationFn: () => api.post(`/workflows/runs/${runId}/cancel`, {}).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["workflow-run", runId] }),
  });

  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 50,
      display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
    }}>
      <div style={{
        background: "var(--bg)", borderRadius: 12, width: "100%", maxWidth: 640,
        maxHeight: "90vh", display: "flex", flexDirection: "column",
        border: "1px solid var(--border)",
      }}>
        <div style={{ padding: "16px 20px", borderBottom: "1px solid var(--border)", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <span style={{ fontWeight: 600 }}>Detalhes da execução</span>
            {run && (
              <span style={{ marginLeft: 10 }}>
                <StatusBadge status={run.status} map={RUN_VARIANTS} labels={RUN_LABELS} />
              </span>
            )}
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            {run && ["running", "waiting_approval"].includes(run.status) && (
              <button onClick={() => cancelMut.mutate()} style={{ ...btnSecondary, fontSize: 12 }}>Cancelar execução</button>
            )}
            <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-muted)", fontSize: 20 }}>×</button>
          </div>
        </div>
        <div style={{ overflow: "auto", flex: 1, padding: 20 }}>
          {isLoading && <div style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}><Loader2 size={20} /></div>}
          {run && (
            <>
              <div style={{ display: "flex", gap: 24, marginBottom: 20, fontSize: 13, color: "var(--fg-muted)" }}>
                <span>Início: {fmt(run.started_at)}</span>
                {run.finished_at && <span>Fim: {fmt(run.finished_at)}</span>}
                <span>Passos: {run.done_steps}/{run.total_steps}</span>
              </div>
              {run.step_runs.map((sr, idx) => (
                <div key={sr.id} style={{
                  marginBottom: 10, padding: 12, borderRadius: 8,
                  border: `1px solid ${STEP_VARIANTS[sr.status] || "#e5e7eb"}44`,
                  background: "var(--bg-subtle)",
                }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                    <span style={{ fontWeight: 700, color: "var(--fg-muted)", minWidth: 20 }}>{idx + 1}</span>
                    <span style={{ fontWeight: 500, flex: 1 }}>{sr.step_name}</span>
                    <StatusBadge status={sr.status} map={STEP_VARIANTS} labels={STEP_LABELS} />
                  </div>
                  {sr.step_type !== "noop" && (
                    <div style={{ fontSize: 12, color: "var(--fg-muted)", marginLeft: 30, marginBottom: 6 }}>
                      Tipo: {sr.step_type}
                      {sr.approval_required && " · Requer aprovação"}
                    </div>
                  )}
                  {sr.rejection_reason && (
                    <div style={{ marginLeft: 30, fontSize: 12, color: "#dc2626", marginBottom: 6 }}>
                      Motivo de rejeição: {sr.rejection_reason}
                    </div>
                  )}
                  {sr.status === "running" && (
                    <div style={{ marginLeft: 30, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                      <input
                        placeholder="Output (opcional)"
                        value={outputInput[sr.id] || ""}
                        onChange={e => setOutputInput(o => ({ ...o, [sr.id]: e.target.value }))}
                        style={{ ...inputStyle, flex: 1, minWidth: 160 }}
                      />
                      <button
                        onClick={() => completeMut.mutate({ stepRunId: sr.id, output: outputInput[sr.id] })}
                        disabled={completeMut.isPending}
                        style={btnPrimary}
                      >Concluir passo</button>
                    </div>
                  )}
                  {sr.status === "waiting_approval" && (
                    <div style={{ marginLeft: 30, display: "flex", gap: 8 }}>
                      <button
                        onClick={() => approveMut.mutate(sr.id)}
                        disabled={approveMut.isPending}
                        style={{ ...btnPrimary, background: "#16a34a" }}
                      >Aprovar</button>
                      <button
                        onClick={() => setRejectId(sr.id)}
                        style={{ ...btnSecondary, color: "#dc2626", borderColor: "#dc2626" }}
                      >Rejeitar</button>
                    </div>
                  )}
                </div>
              ))}
            </>
          )}
        </div>
      </div>

      {rejectId && (
        <ConfirmModal
          title="Rejeitar passo"
          message={
            <div>
              <div style={{ marginBottom: 8 }}>Informe o motivo da rejeição:</div>
              <input
                autoFocus
                value={rejectReason}
                onChange={e => setRejectReason(e.target.value)}
                placeholder="Motivo (opcional)"
                style={inputStyle}
              />
            </div>
          }
          confirmLabel="Rejeitar"
          onConfirm={() => rejectMut.mutate({ stepRunId: rejectId, reason: rejectReason })}
          onCancel={() => { setRejectId(null); setRejectReason(""); }}
        />
      )}
    </div>
  );
}

// ── Clone Modal ───────────────────────────────────────────────────────────────

function CloneModal({ workflow, onClose }: { workflow: Workflow; onClose: () => void }) {
  const qc = useQueryClient();
  const [targetTenantId, setTargetTenantId] = useState("");
  const [newName, setNewName] = useState("");
  const cloneMut = useMutation({
    mutationFn: () => api.post(`/workflows/${workflow.id}/clone`, {
      target_tenant_id: targetTenantId,
      new_name: newName || undefined,
    }).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["workflows"] }); onClose(); },
  });

  return (
    <ConfirmModal
      title={`Clonar "${workflow.name}"`}
      message={
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div>
            <label style={{ fontSize: 13, fontWeight: 500 }}>Tenant de destino (UUID)</label>
            <input
              autoFocus
              value={targetTenantId}
              onChange={e => setTargetTenantId(e.target.value)}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              style={{ ...inputStyle, marginTop: 4 }}
            />
          </div>
          <div>
            <label style={{ fontSize: 13, fontWeight: 500 }}>Novo nome (opcional)</label>
            <input
              value={newName}
              onChange={e => setNewName(e.target.value)}
              placeholder={workflow.name}
              style={{ ...inputStyle, marginTop: 4 }}
            />
          </div>
          {cloneMut.isError && <div style={{ color: "#dc2626", fontSize: 13 }}>Erro ao clonar. Verifique o UUID do tenant.</div>}
        </div>
      }
      confirmLabel="Clonar"
      onConfirm={() => targetTenantId.trim() && cloneMut.mutate()}
      onCancel={onClose}
    />
  );
}

// ── Shared styles ─────────────────────────────────────────────────────────────

const inputStyle: React.CSSProperties = {
  width: "100%", padding: "7px 10px", borderRadius: 6, fontSize: 13,
  border: "1px solid var(--border)", background: "var(--bg)",
  color: "var(--fg)", boxSizing: "border-box",
};
const btnPrimary: React.CSSProperties = {
  padding: "6px 14px", borderRadius: 6, fontSize: 13, fontWeight: 600,
  background: "var(--accent)", color: "#fff", border: "none", cursor: "pointer",
};
const btnSecondary: React.CSSProperties = {
  padding: "6px 14px", borderRadius: 6, fontSize: 13, fontWeight: 500,
  background: "transparent", color: "var(--fg)", border: "1px solid var(--border)", cursor: "pointer",
};
const iconBtn: React.CSSProperties = {
  background: "none", border: "none", cursor: "pointer", color: "var(--fg-muted)",
  padding: 4, display: "flex", alignItems: "center",
};

// ── Main Page ─────────────────────────────────────────────────────────────────

export function WorkflowsPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"flows" | "runs">("flows");
  const [stepEditorId, setStepEditorId] = useState<string | null>(null);
  const [viewingRunId, setViewingRunId] = useState<string | null>(null);
  const [cloneWorkflow, setCloneWorkflow] = useState<Workflow | null>(null);
  const [confirmArchiveId, setConfirmArchiveId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");

  const { data: workflows = [], isLoading } = useQuery<Workflow[]>({
    queryKey: ["workflows", tenantId],
    queryFn: () => api.get("/workflows/").then(r => r.data),
  });

  const { data: stepEditorWf } = useQuery<WorkflowDetail>({
    queryKey: ["workflow", stepEditorId],
    queryFn: () => api.get(`/workflows/${stepEditorId}`).then(r => r.data),
    enabled: !!stepEditorId,
  });

  const { data: runs = [] } = useQuery<WorkflowRun[]>({
    queryKey: ["workflow-runs-all", tenantId],
    queryFn: () => api.get("/workflows/runs").then(r => r.data),
    enabled: tab === "runs",
    refetchInterval: 10000,
  });

  const createMut = useMutation({
    mutationFn: (data: { name: string; description: string }) =>
      api.post("/workflows/", data).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflows", tenantId] });
      setShowNew(false); setNewName(""); setNewDesc("");
    },
  });

  const startRunMut = useMutation({
    mutationFn: (workflowId: string) =>
      api.post(`/workflows/${workflowId}/runs`, {}).then(r => r.data),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["workflow-runs-all", tenantId] });
      setViewingRunId(data.id);
      setTab("runs");
    },
  });

  const archiveMut = useMutation({
    mutationFn: (id: string) => api.delete(`/workflows/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["workflows", tenantId] });
      setConfirmArchiveId(null);
    },
  });

  const active = workflows.filter(w => w.status === "active");
  const archived = workflows.filter(w => w.status === "archived");

  return (
    <div style={{ padding: "24px 20px", maxWidth: 960, margin: "0 auto" }}>
      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h1 style={{ fontSize: 22, fontWeight: 700, margin: 0 }}>Workflows</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--fg-muted)" }}>Fluxos sequenciais com aprovação por etapa</p>
        </div>
        {tab === "flows" && (
          <button onClick={() => setShowNew(true)} style={btnPrimary}>
            <Plus size={14} style={{ verticalAlign: "middle", marginRight: 4 }} />
            Novo fluxo
          </button>
        )}
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 0, borderBottom: "1px solid var(--border)", marginBottom: 24 }}>
        {(["flows", "runs"] as const).map(t => (
          <button key={t} onClick={() => setTab(t)} style={{
            padding: "8px 18px", border: "none", background: "none", cursor: "pointer",
            fontWeight: tab === t ? 600 : 400,
            color: tab === t ? "var(--accent)" : "var(--fg-muted)",
            borderBottom: tab === t ? "2px solid var(--accent)" : "2px solid transparent",
            marginBottom: -1, fontSize: 14,
          }}>
            {t === "flows" ? "Fluxos" : "Execuções"}
          </button>
        ))}
      </div>

      {/* New workflow form */}
      {tab === "flows" && showNew && (
        <div style={{ padding: 16, borderRadius: 10, border: "1px solid var(--border)", background: "var(--bg-subtle)", marginBottom: 20 }}>
          <div style={{ fontWeight: 600, marginBottom: 12 }}>Novo fluxo</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="Nome do fluxo *" style={inputStyle} />
            <input value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Descrição" style={inputStyle} />
            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => newName.trim() && createMut.mutate({ name: newName, description: newDesc })} style={btnPrimary} disabled={!newName.trim() || createMut.isPending}>
                {createMut.isPending ? "Criando…" : "Criar"}
              </button>
              <button onClick={() => { setShowNew(false); setNewName(""); setNewDesc(""); }} style={btnSecondary}>Cancelar</button>
            </div>
          </div>
        </div>
      )}

      {/* Flows tab */}
      {tab === "flows" && (
        <>
          {isLoading && <div style={{ textAlign: "center", padding: 40, color: "var(--fg-muted)" }}>Carregando…</div>}
          {!isLoading && active.length === 0 && !showNew && (
            <div style={{ textAlign: "center", padding: 48, color: "var(--fg-muted)" }}>
              Nenhum fluxo criado. Clique em <strong>Novo fluxo</strong> para começar.
            </div>
          )}
          {active.length > 0 && (
            <div style={{ borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden", marginBottom: 24 }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
                    {["Nome", "Passos", "Último run", "Ações"].map(h => (
                      <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {active.map(w => (
                    <tr key={w.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ fontWeight: 500 }}>{w.name}</div>
                        {w.description && <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{w.description}</div>}
                        {w.cloned_from && <div style={{ fontSize: 11, color: "#6b7280" }}>Clonado</div>}
                      </td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>{w.step_count}</td>
                      <td style={{ padding: "12px 14px" }}>
                        {w.last_run_status
                          ? <StatusBadge status={w.last_run_status} map={RUN_VARIANTS} labels={RUN_LABELS} />
                          : <span style={{ color: "var(--fg-muted)", fontSize: 13 }}>—</span>}
                      </td>
                      <td style={{ padding: "12px 14px" }}>
                        <div style={{ display: "flex", gap: 6 }}>
                          <button
                            onClick={() => startRunMut.mutate(w.id)}
                            disabled={w.step_count === 0 || startRunMut.isPending}
                            title={w.step_count === 0 ? "Adicione passos primeiro" : "Executar"}
                            style={{ ...btnPrimary, fontSize: 12, padding: "4px 10px" }}
                          >
                            <Play size={12} style={{ verticalAlign: "middle", marginRight: 3 }} />
                            Executar
                          </button>
                          <button onClick={() => setStepEditorId(w.id)} title="Passos" style={{ ...btnSecondary, fontSize: 12, padding: "4px 10px" }}>
                            <Settings size={12} style={{ verticalAlign: "middle", marginRight: 3 }} />
                            Passos
                          </button>
                          <button onClick={() => setCloneWorkflow(w)} title="Clonar para outro tenant" style={{ ...btnSecondary, fontSize: 12, padding: "4px 10px" }}>
                            <Copy size={12} style={{ verticalAlign: "middle" }} />
                          </button>
                          <button onClick={() => setConfirmArchiveId(w.id)} title="Arquivar" style={{ ...btnSecondary, fontSize: 12, padding: "4px 10px", color: "#dc2626" }}>
                            <Archive size={12} style={{ verticalAlign: "middle" }} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {archived.length > 0 && (
            <details style={{ marginTop: 8 }}>
              <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--fg-muted)", marginBottom: 10 }}>
                Arquivados ({archived.length})
              </summary>
              {archived.map(w => (
                <div key={w.id} style={{ padding: "8px 14px", borderRadius: 6, background: "var(--bg-subtle)", marginBottom: 6, fontSize: 13, color: "var(--fg-muted)" }}>
                  {w.name}
                </div>
              ))}
            </details>
          )}
        </>
      )}

      {/* Runs tab */}
      {tab === "runs" && (
        <>
          {runs.length === 0 && (
            <div style={{ textAlign: "center", padding: 48, color: "var(--fg-muted)" }}>
              Nenhuma execução registrada.
            </div>
          )}
          {runs.length > 0 && (
            <div style={{ borderRadius: 10, border: "1px solid var(--border)", overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ borderBottom: "1px solid var(--border)", background: "var(--bg-subtle)" }}>
                    {["Fluxo", "Status", "Progresso", "Início", ""].map(h => (
                      <th key={h} style={{ padding: "10px 14px", textAlign: "left", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {runs.map(r => (
                    <tr key={r.id} style={{ borderBottom: "1px solid var(--border)" }}>
                      <td style={{ padding: "12px 14px", fontWeight: 500, fontSize: 13 }}>{r.workflow_name}</td>
                      <td style={{ padding: "12px 14px" }}>
                        <StatusBadge status={r.status} map={RUN_VARIANTS} labels={RUN_LABELS} />
                      </td>
                      <td style={{ padding: "12px 14px", fontSize: 13 }}>
                        {r.done_steps}/{r.total_steps}
                        <div style={{
                          marginTop: 4, height: 4, borderRadius: 2,
                          background: "var(--border)", width: 80,
                        }}>
                          <div style={{
                            height: 4, borderRadius: 2,
                            background: RUN_VARIANTS[r.status] || "#6b7280",
                            width: r.total_steps > 0 ? `${(r.done_steps / r.total_steps) * 100}%` : "0%",
                            transition: "width 0.3s",
                          }} />
                        </div>
                      </td>
                      <td style={{ padding: "12px 14px", fontSize: 13, color: "var(--fg-muted)" }}>{fmt(r.started_at)}</td>
                      <td style={{ padding: "12px 14px" }}>
                        <button onClick={() => setViewingRunId(r.id)} style={{ ...btnSecondary, fontSize: 12, padding: "4px 10px" }}>
                          Ver detalhes
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Modals */}
      {stepEditorId && stepEditorWf && (
        <StepEditorModal
          workflowId={stepEditorId}
          steps={stepEditorWf.steps}
          onClose={() => setStepEditorId(null)}
        />
      )}

      {viewingRunId && (
        <RunDetailPanel
          runId={viewingRunId}
          tenantId={tenantId}
          onClose={() => setViewingRunId(null)}
        />
      )}

      {cloneWorkflow && (
        <CloneModal workflow={cloneWorkflow} onClose={() => setCloneWorkflow(null)} />
      )}

      {confirmArchiveId && (
        <ConfirmModal
          title="Arquivar fluxo"
          message="Arquivar este fluxo? Execuções em andamento não são afetadas."
          confirmLabel="Arquivar"
          onConfirm={() => archiveMut.mutate(confirmArchiveId)}
          onCancel={() => setConfirmArchiveId(null)}
        />
      )}
    </div>
  );
}
