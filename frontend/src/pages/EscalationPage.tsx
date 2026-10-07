import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useCanOperate } from "@/hooks/usePermission";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { useToast } from "@/components/ui/toast";

interface EscalationPolicy {
  policy_id: string;
  name: string;
  description?: string;
  created_at: string;
  linked_alert_policy_id?: string | null;
}

interface EscalationStep {
  step_number: number;
  delay_minutes: number;
  channel_class: string;
  destination_ref: string;
  payload_ref: string;
}

interface PolicyDetail {
  policy: EscalationPolicy;
  steps: EscalationStep[];
}

interface AlertPolicyVersion {
  policy_id: string;
  policy_version: number;
  is_effective: boolean;
  escalation_policy_id?: string | null;
}

const CHANNEL_LABELS: Record<string, string> = {
  "whatsapp_business@1": "WhatsApp",
  "email_smtp@1": "Email",
  "slack@1": "Slack",
};

const CHANNEL_OPTIONS = [
  { value: "email_smtp@1", label: "Email" },
  { value: "whatsapp_business@1", label: "WhatsApp" },
  { value: "slack@1", label: "Slack" },
];

function fmtDelay(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

function AddStepForm({
  policyId,
  nextStep,
  tenantId: _tenantId,
  onDone,
}: {
  policyId: string;
  nextStep: number;
  tenantId: string;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [stepNumber, setStepNumber] = useState(nextStep);
  const [delayMinutes, setDelayMinutes] = useState(15);
  const [channel, setChannel] = useState("email_smtp@1");
  const [destRef, setDestRef] = useState("");
  const [payloadRef, setPayloadRef] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/alerting/escalation-policies/${policyId}/steps`, {
        step_number: stepNumber,
        delay_minutes: delayMinutes,
        channel_class: channel,
        destination_ref: destRef.trim(),
        ...(payloadRef.trim() ? { payload_ref: payloadRef.trim() } : {}),
      }),
    onSuccess: () => {
      toast("Step adicionado com sucesso.", "success");
      qc.invalidateQueries({ queryKey: ["esc-policy", policyId] });
      onDone();
    },
    onError: (e: unknown) => {
      const msg = (e as { detail?: string })?.detail ?? "Falha ao adicionar step.";
      setErr(msg);
      toast(msg, "error");
    },
  });

  return (
    <div className="border border-[var(--border)] rounded-lg p-3 space-y-2 bg-[var(--surface-2)] mt-2">
      <p className="text-xs font-medium text-[var(--text)]">Add step</p>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <label className="text-[10px] text-[var(--text-muted)]">Step #</label>
          <input
            type="number"
            min={1}
            value={stepNumber}
            onChange={(e) => setStepNumber(Number(e.target.value))}
            className="w-full text-xs bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
          />
        </div>
        <div className="space-y-0.5">
          <label className="text-[10px] text-[var(--text-muted)]">Delay (minutes)</label>
          <input
            type="number"
            min={1}
            value={delayMinutes}
            onChange={(e) => setDelayMinutes(Number(e.target.value))}
            className="w-full text-xs bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
          />
        </div>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="space-y-0.5">
          <label className="text-[10px] text-[var(--text-muted)]">Channel</label>
          <select
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
            className="w-full text-xs bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
          >
            {CHANNEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-0.5">
          <label className="text-[10px] text-[var(--text-muted)]">
            {channel === "email_smtp@1" ? "Email address" : "Destination ref"}
          </label>
          <input
            type="text"
            value={destRef}
            onChange={(e) => setDestRef(e.target.value)}
            placeholder={channel === "email_smtp@1" ? "ops@example.com" : "+5511..."}
            className="w-full text-xs bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
          />
        </div>
      </div>
      <div className="space-y-0.5">
        <label className="text-[10px] text-[var(--text-muted)]">Payload ref (opcional)</label>
        <input
          type="text"
          value={payloadRef}
          onChange={(e) => setPayloadRef(e.target.value)}
          placeholder="e.g. tpl:critical-alert"
          className="w-full text-xs bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
        />
      </div>
      {err && <p className="text-[10px] text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !destRef.trim()}
        >
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}Save
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  );
}

function LinkAlertPolicyModal({
  escPolicyId,
  tenantId,
  onClose,
}: {
  escPolicyId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedPolicyId, setSelectedPolicyId] = useState("");

  const policiesQ = useQuery({
    queryKey: ["alert-policies"],
    queryFn: () => api.get<AlertPolicyVersion[]>("/api/v1/alerting/policies"),
  });

  const alertPolicies = policiesQ.data ?? [];
  const uniquePolicies = Array.from(new Map(alertPolicies.map((p) => [p.policy_id, p])).values());

  const linkMut = useMutation({
    mutationFn: () =>
      api.patch(`/api/v1/alerting/escalation-policies/${escPolicyId}`, {
        linked_alert_policy_id: selectedPolicyId,
      }),
    onSuccess: () => {
      toast("Política de alerta vinculada.", "success");
      qc.invalidateQueries({ queryKey: ["esc-policies", tenantId] });
      onClose();
    },
    onError: (e: unknown) => {
      toast((e as { detail?: string })?.detail ?? "Erro ao vincular política.", "error");
    },
  });

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="w-full max-w-sm rounded-xl border border-[var(--border)] bg-[var(--surface)] shadow-2xl p-6 space-y-4">
        <h3 className="text-sm font-semibold">Vincular a política de alerta</h3>

        {policiesQ.isLoading ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : uniquePolicies.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">Nenhuma política de alerta encontrada.</p>
        ) : (
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">Política de alerta</label>
            <select
              value={selectedPolicyId}
              onChange={(e) => setSelectedPolicyId(e.target.value)}
              className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
            >
              <option value="">Selecione…</option>
              {uniquePolicies.map((p) => (
                <option key={p.policy_id} value={p.policy_id}>{p.policy_id}</option>
              ))}
            </select>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            size="sm"
            onClick={() => linkMut.mutate()}
            disabled={!selectedPolicyId || linkMut.isPending}
          >
            {linkMut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}Vincular
          </Button>
          <Button variant="secondary" size="sm" onClick={onClose}>Cancelar</Button>
        </div>
      </div>
    </div>
  );
}

function PolicyDetailView({
  policyId,
  tenantId,
  onBack,
}: {
  policyId: string;
  tenantId: string;
  onBack: () => void;
}) {
  const canOperate = useCanOperate();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [addingStep, setAddingStep] = useState(false);
  const [deletingStepNo, setDeletingStepNo] = useState<number | null>(null);

  const q = useQuery({
    queryKey: ["esc-policy", policyId],
    queryFn: () =>
      api.get<PolicyDetail>(`/api/v1/alerting/escalation-policies/${policyId}`),
  });

  const deleteStepMut = useMutation({
    mutationFn: (stepNo: number) =>
      api.delete(
        `/api/v1/alerting/escalation-policies/${policyId}/steps/${stepNo}`
      ),
    onSuccess: () => {
      toast("Step removido.", "success");
      qc.invalidateQueries({ queryKey: ["esc-policy", policyId] });
      setDeletingStepNo(null);
    },
    onError: () => {
      toast("Erro ao remover step.", "error");
      setDeletingStepNo(null);
    },
  });

  if (q.isLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (q.isError) return <p className="text-xs text-[var(--red)] p-4">Failed to load policy.</p>;

  const { policy, steps } = q.data!;
  const nextStep = steps.length > 0
    ? Math.max(...steps.map((s) => s.step_number)) + 1
    : 1;

  return (
    <div className="space-y-4">
      {deletingStepNo !== null && (
        <ConfirmModal
          title="Remover step"
          description={`Remover o step #${deletingStepNo} desta política?`}
          confirmLabel="Remover"
          destructive
          isPending={deleteStepMut.isPending}
          onConfirm={() => deleteStepMut.mutate(deletingStepNo)}
          onCancel={() => setDeletingStepNo(null)}
        />
      )}

      <div className="flex items-center gap-2">
        <button
          onClick={onBack}
          className="text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
        >
          ← Policies
        </button>
        <span className="text-[var(--border)]">/</span>
        <span className="text-sm font-semibold">{policy.name}</span>
      </div>

      {policy.description && (
        <p className="text-xs text-[var(--text-muted)]">{policy.description}</p>
      )}

      <Card className="p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
            Escalation steps
          </h3>
          {canOperate && !addingStep && (
            <Button size="sm" onClick={() => setAddingStep(true)}>
              Add step
            </Button>
          )}
        </div>

        {steps.length === 0 && !addingStep && (
          <p className="text-xs text-[var(--text-muted)]">
            No steps defined. Add a step to enable escalation.
          </p>
        )}

        {steps.length > 0 && (
          <div className="space-y-2">
            {steps.map((s, i) => (
              <div
                key={s.step_number}
                className="flex items-center gap-3 p-2 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]"
              >
                <div className="w-7 h-7 rounded-full bg-[var(--brand)] bg-opacity-15 flex items-center justify-center flex-shrink-0">
                  <span className="text-[10px] font-semibold text-[var(--brand)]">
                    {s.step_number}
                  </span>
                </div>
                {i > 0 && (
                  <div className="text-[10px] text-[var(--text-muted)] flex-shrink-0">
                    +{fmtDelay(s.delay_minutes)}
                  </div>
                )}
                {i === 0 && (
                  <div className="text-[10px] text-[var(--text-muted)] flex-shrink-0">
                    after {fmtDelay(s.delay_minutes)}
                  </div>
                )}
                <Badge variant="info" className="flex-shrink-0">
                  {CHANNEL_LABELS[s.channel_class] ?? s.channel_class}
                </Badge>
                <span className="text-xs text-[var(--text)] font-mono truncate flex-1">
                  {s.destination_ref}
                </span>
                {s.payload_ref && (
                  <span className="text-[10px] text-[var(--text-muted)] font-mono truncate max-w-[100px]">
                    {s.payload_ref}
                  </span>
                )}
                {canOperate && (
                  <button
                    onClick={() => setDeletingStepNo(s.step_number)}
                    className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline flex-shrink-0"
                  >
                    remove
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {canOperate && addingStep && (
          <AddStepForm
            policyId={policyId}
            nextStep={nextStep}
            tenantId={tenantId}
            onDone={() => setAddingStep(false)}
          />
        )}
      </Card>
    </div>
  );
}

export function EscalationPage({ tenantId }: { tenantId: string }) {
  const canOperate = useCanOperate();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [selectedPolicyId, setSelectedPolicyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [linkingId, setLinkingId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["esc-policies", tenantId],
    queryFn: () =>
      api.get<EscalationPolicy[]>("/api/v1/alerting/escalation-policies"),
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.post<EscalationPolicy>("/api/v1/alerting/escalation-policies", {
        name: newName.trim(),
        description: newDesc.trim() || undefined,
      }),
    onSuccess: (p) => {
      toast("Política criada com sucesso.", "success");
      qc.invalidateQueries({ queryKey: ["esc-policies", tenantId] });
      setCreating(false);
      setNewName("");
      setNewDesc("");
      setSelectedPolicyId(p.policy_id);
    },
    onError: (e: unknown) => {
      const msg = (e as { detail?: string })?.detail ?? "Falha ao criar política.";
      setCreateErr(msg);
      toast(msg, "error");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/v1/alerting/escalation-policies/${id}`),
    onSuccess: () => {
      toast("Política excluída.", "success");
      qc.invalidateQueries({ queryKey: ["esc-policies", tenantId] });
      setDeletingId(null);
    },
    onError: () => {
      toast("Erro ao excluir política.", "error");
      setDeletingId(null);
    },
  });

  if (selectedPolicyId) {
    return (
      <PolicyDetailView
        policyId={selectedPolicyId}
        tenantId={tenantId}
        onBack={() => setSelectedPolicyId(null)}
      />
    );
  }

  const policies = q.data ?? [];
  const deletingPolicy = policies.find((p) => p.policy_id === deletingId);

  return (
    <div className="space-y-4">
      {deletingId && deletingPolicy && (
        <ConfirmModal
          title="Excluir política de escalação"
          description={`Excluir "${deletingPolicy.name}"? Esta ação não pode ser desfeita.`}
          confirmLabel="Excluir"
          destructive
          isPending={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate(deletingId)}
          onCancel={() => setDeletingId(null)}
        />
      )}

      {canOperate && linkingId && (
        <LinkAlertPolicyModal
          escPolicyId={linkingId}
          tenantId={tenantId}
          onClose={() => setLinkingId(null)}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Escalation Policies</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Define time-based escalation chains for unacknowledged alerts.
          </p>
        </div>
        {canOperate && !creating && (
          <Button size="sm" onClick={() => setCreating(true)}>
            New policy
          </Button>
        )}
      </div>

      {canOperate && creating && (
        <Card className="p-4 space-y-3">
          <h3 className="text-sm font-medium">New escalation policy</h3>
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">Name</label>
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="e.g. NOC on-call escalation"
              className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-[var(--text-muted)]">
              Description (optional)
            </label>
            <input
              type="text"
              value={newDesc}
              onChange={(e) => setNewDesc(e.target.value)}
              placeholder="Who this escalates to and why"
              className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
            />
          </div>
          {createErr && (
            <p className="text-xs text-[var(--red)]">{createErr}</p>
          )}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => { setCreateErr(null); createMut.mutate(); }}
              disabled={createMut.isPending || !newName.trim()}
            >
              {createMut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}
              Create
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => { setCreating(false); setNewName(""); }}
            >
              Cancel
            </Button>
          </div>
        </Card>
      )}

      <Card className="p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)] p-4">
            Failed to load policies.
          </p>
        ) : policies.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] p-4">
            No escalation policies. Create one to enable time-based alert escalation.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="px-4 py-2.5 font-medium">Policy</th>
                <th className="px-4 py-2.5 font-medium">Description</th>
                <th className="px-4 py-2.5 font-medium">Vinculado a</th>
                <th className="px-4 py-2.5 font-medium">Created</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {policies.map((p) => (
                <tr
                  key={p.policy_id}
                  onClick={() => setSelectedPolicyId(p.policy_id)}
                  className="hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2.5 font-medium text-[var(--text)]">
                    {p.name}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] max-w-[240px] truncate">
                    {p.description ?? "—"}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] font-mono text-[10px]">
                    {p.linked_alert_policy_id
                      ? p.linked_alert_policy_id.slice(0, 20) + "…"
                      : "—"}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                    {new Date(p.created_at).toLocaleDateString()}
                  </td>
                  <td
                    className="px-4 py-2.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    <div className="flex items-center gap-3">
                      {canOperate && (
                        <button
                          onClick={() => setLinkingId(p.policy_id)}
                          className="text-[10px] text-[var(--brand)] underline whitespace-nowrap"
                        >
                          vincular
                        </button>
                      )}
                      {canOperate && (
                        <button
                          onClick={() => setDeletingId(p.policy_id)}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline"
                        >
                          delete
                        </button>
                      )}
                    </div>
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
