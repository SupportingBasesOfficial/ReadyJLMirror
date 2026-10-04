import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

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

const STATE_COLORS: Record<string, "muted" | "info" | "warning" | "success" | "danger"> = {
  draft: "muted",
  review: "warning",
  approved: "info",
  scheduled: "info",
  implementing: "warning",
  complete: "success",
  cancelled: "muted",
};

const RISK_COLORS: Record<string, "muted" | "info" | "warning" | "danger"> = {
  low: "muted",
  medium: "info",
  high: "warning",
  critical: "danger",
};

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

function CreateRFCForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const qc = useQueryClient();
  const [title, setTitle] = useState("");
  const [desc, setDesc] = useState("");
  const [category, setCategory] = useState("normal");
  const [risk, setRisk] = useState("medium");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/itsm/changes", { title, description: desc, category, risk }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-changes", tenantId] });
      onDone();
    },
    onError: (e: unknown) => setErr((e as { detail?: string })?.detail ?? "Failed."),
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium">New change request</h3>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Title</label>
        <input value={title} onChange={e => setTitle(e.target.value)}
          placeholder="Brief description of the change"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Description</label>
        <textarea value={desc} onChange={e => setDesc(e.target.value)} rows={3}
          placeholder="Impact, rollback plan, testing steps…"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)] resize-none" />
      </div>
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Category</label>
          <select value={category} onChange={e => setCategory(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
            <option value="standard">Standard</option>
            <option value="normal">Normal</option>
            <option value="emergency">Emergency</option>
          </select>
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Risk</label>
          <select value={risk} onChange={e => setRisk(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
            <option value="low">Low</option>
            <option value="medium">Medium</option>
            <option value="high">High</option>
            <option value="critical">Critical</option>
          </select>
        </div>
      </div>
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !title.trim()}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}Create
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </Card>
  );
}

