import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ConfirmModal } from "@/components/ui/confirm-modal";

interface Template {
  template_id: string;
  name: string;
  report_type: string;
  delivery_email: string;
  enabled: boolean;
  created_at: string;
}

interface Schedule {
  report_schedule_id: string;
  template_id: string;
  template_name: string;
  report_type: string;
  delivery_email: string;
  interval_secs: number;
  last_sent_at?: string;
  next_send_at: string;
  enabled: boolean;
}

interface Delivery {
  delivery_id: string;
  report_type: string;
  recipient: string;
  outcome: string;
  error_detail?: string;
  period_start: string;
  period_end: string;
  row_count?: number;
  delivered_at?: string;
  created_at: string;
}

/** Renders one or more emails from a comma-separated delivery_email string. */
function EmailList({ value }: { value: string }) {
  const emails = value ? value.split(",").map(e => e.trim()).filter(Boolean) : [];
  if (emails.length === 0) {
    return <span className="text-[var(--text-muted)]">Não configurado</span>;
  }
  return (
    <>
      {emails.map(e => (
        <span
          key={e}
          className="inline-block text-[10px] bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 mr-1 mb-0.5 text-[var(--text)]">
          {e}
        </span>
      ))}
    </>
  );
}

const REPORT_TYPES = [
  { value: "alert_summary", label: "Alert Summary" },
  { value: "sla_summary", label: "SLA Breach Summary" },
  { value: "incident_summary", label: "Incident Summary" },
];

const OUTCOME_VARIANTS: Record<string, "muted" | "success" | "danger" | "warning"> = {
  pending: "warning",
  sent: "success",
  failed: "danger",
};

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return String(iso); }
}

function fmtInterval(s: number) {
  if (s < 7200) return `every ${Math.round(s / 3600)}h`;
  if (s < 86400) return `every ${Math.round(s / 3600)}h`;
  return `every ${Math.round(s / 86400)}d`;
}

function CreateTemplateForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [type, setType] = useState("alert_summary");
  const [email, setEmail] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/reports/templates", {
        name, report_type: type, delivery_email: email,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report-templates", tenantId] });
      onDone();
    },
    onError: (e: unknown) => setErr((e as { detail?: string })?.detail ?? "Failed."),
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("reports.newTemplateTitle")}</h3>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("reports.policyName")} *</label>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="e.g. Weekly alert digest"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">{t("reports.reportType")}</label>
          <select value={type} onChange={e => setType(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
            {REPORT_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">{t("reports.deliveryEmail")} *</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="ops@example.com"
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
        </div>
      </div>
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !name.trim() || !email.trim()}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}{t("escalation.create")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>{t("common.cancel")}</Button>
      </div>
    </Card>
  );
}

function AddScheduleForm({ tenantId, templates, onDone }: {
  tenantId: string; templates: Template[]; onDone: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [templateId, setTemplateId] = useState(templates[0]?.template_id ?? "");
  const [intervalHours, setIntervalHours] = useState("24");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/reports/schedules", {
        template_id: templateId,
        interval_secs: parseInt(intervalHours) * 3600,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report-schedules", tenantId] });
      onDone();
    },
    onError: (e: unknown) => setErr((e as { detail?: string })?.detail ?? "Failed."),
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("reports.scheduleReportTitle")}</h3>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("reports.colTemplate")}</label>
        <select value={templateId} onChange={e => setTemplateId(e.target.value)}
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
          {templates.filter(t => t.enabled).map(t => (
            <option key={t.template_id} value={t.template_id}>{t.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("reports.intervalHours")}</label>
        <input type="number" min="1" value={intervalHours}
          onChange={e => setIntervalHours(e.target.value)}
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !templateId}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}{t("automation.schedule")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>{t("common.cancel")}</Button>
      </div>
    </Card>
  );
}

