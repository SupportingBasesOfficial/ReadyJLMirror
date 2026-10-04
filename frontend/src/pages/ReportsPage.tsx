import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

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

function fmtInterval(s: number) {
  if (s < 7200) return `every ${Math.round(s / 3600)}h`;
  if (s < 86400) return `every ${Math.round(s / 3600)}h`;
  return `every ${Math.round(s / 86400)}d`;
}

function CreateTemplateForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
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
      <h3 className="text-sm font-medium">New report template</h3>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Name</label>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="e.g. Weekly alert digest"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Report type</label>
          <select value={type} onChange={e => setType(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
            {REPORT_TYPES.map(t => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Delivery email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="ops@example.com"
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
        </div>
      </div>
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !name.trim() || !email.trim()}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}Create
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </Card>
  );
}

function AddScheduleForm({ tenantId, templates, onDone }: {
  tenantId: string; templates: Template[]; onDone: () => void;
}) {
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
      <h3 className="text-sm font-medium">Schedule report</h3>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Template</label>
        <select value={templateId} onChange={e => setTemplateId(e.target.value)}
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]">
          {templates.filter(t => t.enabled).map(t => (
            <option key={t.template_id} value={t.template_id}>{t.name}</option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Interval (hours, min 1)</label>
        <input type="number" min="1" value={intervalHours}
          onChange={e => setIntervalHours(e.target.value)}
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !templateId}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}Schedule
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>Cancel</Button>
      </div>
    </Card>
  );
}

export function ReportsPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"templates" | "schedules" | "history">("templates");
  const [creatingTemplate, setCreatingTemplate] = useState(false);
  const [creatingSchedule, setCreatingSchedule] = useState(false);

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

  const disableTemplateMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/reports/templates/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["report-templates", tenantId] }),
  });

  const disableScheduleMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/reports/schedules/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["report-schedules", tenantId] }),
  });

  const tabs = [
    { id: "templates" as const, label: "Templates" },
    { id: "schedules" as const, label: "Schedules" },
    { id: "history" as const, label: "Delivery history" },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Scheduled Reports</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Email reports on alerts, SLA breaches, and incidents.
          </p>
        </div>
        {tab === "templates" && !creatingTemplate && (
          <Button size="sm" onClick={() => setCreatingTemplate(true)}>New template</Button>
        )}
        {tab === "schedules" && !creatingSchedule && (
          <Button size="sm" onClick={() => setCreatingSchedule(true)}>Schedule report</Button>
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
        {tabs.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)}
            className={[
              "px-3 py-1.5 text-xs font-medium rounded-t transition-colors",
              tab === t.id
                ? "bg-[var(--surface-2)] text-[var(--brand)] border-b-2 border-[var(--brand)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "templates" && (
        <Card className="p-0 overflow-hidden">
          {templates.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (templates.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">No report templates.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">Name</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Recipient</th>
                  <th className="px-4 py-2.5 font-medium">Status</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(templates.data ?? []).map(t => (
                  <tr key={t.template_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5 font-medium text-[var(--text)]">{t.name}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {REPORT_TYPES.find(r => r.value === t.report_type)?.label ?? t.report_type}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">{t.delivery_email}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant={t.enabled ? "success" : "muted"}>
                        {t.enabled ? "active" : "disabled"}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {t.enabled && (
                        <button onClick={() => disableTemplateMut.mutate(t.template_id)}
                          disabled={disableTemplateMut.isPending}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline">
                          disable
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

      {tab === "schedules" && (
        <Card className="p-0 overflow-hidden">
          {schedules.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (schedules.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">No schedules.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">Template</th>
                  <th className="px-4 py-2.5 font-medium">Recipient</th>
                  <th className="px-4 py-2.5 font-medium">Interval</th>
                  <th className="px-4 py-2.5 font-medium">Next send</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(schedules.data ?? []).map(s => (
                  <tr key={s.report_schedule_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5 font-medium text-[var(--text)]">{s.template_name}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">{s.delivery_email}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">{fmtInterval(s.interval_secs)}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtTs(s.next_send_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      {s.enabled && (
                        <button onClick={() => disableScheduleMut.mutate(s.report_schedule_id)}
                          disabled={disableScheduleMut.isPending}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline">
                          disable
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

      {tab === "history" && (
        <Card className="p-0 overflow-hidden">
          {deliveries.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (deliveries.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">No deliveries yet.</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">Outcome</th>
                  <th className="px-4 py-2.5 font-medium">Type</th>
                  <th className="px-4 py-2.5 font-medium">Recipient</th>
                  <th className="px-4 py-2.5 font-medium">Period</th>
                  <th className="px-4 py-2.5 font-medium">Rows</th>
                  <th className="px-4 py-2.5 font-medium">Sent at</th>
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
                      {new Date(d.period_start).toLocaleDateString()} →
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
    </div>
  );
}
