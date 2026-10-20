import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { useCanOperate } from "@/hooks/usePermission";
import { ChevronLeft, MessageSquare, User, ArrowRight, Clock } from "lucide-react";

interface Incident {
  incident_id: string;
  alert_id: string;
  title: string;
  lifecycle_state: "open" | "in_progress" | "resolved" | "closed";
  severity_class?: string;
  alert_state?: string;
  created_at: string;
  updated_at: string;
}

interface IncidentDetail extends Incident {
  description?: string;
  alert_summary: { alert_id: string; lifecycle_state: string; opened_at: string; resolved_at?: string };
  transitions: { incident_transition_id: string; from_state: string; to_state: string; actor_principal_id: string; occurred_at: string }[];
  assignments: { incident_assignment_id: string; assignee_principal_id: string; assigned_by_principal_id: string; effective_from: string; effective_until?: string }[];
  comments: { incident_comment_id: string; body: string; actor_principal_id: string; created_at: string }[];
  provider_sync: { sync_state?: string; provider_ticket_ref?: string; linked_at?: string };
}

interface TimeEntry {
  entry_id: string;
  incident_id: string;
  minutes: number;
  description?: string;
  logged_by_principal_id: string;
  logged_at: string;
}

const NEXT_STATES: Record<string, string[]> = {
  open: ["in_progress", "resolved"],
  in_progress: ["resolved"],
  resolved: ["closed"],
  closed: [],
};

function stateVariant(s: string): "danger" | "warning" | "info" | "muted" | "success" {
  if (s === "open") return "danger";
  if (s === "in_progress") return "warning";
  if (s === "resolved") return "info";
  return "muted";
}

function sevVariant(cls?: string): "danger" | "warning" | "info" | "muted" {
  if (cls === "critical") return "danger";
  if (cls === "degraded" || cls === "warning") return "warning";
  if (cls === "informational") return "info";
  return "muted";
}

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("pt-BR"); } catch { return iso; }
}