function ScheduleSubscribersPanel({ scheduleId }: { scheduleId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newEmail, setNewEmail] = useState("");

  const subscribers = useQuery({
    queryKey: ["schedule-subscribers", scheduleId],
    queryFn: () => api.get<string[]>(`/api/v1/reports/schedules/${scheduleId}/subscribers`),
  });

  const addMut = useMutation({
    mutationFn: (email: string) =>
      api.post(`/api/v1/reports/schedules/${scheduleId}/subscribers`, { email }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule-subscribers", scheduleId] });
      setNewEmail("");
      toast("Assinante adicionado.", "success");
    },
    onError: (e: unknown) =>
      toast((e as { detail?: string })?.detail ?? "Erro ao adicionar assinante.", "error"),
  });

  const removeMut = useMutation({
    mutationFn: (email: string) =>
      api.delete(
        `/api/v1/reports/schedules/${scheduleId}/subscribers/${encodeURIComponent(email)}`
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["schedule-subscribers", scheduleId] });
      toast("Assinante removido.", "success");
    },
    onError: (e: unknown) =>
      toast((e as { detail?: string })?.detail ?? "Erro ao remover assinante.", "error"),
  });

  return (
    <div className="px-4 py-3 bg-[var(--surface-2)] border-t border-[var(--border)] space-y-2">
      <h4 className="text-xs font-medium text-[var(--text)]">Assinantes</h4>

      {subscribers.isLoading ? (
        <Spinner className="w-4 h-4" />
      ) : (
        <div className="flex flex-wrap gap-1.5 min-h-[1.5rem]">
          {(subscribers.data ?? []).length === 0 ? (
            <span className="text-[10px] text-[var(--text-muted)]">Nenhum assinante.</span>
          ) : (
            (subscribers.data ?? []).map(email => (
              <span
                key={email}
                className="flex items-center gap-1 text-[10px] bg-[var(--surface)] border border-[var(--border)] rounded px-1.5 py-0.5 text-[var(--text)]">
                {email}
                <button
                  onClick={() => removeMut.mutate(email)}
                  disabled={removeMut.isPending}
                  title="Remover assinante"
                  className="text-[var(--text-muted)] hover:text-[var(--red)] disabled:opacity-40 leading-none font-medium">
                  ×
                </button>
              </span>
            ))
          )}
        </div>
      )}

      <div className="flex gap-2 items-center pt-1">
        <input
          type="email"
          value={newEmail}
          onChange={e => setNewEmail(e.target.value)}
          onKeyDown={e => {
            if (e.key === "Enter" && newEmail.trim()) {
              addMut.mutate(newEmail.trim());
            }
          }}
          placeholder="cliente@empresa.com"
          className="flex-1 text-xs bg-[var(--surface)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
        />
        <Button
          size="sm"
          onClick={() => addMut.mutate(newEmail.trim())}
          disabled={addMut.isPending || !newEmail.trim()}>
          {addMut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}
          Adicionar
        </Button>
      </div>
    </div>
  );
}