function RFCDetail({ rfc, tenantId, onBack }: {
  rfc: RFC; tenantId: string; onBack: () => void;
}) {
  const qc = useQueryClient();
  const [taskTitle, setTaskTitle] = useState("");
  const [approver, setApprover] = useState("");
  const [approvalDecision, setApprovalDecision] = useState("approved");

  const detail = useQuery({
    queryKey: ["itsm-rfc", rfc.rfc_id],
    queryFn: () => api.get<RFC>(`/api/v1/itsm/changes/${rfc.rfc_id}`),
  });

  const submitMut = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/itsm/changes/${rfc.rfc_id}`, { state: "review" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["itsm-rfc", rfc.rfc_id] }),
  });

  const addTaskMut = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/itsm/changes/${rfc.rfc_id}/tasks`, { title: taskTitle }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-rfc", rfc.rfc_id] });
      setTaskTitle("");
    },
  });

  const taskStateMut = useMutation({
    mutationFn: ({ task_id, state }: { task_id: string; state: string }) =>
      api.put(`/api/v1/itsm/changes/${rfc.rfc_id}/tasks/${task_id}`, { state }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["itsm-rfc", rfc.rfc_id] }),
  });

  const approvalMut = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/itsm/changes/${rfc.rfc_id}/approvals`, {
        approver_ref: approver,
        decision: approvalDecision,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-rfc", rfc.rfc_id] });
      qc.invalidateQueries({ queryKey: ["itsm-changes", tenantId] });
      setApprover("");
    },
  });

  const d = detail.data ?? rfc;
  const tasks = d.tasks ?? [];
  const approvals = d.approvals ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button onClick={onBack}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--brand)] underline">
          ← Changes
        </button>
        <Badge variant={STATE_COLORS[d.state] ?? "muted"}>{d.state}</Badge>
        <Badge variant={RISK_COLORS[d.risk] ?? "muted"}>risk: {d.risk}</Badge>
        <span className="text-xs text-[var(--text-muted)] capitalize">{d.category}</span>
      </div>

      <Card className="p-4 space-y-2">
        <h2 className="text-sm font-semibold">{d.title}</h2>
        {d.description && (
          <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap">{d.description}</p>
        )}
        <div className="flex gap-4 text-xs text-[var(--text-muted)] pt-1">
          <span>Created by {d.created_by}</span>
          {d.planned_start && <span>Start: {fmtTs(d.planned_start)}</span>}
          {d.planned_end && <span>End: {fmtTs(d.planned_end)}</span>}
          {d.incident_id && <span>Incident: {d.incident_id}</span>}
        </div>
        {d.state === "draft" && (
          <div className="pt-2">
            <Button size="sm" onClick={() => submitMut.mutate()} disabled={submitMut.isPending}>
              {submitMut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}
              Submit for review
            </Button>
          </div>
        )}
      </Card>

      {/* Tasks */}
      <div className="space-y-2">
        <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
          Tasks
        </h3>
        {tasks.length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">No tasks yet.</p>
        )}
        {tasks.map(t => (
          <Card key={t.task_id} className="p-3 flex items-center justify-between">
            <div>
              <span className="text-xs font-medium">{t.title}</span>
              {t.assignee_ref && (
                <span className="text-[10px] text-[var(--text-muted)] ml-2">{t.assignee_ref}</span>
              )}
            </div>
            <select value={t.state}
              onChange={e => taskStateMut.mutate({ task_id: t.task_id, state: e.target.value })}
              className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--text)] focus:outline-none">
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="done">Done</option>
              <option value="skipped">Skipped</option>
            </select>
          </Card>
        ))}
        <div className="flex gap-2">
          <input value={taskTitle} onChange={e => setTaskTitle(e.target.value)}
            placeholder="Add task…"
            className="flex-1 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
          <Button size="sm" onClick={() => addTaskMut.mutate()}
            disabled={addTaskMut.isPending || !taskTitle.trim()}>Add</Button>
        </div>
      </div>

      {/* Approvals */}
      {(d.state === "review" || approvals.length > 0) && (
        <div className="space-y-2">
          <h3 className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Approvals
          </h3>
          {approvals.map(a => (
            <Card key={a.approval_id} className="p-3 flex items-center justify-between">
              <div>
                <span className="text-xs font-medium">{a.approver_ref}</span>
                {a.notes && (
                  <span className="text-[10px] text-[var(--text-muted)] ml-2">{a.notes}</span>
                )}
              </div>
              <Badge variant={a.decision === "approved" ? "success" : a.decision === "rejected" ? "danger" : "muted"}>
                {a.decision}
              </Badge>
            </Card>
          ))}
          {d.state === "review" && (
            <div className="flex gap-2 items-center">
              <input value={approver} onChange={e => setApprover(e.target.value)}
                placeholder="Approver name or ID"
                className="flex-1 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
              <select value={approvalDecision} onChange={e => setApprovalDecision(e.target.value)}
                className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none">
                <option value="approved">Approve</option>
                <option value="rejected">Reject</option>
              </select>
              <Button size="sm" onClick={() => approvalMut.mutate()}
                disabled={approvalMut.isPending || !approver.trim()}>
                {approvalMut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}Record
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function ITSMPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<RFC | null>(null);

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

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Change Management</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            RFCs, approvals, and change tasks.
          </p>
        </div>
        {!creating && (
          <Button size="sm" onClick={() => setCreating(true)}>New RFC</Button>
        )}
      </div>

      {creating && (
        <CreateRFCForm tenantId={tenantId} onDone={() => setCreating(false)} />
      )}

      <Card className="p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)] p-4">Failed to load changes.</p>
        ) : rfcs.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] p-4">
            No change requests yet. Create an RFC to begin.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Title</th>
                <th className="px-4 py-2.5 font-medium">Category</th>
                <th className="px-4 py-2.5 font-medium">Risk</th>
                <th className="px-4 py-2.5 font-medium">Planned</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {rfcs.map(r => (
                <tr key={r.rfc_id}
                  onClick={() => setSelected(r)}
                  className="hover:bg-[var(--surface-2)] cursor-pointer transition-colors">
                  <td className="px-4 py-2.5">
                    <Badge variant={STATE_COLORS[r.state] ?? "muted"}>{r.state}</Badge>
                  </td>
                  <td className="px-4 py-2.5 font-medium text-[var(--text)]">{r.title}</td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] capitalize">{r.category}</td>
                  <td className="px-4 py-2.5">
                    <Badge variant={RISK_COLORS[r.risk] ?? "muted"}>{r.risk}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                    {fmtTs(r.planned_start)}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                    {fmtTs(r.created_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
