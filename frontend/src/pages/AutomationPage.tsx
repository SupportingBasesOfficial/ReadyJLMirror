import { useState, Fragment } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useCanOperate } from "@/hooks/usePermission";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ConfirmModal } from "@/components/ui/confirm-modal";

interface Script {
  script_id: string;
  name: string;
  description: string;
  script_type: string;
  enabled: boolean;
  approval_required: boolean;
  approval_status: string;
  created_at: string;
}

interface Schedule {
  schedule_id: string;
  script_id: string;
  script_name: string;
  interval_secs: number;
  last_run_at?: string;
  next_run_at: string;
  enabled: boolean;
}

interface Run {
  run_id: string;
  script_id: string;
  trigger_type: string;
  outcome: string;
  http_status?: number;
  error_detail?: string;
  output?: string;
  log?: string;
  started_at: string;
  finished_at?: string;
}

const OUTCOME_VARIANTS: Record<string, "muted" | "success" | "danger" | "warning"> = {
  pending: "warning",
  success: "success",
  failed: "danger",
  skipped: "muted",
};

const APPROVAL_VARIANTS: Record<string, "muted" | "success" | "danger" | "warning"> = {
  draft: "muted",
  pending_approval: "warning",
  approved: "success",
  rejected: "danger",
};

const APPROVAL_LABELS: Record<string, string> = {
  draft: "Rascunho",
  pending_approval: "Aguardando",
  approved: "Aprovado",
  rejected: "Rejeitado",
};

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtSecs(s: number) {
  if (s < 3600) return `every ${Math.round(s / 60)}m`;
  if (s < 86400) return `every ${Math.round(s / 3600)}h`;
  return `every ${Math.round(s / 86400)}d`;
}

function CreateScriptForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [desc, setDesc] = useState("");
  const [type, setType] = useState("noop");
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const config = type === "webhook" ? { url, method: "POST" } : {};

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/automation/scripts", {
        name, description: desc, script_type: type, config,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-scripts", tenantId] });
      onDone();
    },
    onError: (e: unknown) => setErr((e as { detail?: string })?.detail ?? "Failed."),
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("automation.newScriptTitle")}</h3>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("automation.colName")} *</label>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="e.g. Alert webhook"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("automation.typeField")}</label>
        <select value={type} onChange={e => setType(e.target.value)}
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
          <option value="noop">No-op (test)</option>
          <option value="webhook">Webhook (HTTP POST)</option>
        </select>
      </div>
      {type === "webhook" && (
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">{t("automation.webhookUrl")}</label>
          <input value={url} onChange={e => setUrl(e.target.value)}
            placeholder="https://hooks.example.com/..."
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
        </div>
      )}
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("automation.descField")}</label>
        <input value={desc} onChange={e => setDesc(e.target.value)}
          placeholder="Optional description"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !name.trim() || (type === "webhook" && !url.trim())}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}{t("escalation.create")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>{t("common.cancel")}</Button>
      </div>
    </Card>
  );
}

function AddScheduleForm({ tenantId, scripts, onDone }: {
  tenantId: string; scripts: Script[]; onDone: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [scriptId, setScriptId] = useState(scripts[0]?.script_id ?? "");
  const [intervalMins, setIntervalMins] = useState("60");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/automation/schedules", {
        script_id: scriptId,
        interval_secs: parseInt(intervalMins) * 60,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-schedules", tenantId] });
      onDone();
    },
    onError: (e: unknown) => setErr((e as { detail?: string })?.detail ?? "Failed."),
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("automation.newScheduleTitle")}</h3>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("automation.scriptField")}</label>
        <select value={scriptId} onChange={e => setScriptId(e.target.value)}
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
          {scripts.filter(s => s.enabled).map(s => (
            <option key={s.script_id} value={s.script_id}>{s.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("automation.intervalMins")}</label>
        <input type="number" min="1" value={intervalMins}
          onChange={e => setIntervalMins(e.target.value)}
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !scriptId}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}{t("automation.schedule")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>{t("common.cancel")}</Button>
      </div>
    </Card>
  );
}