function StateFilters({ active, onChange }: { active: string; onChange: (v: string) => void }) {
  const { t } = useTranslation();
  const options = [
    { value: "", label: t("incidents.filterAll") },
    { value: "open", label: t("incidents.filterOpen") },
    { value: "in_progress", label: t("incidents.filterInProgress") },
    { value: "resolved", label: t("incidents.filterResolved") },
    { value: "closed", label: t("incidents.filterClosed") },
  ];
  return (
    <div className="flex gap-1 flex-wrap">
      {options.map(o => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          className={`text-xs px-2.5 py-1 rounded-full border transition-colors ${
            active === o.value
              ? "bg-[var(--brand)] text-white border-[var(--brand)]"
              : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--brand)] hover:text-[var(--brand)]"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function IncidentDetail({ incident, onBack, tenantId }: { incident: Incident; onBack: () => void; tenantId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canOperate = useCanOperate();
  const qc = useQueryClient();
  const [comment, setComment] = useState("");
  const [timeMinutes, setTimeMinutes] = useState("");
  const [timeDesc, setTimeDesc] = useState("");

  const q = useQuery({
    queryKey: ["incident-detail", incident.incident_id],
    queryFn: () => api.get<IncidentDetail>(`/api/v1/alerting/incidents/${incident.incident_id}`),
  });

  const transitionMut = useMutation({
    mutationFn: (target_state: string) =>
      api.post(`/api/v1/alerting/incidents/${incident.incident_id}/transition`, { target_state }),
    onSuccess: () => {
      toast("Estado atualizado", "success");
      qc.invalidateQueries({ queryKey: ["incident-detail", incident.incident_id] });
      qc.invalidateQueries({ queryKey: ["incidents", tenantId] });
    },
    onError: () => toast("Erro ao atualizar estado", "error"),
  });

  const commentMut = useMutation({
    mutationFn: (body: string) =>
      api.post(`/api/v1/alerting/incidents/${incident.incident_id}/comments`, { body }),
    onSuccess: () => {
      toast("Comentário adicionado", "success");
      setComment("");
      qc.invalidateQueries({ queryKey: ["incident-detail", incident.incident_id] });
    },
    onError: () => toast("Erro ao adicionar comentário", "error"),
  });

  const timeQ = useQuery({
    queryKey: ["incident-time", incident.incident_id],
    queryFn: () => api.get<TimeEntry[]>(`/api/v1/alerting/incidents/${incident.incident_id}/time-entries`),
  });

  const timeMut = useMutation({
    mutationFn: ({ minutes, description }: { minutes: number; description: string }) =>
      api.post(`/api/v1/alerting/incidents/${incident.incident_id}/time-entries`, { minutes, description }),
    onSuccess: () => {
      toast("Tempo registrado", "success");
      setTimeMinutes("");
      setTimeDesc("");
      qc.invalidateQueries({ queryKey: ["incident-time", incident.incident_id] });
    },
    onError: () => toast("Erro ao registrar tempo", "error"),
  });

  if (q.isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  if (q.isError || !q.data) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">
          <ChevronLeft className="w-4 h-4 mr-1" /> {t("common.back")}
        </Button>
        <p className="text-xs text-[var(--red)]">{t("incidents.loadDetailError")}</p>
      </div>
    );
  }

  const d = q.data;
  const nextStates = NEXT_STATES[d.lifecycle_state] ?? [];
  const currentAssignee = d.assignments.find(a => !a.effective_until);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={onBack}
          className="text-xs text-[var(--brand)] hover:underline flex items-center gap-1 bg-transparent border-0 p-0 cursor-pointer"
        >
          <ChevronLeft className="w-3 h-3" /> {t("incidents.back")}
        </button>
        <h2 className="text-sm font-semibold truncate flex-1">{d.title}</h2>
        <Badge variant={stateVariant(d.lifecycle_state)}>{t(`incidents.states.${d.lifecycle_state}`)}</Badge>
        {d.severity_class && (
          <Badge variant={sevVariant(d.severity_class)}>{d.severity_class.toUpperCase()}</Badge>
        )}
      </div>

      {/* Actions */}
      {canOperate && nextStates.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {nextStates.map(s => (
            <Button
              key={s}
              size="sm"
              variant={s === "resolved" || s === "closed" ? "secondary" : "primary"}
              disabled={transitionMut.isPending}
              onClick={() => transitionMut.mutate(s)}
            >
              {transitionMut.isPending && <Spinner className="w-3 h-3 mr-1" />}
              <ArrowRight className="w-3 h-3 mr-1" />
              {t(`incidents.transitions.${s}`)}
            </Button>
          ))}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Details */}
        <Card>
          <CardHeader><span className="text-sm font-medium">{t("incidents.details")}</span></CardHeader>
          <dl>
            {[
              [t("incidents.fieldIncident"), d.incident_id],
              [t("incidents.fieldAlert"), d.alert_id],
              [t("incidents.fieldAlertState"), d.alert_summary?.lifecycle_state ?? "—"],
              [t("incidents.fieldAssignee"), currentAssignee ? currentAssignee.assignee_principal_id : "—"],
              [t("incidents.fieldOpenedAt"), fmtTs(d.created_at)],
              [t("incidents.fieldUpdated"), fmtTs(d.updated_at)],
              [t("incidents.fieldSyncTicket"), d.provider_sync?.provider_ticket_ref ?? d.provider_sync?.sync_state ?? "—"],
            ].map(([l, v]) => (
              <div key={l} className="flex gap-3 py-1.5 border-b border-[var(--border)] last:border-0">
                <dt className="w-32 flex-shrink-0 text-xs text-[var(--text-muted)]">{l}</dt>
                <dd className="text-xs font-mono break-all">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>

        {/* Timeline */}
        <Card>
          <CardHeader><span className="text-sm font-medium">{t("incidents.history")}</span></CardHeader>
          {d.transitions.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] px-4 pb-3">{t("incidents.noTransitions")}</p>
          ) : (
            <ul className="space-y-1 px-1 pb-2">
              {d.transitions.map(tr => (
                <li key={tr.incident_transition_id}
                  className="text-xs border-l-2 border-[var(--border)] pl-3 py-1">
                  <span className="text-[var(--text-muted)]">{t(`incidents.states.${tr.from_state}`, { defaultValue: tr.from_state })}</span>
                  {" → "}
                  <span className="text-[var(--brand)]">{t(`incidents.states.${tr.to_state}`, { defaultValue: tr.to_state })}</span>
                  <span className="text-[var(--text-muted)] ml-2">{fmtTs(tr.occurred_at)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Comments */}
      <Card>
        <CardHeader>
          <span className="text-sm font-medium flex items-center gap-1.5">
            <MessageSquare className="w-4 h-4" />
            {t("incidents.comments")} {d.comments.length > 0 && `(${d.comments.length})`}
          </span>
        </CardHeader>
        <div className="space-y-2 px-4 pb-4">
          {d.comments.map(c => (
            <div key={c.incident_comment_id}
              className="bg-[var(--surface-2)] rounded-lg px-3 py-2 text-xs">
              <div className="flex items-center gap-2 mb-1">
                <User className="w-3 h-3 text-[var(--text-muted)]" />
                <span className="text-[var(--text-muted)] font-mono">{c.actor_principal_id}</span>
                <span className="text-[var(--text-muted)] ml-auto">{fmtTs(c.created_at)}</span>
              </div>
              <p className="text-[var(--text)] whitespace-pre-wrap">{c.body}</p>
            </div>
          ))}
          {canOperate && (
            <div className="space-y-2 pt-1">
              <textarea
                value={comment}
                onChange={e => setComment(e.target.value)}
                placeholder={t("incidents.commentPlaceholder")}
                rows={3}
                className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--text-muted)] px-3 py-2 resize-none focus:outline-none focus:border-[var(--brand)] transition-colors"
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={!comment.trim() || commentMut.isPending}
                  onClick={() => commentMut.mutate(comment.trim())}
                >
                  {commentMut.isPending && <Spinner className="w-3 h-3 mr-1" />}
                  {t("incidents.commentAdd")}
                </Button>
              </div>
            </div>
          )}
        </div>
      </Card>

      {/* Time tracking */}
      <Card>
        <CardHeader>
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Clock className="w-4 h-4" />
            {t("incidents.timeSpent")}
            {(timeQ.data?.length ?? 0) > 0 && (
              <span className="text-[var(--text-muted)] font-normal">
                {" "}— {timeQ.data!.reduce((s, e) => s + e.minutes, 0)} {t("incidents.timeTotal")}
              </span>
            )}
          </span>
        </CardHeader>
        <div className="space-y-2 px-4 pb-4">
          {timeQ.isLoading && <div className="flex justify-center py-2"><Spinner /></div>}
          {(timeQ.data ?? []).map(e => (
            <div key={e.entry_id}
              className="flex items-start gap-3 bg-[var(--surface-2)] rounded-lg px-3 py-2 text-xs">
              <Clock className="w-3 h-3 text-[var(--brand)] flex-shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0">
                <p className="font-medium">{e.minutes} min
                  {e.description && <span className="text-[var(--text-muted)] font-normal"> — {e.description}</span>}
                </p>
                <p className="text-[var(--text-muted)] font-mono">{e.logged_by_principal_id} · {fmtTs(e.logged_at)}</p>
              </div>
            </div>
          ))}
          {canOperate && (
            <div className="flex gap-2 pt-1 flex-wrap">
              <input
                type="number"
                min={1}
                max={1440}
                value={timeMinutes}
                onChange={e => setTimeMinutes(e.target.value)}
                placeholder={t("incidents.minutesPlaceholder")}
                className="w-24 text-xs rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--text-muted)] px-2 py-1.5 focus:outline-none focus:border-[var(--brand)] transition-colors"
              />
              <input
                value={timeDesc}
                onChange={e => setTimeDesc(e.target.value)}
                placeholder={t("incidents.descPlaceholder")}
                className="flex-1 text-xs rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--text-muted)] px-2 py-1.5 focus:outline-none focus:border-[var(--brand)] transition-colors"
              />
              <Button
                size="sm"
                variant="secondary"
                disabled={!timeMinutes || Number(timeMinutes) < 1 || timeMut.isPending}
                onClick={() => timeMut.mutate({ minutes: Number(timeMinutes), description: timeDesc.trim() })}
              >
                {timeMut.isPending && <Spinner className="w-3 h-3 mr-1" />}
                {t("incidents.logTime")}
              </Button>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}

export function IncidentsPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const [stateFilter, setStateFilter] = useState("open");
  const [selected, setSelected] = useState<Incident | null>(null);

  const q = useQuery({
    queryKey: ["incidents", tenantId, stateFilter],
    queryFn: () =>
      api.get<Incident[]>(
        `/api/v1/alerting/incidents${stateFilter ? `?state=${stateFilter}` : ""}`,
      ),
    refetchInterval: 30_000,
  });

  if (selected) {
    return (
      <IncidentDetail
        incident={selected}
        tenantId={tenantId}
        onBack={() => setSelected(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-base font-semibold">{t("incidents.title")}</h1>
          <p className="text-xs text-[var(--text-muted)]">{t("incidents.subtitle")}</p>
        </div>
      </div>

      <StateFilters active={stateFilter} onChange={setStateFilter} />

      {q.isLoading && (
        <div className="flex justify-center py-12"><Spinner /></div>
      )}

      {q.isError && (
        <p className="text-xs text-[var(--red)]">{t("incidents.loadError")}</p>
      )}

      {q.isSuccess && q.data.length === 0 && (
        <Card>
          <p className="text-xs text-[var(--text-muted)] px-4 py-6 text-center">
            {stateFilter
              ? t("incidents.emptyState", { state: t(`incidents.states.${stateFilter}`, { defaultValue: stateFilter }) })
              : t("incidents.emptyAll")}
          </p>
        </Card>
      )}

      {q.isSuccess && q.data.length > 0 && (
        <div className="space-y-2">
          {q.data.map(inc => (
            <button
              key={inc.incident_id}
              onClick={() => setSelected(inc)}
              className="w-full text-left bg-[var(--surface)] border border-[var(--border)] rounded-xl px-4 py-3 hover:border-[var(--brand)] transition-colors"
            >
              <div className="flex items-start gap-3">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{inc.title}</p>
                  <p className="text-xs text-[var(--text-muted)] font-mono truncate mt-0.5">
                    {inc.alert_id}
                  </p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {inc.severity_class && (
                    <Badge variant={sevVariant(inc.severity_class)}>
                      {inc.severity_class.toUpperCase()}
                    </Badge>
                  )}
                  <Badge variant={stateVariant(inc.lifecycle_state)}>
                    {t(`incidents.states.${inc.lifecycle_state}`)}
                  </Badge>
                  <span className="text-[10px] text-[var(--text-muted)] hidden sm:block">
                    {fmtTs(inc.updated_at)}
                  </span>
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