export function ReportsPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"templates" | "schedules" | "history">("templates");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [creatingSchedule, setCreatingSchedule] = useState(false);
  const [confirmDeleteTemplateId, setConfirmDeleteTemplateId] = useState<string | null>(null);
  const [confirmDeleteScheduleId, setConfirmDeleteScheduleId] = useState<string | null>(null);
  const [expandedScheduleId, setExpandedScheduleId] = useState<string | null>(null);

  const templates = useQuery({
    queryKey: ["report-templates", tenantId],
    queryFn: () => api.get<Template[]>("/api/v1/reports/templates"),
  });
  const schedules = useQuery({
    queryKey: ["report-schedules", tenantId],
    queryFn: () => api.get<Schedule[]>("/api/v1/reports/schedules"),
    enabled: tab === "schedules",
  });
  const deliveries = useQuery({
    queryKey: ["report-deliveries", tenantId],
    queryFn: () => api.get<Delivery[]>("/api/v1/reports/deliveries"),
    enabled: tab === "history",
  });

  const deleteTemplateMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/reports/templates/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report-templates", tenantId] });
      setConfirmDeleteTemplateId(null);
      toast("Template excluído.", "success");
    },
    onError: () => { setConfirmDeleteTemplateId(null); toast("Erro ao excluir template.", "error"); },
  });

  const deleteScheduleMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/reports/schedules/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["report-schedules", tenantId] });
      setConfirmDeleteScheduleId(null);
      toast("Agendamento excluído.", "success");
    },
    onError: () => { setConfirmDeleteScheduleId(null); toast("Erro ao excluir agendamento.", "error"); },
  });

  const triggerTemplateMut = useMutation({
    mutationFn: (template_id: string) =>
      api.post(`/api/v1/reports/templates/${template_id}/trigger`, {}),
    onSuccess: () => toast("Relatório enviado.", "success"),
    onError: () => toast("Erro ao enviar relatório.", "error"),
  });

  const tabs = [
    { id: "templates" as const, label: t("reports.tabTemplates") },
    { id: "schedules" as const, label: t("reports.tabSchedules") },
    { id: "history" as const, label: t("reports.tabHistory") },
  ];

  const templateToDelete = (templates.data ?? []).find((t) => t.template_id === confirmDeleteTemplateId);
  const scheduleToDelete = (schedules.data ?? []).find((s) => s.report_schedule_id === confirmDeleteScheduleId);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">{t("reports.title")}</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {t("reports.subtitle")}
          </p>
        </div>
        {tab === "templates" && !creatingTemplate && (
          <Button size="sm" onClick={() => setCreatingTemplate(true)}>{t("reports.newTemplate")}</Button>
        )}
        {tab === "schedules" && !creatingSchedule && (
          <Button size="sm" onClick={() => setCreatingSchedule(true)}>{t("reports.scheduleReport")}</Button>
        )}
      </div>

      {creatingTemplate && tab === "templates" && (
        <CreateTemplateForm tenantId={tenantId} onDone={() => setCreatingTemplate(false)} />
      )}
      {creatingSchedule && tab === "schedules" && (
        <AddScheduleForm
          tenantId={tenantId}
          templates={templates.data ?? []}
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

      {tab === "templates" && (
        <Card className="p-0 overflow-hidden">
          {templates.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (templates.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">{t("reports.noTemplates")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("reports.colName")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colType")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colDeliveryEmail")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("common.status")}</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(templates.data ?? []).map(tpl => (
                  <tr key={tpl.template_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5 font-medium text-[var(--text)]">{tpl.name}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {REPORT_TYPES.find(r => r.value === tpl.report_type)?.label ?? tpl.report_type}
                    </td>
                    <td className="px-4 py-2.5"><EmailList value={tpl.delivery_email} /></td>
                    <td className="px-4 py-2.5">
                      <Badge variant={tpl.enabled ? "success" : "muted"}>
                        {tpl.enabled ? t("common.active") : t("common.disabled")}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        {tpl.enabled && (
                          <button
                            onClick={() => triggerTemplateMut.mutate(tpl.template_id)}
                            disabled={triggerTemplateMut.isPending}
                            className="text-[10px] text-[var(--brand)] hover:underline disabled:opacity-40">
                            Enviar agora
                          </button>
                        )}
                        <button
                          onClick={() => setConfirmDeleteTemplateId(tpl.template_id)}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline">
                          Excluir
                        </button>
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
            <p className="text-xs text-[var(--text-muted)] p-4">{t("reports.noSchedules")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("reports.colTemplate")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colDeliveryEmail")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colInterval")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colNextSend")}</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(schedules.data ?? []).map(s => (
                  <Fragment key={s.report_schedule_id}>
                    <tr className="hover:bg-[var(--surface-2)] transition-colors">
                      <td className="px-4 py-2.5 font-medium text-[var(--text)]">{s.template_name}</td>
                      <td className="px-4 py-2.5"><EmailList value={s.delivery_email} /></td>
                      <td className="px-4 py-2.5 text-[var(--text-muted)]">{fmtInterval(s.interval_secs)}</td>
                      <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                        {fmtTs(s.next_send_at)}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex items-center gap-3">
                          <button
                            onClick={() =>
                              setExpandedScheduleId(
                                expandedScheduleId === s.report_schedule_id
                                  ? null
                                  : s.report_schedule_id
                              )
                            }
                            className="text-[10px] text-[var(--brand)] hover:underline">
                            {expandedScheduleId === s.report_schedule_id
                              ? "Fechar"
                              : "Assinantes"}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteScheduleId(s.report_schedule_id)}
                            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline">
                            Excluir
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expandedScheduleId === s.report_schedule_id && (
                      <tr>
                        <td colSpan={5} className="p-0">
                          <ScheduleSubscribersPanel scheduleId={s.report_schedule_id} />
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

      {tab === "history" && (
        <Card className="p-0 overflow-hidden">
          {deliveries.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (deliveries.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">{t("reports.noDeliveries")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("reports.colOutcome")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colType")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colRecipient")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colPeriod")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colRows")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("reports.colSentAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(deliveries.data ?? []).map(d => (
                  <tr key={d.delivery_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5">
                      <Badge variant={OUTCOME_VARIANTS[d.outcome] ?? "muted"}>{d.outcome}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {REPORT_TYPES.find(r => r.value === d.report_type)?.label ?? d.report_type}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">{d.recipient}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap text-[10px]">
                      {fmtDate(d.period_start)} → {d.period_end ? fmtDate(d.period_end) : "—"}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {d.row_count ?? "—"}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtTs(d.delivered_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {/* Confirm delete template */}
      {confirmDeleteTemplateId && templateToDelete && (
        <ConfirmModal
          title="Excluir template"
          description={`Excluir permanentemente o template "${templateToDelete.name}"? Agendamentos associados também serão removidos.`}
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          destructive={true}
          isPending={deleteTemplateMut.isPending}
          onConfirm={() => deleteTemplateMut.mutate(confirmDeleteTemplateId)}
          onCancel={() => setConfirmDeleteTemplateId(null)}
        />
      )}

      {/* Confirm delete schedule */}
      {confirmDeleteScheduleId && scheduleToDelete && (
        <ConfirmModal
          title="Excluir agendamento"
          description={`Excluir permanentemente o agendamento do template "${scheduleToDelete.template_name}"?`}
          confirmLabel="Excluir"
          cancelLabel="Cancelar"
          destructive={true}
          isPending={deleteScheduleMut.isPending}
          onConfirm={() => deleteScheduleMut.mutate(confirmDeleteScheduleId)}
          onCancel={() => setConfirmDeleteScheduleId(null)}
        />
      )}
    </div>
  );
}