export function AutomationPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const canOperate = useCanOperate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"scripts" | "schedules" | "runs">("scripts");
  const [creatingScript, setCreatingScript] = useState(false);
  const [creatingSchedule, setCreatingSchedule] = useState(false);
  const [confirmDeleteScriptId, setConfirmDeleteScriptId] = useState<string | null>(null);
  const [confirmDeleteScheduleId, setConfirmDeleteScheduleId] = useState<string | null>(null);
  const [expandedRunId, setExpandedRunId] = useState<string | null>(null);
  const [confirmRejectId, setConfirmRejectId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");

  const scripts = useQuery({
    queryKey: ["automation-scripts", tenantId],
    queryFn: () => api.get<Script[]>("/api/v1/automation/scripts"),
  });
  const schedules = useQuery({
    queryKey: ["automation-schedules", tenantId],
    queryFn: () => api.get<Schedule[]>("/api/v1/automation/schedules"),
    enabled: tab === "schedules",
  });
  const runs = useQuery({
    queryKey: ["automation-runs", tenantId],
    queryFn: () => api.get<Run[]>("/api/v1/automation/runs"),
    enabled: tab === "runs",
    refetchInterval: 15_000,
  });

  const triggerMut = useMutation({
    mutationFn: (script_id: string) =>
      api.post(`/api/v1/automation/scripts/${script_id}/trigger`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-runs", tenantId] });
      toast("Execução iniciada.", "success");
    },
    onError: () => toast("Erro ao iniciar execução.", "error"),
  });

  const deleteScriptMut = useMutation({
    mutationFn: (script_id: string) =>
      api.delete(`/api/v1/automation/scripts/${script_id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-scripts", tenantId] });
      setConfirmDeleteScriptId(null);
      toast("Script excluído.", "success");
    },
    onError: () => { setConfirmDeleteScriptId(null); toast("Erro ao excluir script.", "error"); },
  });

  const deleteScheduleMut = useMutation({
    mutationFn: (schedule_id: string) =>
      api.delete(`/api/v1/automation/schedules/${schedule_id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-schedules", tenantId] });
      setConfirmDeleteScheduleId(null);
      toast("Agendamento excluído.", "success");
    },
    onError: () => { setConfirmDeleteScheduleId(null); toast("Erro ao excluir agendamento.", "error"); },
  });

  const cancelRunMut = useMutation({
    mutationFn: (run_id: string) =>
      api.post(`/api/v1/automation/runs/${run_id}/cancel`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-runs", tenantId] });
      toast("Run cancelado.", "success");
    },
    onError: () => { toast("Não foi possível cancelar — run já em execução ou concluído.", "error"); },
  });

  const submitMut = useMutation({
    mutationFn: (script_id: string) =>
      api.post(`/api/v1/automation/scripts/${script_id}/submit`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-scripts", tenantId] });
      toast("Script submetido para aprovação.", "success");
    },
    onError: () => toast("Erro ao submeter.", "error"),
  });

  const approveMut = useMutation({
    mutationFn: (script_id: string) =>
      api.post(`/api/v1/automation/scripts/${script_id}/approve`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-scripts", tenantId] });
      toast("Script aprovado.", "success");
    },
    onError: () => toast("Erro ao aprovar — requer tenant:admin.", "error"),
  });

  const rejectMut = useMutation({
    mutationFn: ({ script_id, reason }: { script_id: string; reason: string }) =>
      api.post(`/api/v1/automation/scripts/${script_id}/reject`, { reason }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["automation-scripts", tenantId] });
      setConfirmRejectId(null);
      setRejectReason("");
      toast("Script rejeitado.", "success");
    },
    onError: () => toast("Erro ao rejeitar — requer tenant:admin.", "error"),
  });

  const tabs = [
    { id: "scripts" as const, label: t("automation.tabScripts") },
    { id: "schedules" as const, label: t("automation.tabSchedules") },
    { id: "runs" as const, label: t("automation.tabRuns") },
  ];

  const scriptToDelete = (scripts.data ?? []).find((s) => s.script_id === confirmDeleteScriptId);
  const scheduleToDelete = (schedules.data ?? []).find((s) => s.schedule_id === confirmDeleteScheduleId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">{t("automation.title")}</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {t("automation.subtitle")}
          </p>
        </div>
        {canOperate && tab === "scripts" && !creatingScript && (
          <Button size="sm" onClick={() => setCreatingScript(true)}>{t("automation.newScript")}</Button>
        )}
        {canOperate && tab === "schedules" && !creatingSchedule && (
          <Button size="sm" onClick={() => setCreatingSchedule(true)}>{t("automation.addSchedule")}</Button>
        )}
      </div>

      {canOperate && creatingScript && tab === "scripts" && (
        <CreateScriptForm tenantId={tenantId} onDone={() => setCreatingScript(false)} />
      )}
      {canOperate && creatingSchedule && tab === "schedules" && (
        <AddScheduleForm
          tenantId={tenantId}
          scripts={scripts.data ?? []}
          onDone={() => setCreatingSchedule(false)}
        />
      )}

      <div className="flex gap-1 border-b border-[var(--border)]">
        {tabs.map(tabItem => (
          <button key={tabItem.id} onClick={() => setTab(tabItem.id)}
            className={[
              "px-3 py-1.5 text-xs font-medium rounded-t transition-colors",
              tab === tabItem.id
                ? "bg-[var(--surface-2)] text-[var(--brand)] border-b-2 border-[var(--brand)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}>
            {tabItem.label}
          </button>
        ))}
      </div>

      {tab === "scripts" && (
        <Card className="p-0 overflow-hidden">
          {scripts.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (scripts.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">{t("automation.noScripts")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("automation.colName")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colType")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colStatus")}</th>
                  <th className="px-4 py-2.5 font-medium">Aprovação</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(scripts.data ?? []).map(s => (
                  <tr key={s.script_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5 font-medium text-[var(--text)]">
                      {s.name}
                      {s.description && (
                        <span className="ml-2 text-[10px] text-[var(--text-muted)] font-normal">
                          {s.description}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      <Badge variant="muted">{s.script_type}</Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={s.enabled ? "success" : "muted"}>
                        {s.enabled ? t("common.enabled") : t("common.disabled")}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {s.approval_required ? (
                        <Badge variant={APPROVAL_VARIANTS[s.approval_status] ?? "muted"}>
                          {APPROVAL_LABELS[s.approval_status] ?? s.approval_status}
                        </Badge>
                      ) : (
                        <span className="text-[var(--text-muted)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-2">
                        {canOperate && s.enabled && (!s.approval_required || s.approval_status === "approved") && (
                          <Button size="sm" variant="secondary"
                            onClick={() => triggerMut.mutate(s.script_id)}
                            disabled={triggerMut.isPending}>
                            {t("automation.runNow")}
                          </Button>
                        )}
                        {s.approval_required && canOperate && (s.approval_status === "draft" || s.approval_status === "rejected") && (
                          <button
                            onClick={() => submitMut.mutate(s.script_id)}
                            disabled={submitMut.isPending}
                            className="text-[10px] text-[var(--brand)] hover:underline disabled:opacity-50">
                            Submeter
                          </button>
                        )}
                        {s.approval_required && canOperate && s.approval_status === "pending_approval" && (
                          <>
                            <button
                              onClick={() => approveMut.mutate(s.script_id)}
                              disabled={approveMut.isPending}
                              className="text-[10px] text-[var(--green)] hover:underline disabled:opacity-50">
                              Aprovar
                            </button>
                            <button
                              onClick={() => { setConfirmRejectId(s.script_id); setRejectReason(""); }}
                              className="text-[10px] text-[var(--red)] hover:underline">
                              Rejeitar
                            </button>
                          </>
                        )}
                        {canOperate && (
                          <button
                            onClick={() => setConfirmDeleteScriptId(s.script_id)}
                            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline">
                            Excluir
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
      )}

      {tab === "schedules" && (
        <Card className="p-0 overflow-hidden">
          {schedules.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (schedules.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">{t("automation.noSchedules")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("automation.colScript")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colInterval")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colNextRun")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colLastRun")}</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(schedules.data ?? []).map(s => (
                  <tr key={s.schedule_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5 font-medium text-[var(--text)]">{s.script_name}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">{fmtSecs(s.interval_secs)}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtTs(s.next_run_at)}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtTs(s.last_run_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      {canOperate && (
                        <button
                          onClick={() => setConfirmDeleteScheduleId(s.schedule_id)}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline">
                          Excluir
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "runs" && (
        <Card className="p-0 overflow-hidden">
          {runs.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (runs.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">{t("automation.noRuns")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("automation.colOutcome")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colTrigger")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colHTTP")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colStarted")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("automation.colErrorLog")}</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(runs.data ?? []).map(r => (
                  <Fragment key={r.run_id}>
                    <tr className="hover:bg-[var(--surface-2)] transition-colors">
                      <td className="px-4 py-2.5">
                        <Badge variant={OUTCOME_VARIANTS[r.outcome] ?? "muted"}>
                          {r.outcome}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-muted)]">{r.trigger_type}</td>
                      <td className="px-4 py-2.5 text-[var(--text-muted)]">
                        {r.http_status ?? "—"}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                        {fmtTs(r.started_at)}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.error_detail && (
                          <span className="text-[var(--red)] font-mono text-[10px] mr-2">
                            {r.error_detail}
                          </span>
                        )}
                        <button
                          onClick={() => setExpandedRunId(expandedRunId === r.run_id ? null : r.run_id)}
                          className="text-[10px] text-[var(--brand)] underline whitespace-nowrap">
                          {expandedRunId === r.run_id ? t("automation.hideLog") : t("automation.showLog")}
                        </button>
                      </td>
                      <td className="px-4 py-2.5">
                        {r.outcome === "pending" && canOperate && (
                          <button
                            onClick={() => cancelRunMut.mutate(r.run_id)}
                            disabled={cancelRunMut.isPending}
                            className="text-[10px] text-[var(--red)] underline whitespace-nowrap disabled:opacity-50">
                            Cancelar
                          </button>
                        )}
                      </td>
                    </tr>
                    {expandedRunId === r.run_id && (
                      <tr>
                        <td colSpan={6} className="px-4 py-3 bg-[var(--surface-2)]">
                          <pre style={{ fontSize: "0.7rem", overflowX: "auto", whiteSpace: "pre-wrap", wordBreak: "break-all", margin: 0, color: "var(--text-muted)", maxHeight: 240 }}>
                            {r.output ?? r.log ?? JSON.stringify(r, null, 2)}
                          </pre>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* Delete script confirmation */}
      {confirmDeleteScriptId && scriptToDelete && (
        <ConfirmModal
          title="Excluir script"
          description={`Excluir permanentemente o script "${scriptToDelete.name}"? Esta ação não pode ser desfeita.`}
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          destructive={true}
          isPending={deleteScriptMut.isPending}
          onConfirm={() => deleteScriptMut.mutate(confirmDeleteScriptId)}
          onCancel={() => setConfirmDeleteScriptId(null)}
        />
      )}

      {/* Delete schedule confirmation */}
      {confirmDeleteScheduleId && scheduleToDelete && (
        <ConfirmModal
          title="Excluir agendamento"
          description={`Excluir permanentemente o agendamento do script "${scheduleToDelete.script_name}"? Esta ação não pode ser desfeita.`}
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          destructive={true}
          isPending={deleteScheduleMut.isPending}
          onConfirm={() => deleteScheduleMut.mutate(confirmDeleteScheduleId)}
          onCancel={() => setConfirmDeleteScheduleId(null)}
        />
      )}

      {/* Reject script confirmation */}
      {confirmRejectId && (
        <ConfirmModal
          title="Rejeitar script"
          description="Confirmar rejeição do script? O status voltará para Rejeitado e o operador precisará resubmeter."
          confirmLabel="Rejeitar"
          cancelLabel="Cancelar"
          destructive={true}
          isPending={rejectMut.isPending}
          onConfirm={() => rejectMut.mutate({ script_id: confirmRejectId, reason: rejectReason })}
          onCancel={() => { setConfirmRejectId(null); setRejectReason(""); }}
        />
      )}
    </div>
  );
}
