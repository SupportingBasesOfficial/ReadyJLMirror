import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { useCanOperate } from "@/hooks/usePermission";
import { BookOpen, ChevronDown, ChevronRight, Ticket, UserCheck, UserX, Eye, CheckCircle2, Clock } from "lucide-react";

interface AlertFull {
  alert_id: string;
  lifecycle_state: string;
  source_kind: string;
  monitoring_source_id: string;
  monitoring_resource_id: string;
  source_evidence_summary: Record<string, unknown>;
  opened_at: string;
  resolved_at?: string;
  policy_id: string;
  policy_version: number;
  acknowledged_at?: string;
  acknowledged_by?: string;
  name?: string;
  problem_name?: string;
}

interface Transition {
  alert_transition_id: string;
  from_lifecycle_state: string;
  to_lifecycle_state: string;
  source_revision: number;
  occurred_at: string;
}

interface LinkedIncident {
  incident_id: string;
  title: string;
  lifecycle_state: string;
  created_at: string;
  updated_at: string;
}

interface TimelineEvent {
  kind: "action_assigned" | "action_ended" | "acknowledged" | "visibility_required" | "visibility_received";
  id: string;
  at: string;
  owner?: string;
  action?: string;
  reason?: string;
  principal_id?: string;
  note?: string;
  viewer?: string;
  side?: string;
}

interface TimelineData {
  alert_id: string;
  current_action: { action: string; owner: string | null; revision: number };
  timeline: TimelineEvent[];
}

interface KbArticle {
  article_id: string;
  title: string;
  status: string;
  category_id: string | null;
  category_name: string | null;
  tags: string[];
}

function sevVariant(cls?: unknown): "danger" | "warning" | "info" | "muted" {
  if (cls === "critical") return "danger";
  if (cls === "degraded" || cls === "warning") return "warning";
  if (cls === "informational") return "info";
  return "muted";
}

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

const KV = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex gap-3 py-1.5 border-b border-[var(--border)] last:border-0">
    <dt className="w-36 flex-shrink-0 text-xs text-[var(--text-muted)]">{label}</dt>
    <dd className="text-xs text-[var(--text)] font-mono break-all">{value}</dd>
  </div>
);

export function AlertDetail({
  tenantId: _tenantId,
  alertId,
  onBack,
}: {
  tenantId: string;
  alertId: string;
  onBack: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const canOperate = useCanOperate();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [noteText, setNoteText] = useState("");
  const [kbOpen, setKbOpen] = useState(false);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [incidentTitle, setIncidentTitle] = useState("");

  const q = useQuery({
    queryKey: ["alert", alertId],
    queryFn: () =>
      api.get<{ alert: AlertFull; transitions: Transition[] }>(
        `/api/v1/alerting/alerts/${alertId}`,
      ),
  });

  const ackMut = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/alerting/alerts/${alertId}/acknowledge`, {}),
    onSuccess: () => {
      toast("Alerta reconhecido", "success");
      qc.invalidateQueries({ queryKey: ["alert", alertId] });
      qc.invalidateQueries({ queryKey: ["alerts"] });
    },
    onError: () => toast("Erro ao reconhecer alerta", "error"),
  });

  const incidentMut = useMutation({
    mutationFn: (title: string) =>
      api.post(`/api/v1/alerting/alerts/${alertId}/incidents`, { title }),
    onSuccess: () => {
      toast("Incidente criado", "success");
      setIncidentTitle("");
      qc.invalidateQueries({ queryKey: ["alert-incidents", alertId] });
      qc.invalidateQueries({ queryKey: ["incidents"] });
    },
    onError: (e: Error) => toast(e.message || "Erro ao criar incidente", "error"),
  });

  const noteMut = useMutation({
    mutationFn: (vars: { title: string; description: string }) =>
      api.post("/api/v1/itsm/changes", {
        title: vars.title,
        description: vars.description,
        category: "normal",
        risk: "low",
      }),
    onSuccess: () => {
      toast("Nota registrada", "success");
      setNoteText("");
    },
    onError: () => toast("Erro ao salvar nota", "error"),
  });

  const incidentsQ = useQuery({
    queryKey: ["alert-incidents", alertId],
    queryFn: () => api.get<LinkedIncident[]>(`/api/v1/alerting/alerts/${alertId}/incidents`),
    enabled: !!(alertId),
  });

  // Derived early (before null-check) so kbQuery can use it as a stable key
  const ev = q.data?.alert?.source_evidence_summary;
  const searchTerm =
    (ev?.name as string | undefined) ||
    (ev?.problem_name as string | undefined) ||
    q.data?.alert?.monitoring_resource_id ||
    "";

  const timelineQ = useQuery({
    queryKey: ["alert-timeline", alertId],
    queryFn: () => api.get<TimelineData>(`/api/v1/alerting/alerts/${alertId}/timeline`),
    enabled: timelineOpen && !q.isLoading && !q.isError,
  });

  const kbQuery = useQuery({
    queryKey: ["kb-search", searchTerm],
    queryFn: () =>
      api.get<KbArticle[]>(
        `/api/v1/kb/articles?q=${encodeURIComponent(searchTerm)}&status=published`,
      ),
    enabled: !q.isLoading && !q.isError && !!searchTerm,
    staleTime: 300_000,
  });

  if (q.isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  if (q.isError || !q.data) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">{t("alertDetail.back")}</Button>
        <p className="text-xs text-[var(--red)]">{t("alertDetail.loadError")}</p>
      </div>
    );
  }

  const a = q.data.alert;
  const transitions = q.data.transitions;
  const sevClass = ev?.severity_class as string | undefined;
  const isAcknowledged = !!(a.acknowledged_at || a.acknowledged_by);
  const alertLabel = a.name || a.problem_name || a.alert_id;

  const kbArticles = (kbQuery.data ?? []).slice(0, 5);

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <button
          onClick={onBack}
          className="text-xs text-[var(--brand)] cursor-pointer hover:underline bg-none border-none p-0"
        >
          {t("alertDetail.back")}
        </button>
        <h2 className="text-sm font-semibold font-mono truncate">{a.alert_id}</h2>
        <Badge variant={sevVariant(sevClass)}>
          {(sevClass ?? "unknown").toUpperCase()}
        </Badge>
        {isAcknowledged && (
          <Badge variant="info">Reconhecido</Badge>
        )}
        {canOperate && (
          <div className="flex gap-2 ml-auto flex-wrap">
            {!isAcknowledged && (
              <Button
                variant="secondary"
                size="sm"
                disabled={ackMut.isPending}
                onClick={() => ackMut.mutate()}
              >
                {ackMut.isPending && <Spinner className="w-3 h-3 mr-1" />}
                Reconhecer alerta
              </Button>
            )}
            <Button
              variant="secondary"
              size="sm"
              disabled={incidentMut.isPending}
              onClick={() =>
                incidentMut.mutate(incidentTitle || `Alerta: ${alertLabel}`)
              }
            >
              {incidentMut.isPending && <Spinner className="w-3 h-3 mr-1" />}
              <Ticket className="w-3 h-3 mr-1" />
              Abrir incidente
            </Button>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><span className="text-sm font-medium">{t("alertDetail.details")}</span></CardHeader>
          <dl>
            <KV label={t("alertDetail.fieldState")} value={a.lifecycle_state} />
            <KV label={t("alertDetail.fieldSourceKind")} value={a.source_kind} />
            <KV label={t("alertDetail.fieldPolicy")} value={`${a.policy_id} v${a.policy_version}`} />
            <KV label={t("alertDetail.fieldSource")} value={a.monitoring_source_id} />
            <KV label={t("alertDetail.fieldResource")} value={a.monitoring_resource_id} />
            <KV label={t("alertDetail.fieldOpened")} value={fmtTs(a.opened_at)} />
            <KV label={t("alertDetail.fieldResolved")} value={a.resolved_at ? fmtTs(a.resolved_at) : "—"} />
            {a.acknowledged_at && (
              <KV label={t("alertDetail.fieldAckedAt")} value={fmtTs(a.acknowledged_at)} />
            )}
            {a.acknowledged_by && (
              <KV label={t("alertDetail.fieldAckedBy")} value={String(a.acknowledged_by)} />
            )}
          </dl>
        </Card>

        <Card>
          <CardHeader><span className="text-sm font-medium">{t("alertDetail.evidenceSummary")}</span></CardHeader>
          <pre className="text-[10px] text-[var(--text-muted)] overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(ev, null, 2)}
          </pre>
        </Card>
      </div>

      {transitions.length > 0 && (
        <Card>
          <CardHeader><span className="text-sm font-medium">{t("alertDetail.lifecycle")}</span></CardHeader>
          <ul className="space-y-1">
            {transitions.map((t) => (
              <li key={t.alert_transition_id}
                className="text-xs border-l-2 border-[var(--border)] pl-3 py-1">
                <span className="text-[var(--text-muted)]">{t.from_lifecycle_state || "—"}</span>
                {" → "}
                <span className="text-[var(--brand)]">{t.to_lifecycle_state}</span>
                <span className="text-[var(--text-muted)] ml-2">{fmtTs(t.occurred_at)}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {/* Operator action timeline */}
      <Card>
        <CardHeader>
          <button
            onClick={() => setTimelineOpen((o) => !o)}
            className="flex items-center gap-2 w-full text-left bg-transparent border-0 p-0 cursor-pointer"
          >
            {timelineOpen
              ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
              : <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />}
            <Clock className="w-4 h-4 text-[var(--brand)] flex-shrink-0" />
            <span className="text-sm font-medium">Timeline de Ações</span>
            {timelineQ.data && (
              <span className="ml-auto text-[10px] font-mono text-[var(--text-muted)] mr-1">
                {timelineQ.data.timeline.length} evento{timelineQ.data.timeline.length !== 1 ? "s" : ""}
              </span>
            )}
          </button>
        </CardHeader>
        {timelineOpen && (
          <div className="px-4 pb-4">
            {timelineQ.isLoading && <div className="flex justify-center py-3"><Spinner /></div>}
            {timelineQ.isError && <p className="text-xs text-[var(--red)]">Falha ao carregar timeline.</p>}
            {timelineQ.data && (
              <>
                {timelineQ.data.current_action.action !== "no_human_action_required" && (
                  <div className="mb-3 flex items-center gap-2 bg-[var(--surface-2)] rounded-lg px-3 py-2 text-xs">
                    <UserCheck className="w-3.5 h-3.5 text-[var(--brand)] flex-shrink-0" />
                    <span className="text-[var(--text-muted)]">Ação atual:</span>
                    <span className="font-mono font-medium">{timelineQ.data.current_action.action}</span>
                    {timelineQ.data.current_action.owner && (
                      <span className="text-[var(--text-muted)]">→ {timelineQ.data.current_action.owner}</span>
                    )}
                  </div>
                )}
                {timelineQ.data.timeline.length === 0 ? (
                  <p className="text-xs text-[var(--text-muted)]">Nenhuma ação de operador registrada.</p>
                ) : (
                  <ol className="relative border-l border-[var(--border)] space-y-0 ml-1">
                    {timelineQ.data.timeline.map((ev, i) => {
                      const Icon =
                        ev.kind === "action_assigned" ? UserCheck :
                        ev.kind === "action_ended" ? UserX :
                        ev.kind === "acknowledged" ? CheckCircle2 :
                        Eye;
                      const label =
                        ev.kind === "action_assigned" ? `Ação atribuída: ${ev.action ?? ""}${ev.owner ? ` → ${ev.owner}` : ""}` :
                        ev.kind === "action_ended" ? `Ação encerrada${ev.reason ? ` (${ev.reason})` : ""}` :
                        ev.kind === "acknowledged" ? `Reconhecido${ev.principal_id ? ` por ${ev.principal_id}` : ""}` :
                        ev.kind === "visibility_required" ? `Visibilidade exigida${ev.viewer ? ` de ${ev.viewer}` : ""}${ev.side ? ` (${ev.side})` : ""}` :
                        `Visibilidade confirmada${ev.viewer ? ` por ${ev.viewer}` : ""}`;
                      return (
                        <li key={`${ev.id}-${i}`} className="ml-4 pb-4 last:pb-0">
                          <span className="absolute -left-[7px] flex items-center justify-center w-3.5 h-3.5 rounded-full bg-[var(--surface)] border border-[var(--border)]">
                            <Icon className="w-2 h-2 text-[var(--brand)]" />
                          </span>
                          <p className="text-xs text-[var(--text)]">{label}</p>
                          {ev.note && <p className="text-[10px] text-[var(--text-muted)] mt-0.5 italic">"{ev.note}"</p>}
                          <time className="text-[10px] text-[var(--text-muted)] font-mono">{fmtTs(ev.at)}</time>
                        </li>
                      );
                    })}
                  </ol>
                )}
              </>
            )}
          </div>
        )}
      </Card>

      {/* Operator notes */}
      <Card>
        <CardHeader><span className="text-sm font-medium">Notas do operador</span></CardHeader>
        <div className="space-y-2 p-3">
          <textarea
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Registre o que foi verificado, ações tomadas, contexto relevante…"
            rows={4}
            className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--text-muted)] px-3 py-2 resize-none focus:outline-none focus:border-[var(--brand)] transition-colors"
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              variant="secondary"
              disabled={!noteText.trim() || noteMut.isPending}
              onClick={() =>
                noteMut.mutate({
                  title: `Nota de alerta: ${a.alert_id}`,
                  description: noteText.trim(),
                })
              }
            >
              {noteMut.isPending && <Spinner className="w-3 h-3 mr-1" />}
              Salvar nota
            </Button>
          </div>
        </div>
      </Card>

      {/* Linked incidents */}
      <Card>
        <CardHeader>
          <span className="text-sm font-medium flex items-center gap-1.5">
            <Ticket className="w-4 h-4 text-[var(--brand)]" />
            Incidentes vinculados
            {(incidentsQ.data?.length ?? 0) > 0 && ` (${incidentsQ.data!.length})`}
          </span>
        </CardHeader>
        <div className="px-4 pb-4 space-y-3">
          {incidentsQ.isLoading && <div className="flex justify-center py-2"><Spinner /></div>}
          {(incidentsQ.data ?? []).map(inc => (
            <div key={inc.incident_id}
              className="flex items-center gap-3 bg-[var(--surface-2)] rounded-lg px-3 py-2 text-xs">
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate">{inc.title}</p>
                <p className="text-[var(--text-muted)] font-mono">{inc.incident_id}</p>
              </div>
              <Badge variant={
                inc.lifecycle_state === "open" ? "danger"
                : inc.lifecycle_state === "in_progress" ? "warning"
                : inc.lifecycle_state === "resolved" ? "info"
                : "muted"
              }>
                {{ open: "Aberto", in_progress: "Em andamento", resolved: "Resolvido", closed: "Fechado" }[inc.lifecycle_state] ?? inc.lifecycle_state}
              </Badge>
            </div>
          ))}
          {incidentsQ.isSuccess && incidentsQ.data.length === 0 && (
            <div className="space-y-2">
              <p className="text-xs text-[var(--text-muted)]">Nenhum incidente vinculado.</p>
              {canOperate && (
                <div className="flex gap-2">
                  <input
                    value={incidentTitle}
                    onChange={e => setIncidentTitle(e.target.value)}
                    placeholder={`Título do incidente (padrão: Alerta: ${alertLabel})`}
                    className="flex-1 text-xs rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--text-muted)] px-2 py-1.5 focus:outline-none focus:border-[var(--brand)] transition-colors"
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    disabled={incidentMut.isPending}
                    onClick={() => incidentMut.mutate(incidentTitle || `Alerta: ${alertLabel}`)}
                  >
                    {incidentMut.isPending && <Spinner className="w-3 h-3 mr-1" />}
                    Abrir
                  </Button>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>

      {/* KB related articles */}
      <Card>
        <CardHeader>
          <button
            onClick={() => setKbOpen((o) => !o)}
            className="flex items-center gap-2 w-full text-left bg-transparent border-0 p-0 cursor-pointer"
          >
            {kbOpen
              ? <ChevronDown className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
              : <ChevronRight className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />}
            <BookOpen className="w-4 h-4 text-[var(--brand)] flex-shrink-0" />
            <span className="text-sm font-medium">
              Artigos relacionados na KB
              {kbQuery.isSuccess && ` (${kbArticles.length})`}
            </span>
          </button>
        </CardHeader>
        {kbOpen && (
          kbQuery.isLoading
            ? <div className="flex justify-center py-3"><Spinner /></div>
            : kbArticles.length === 0
              ? <p className="text-xs text-[var(--text-muted)] px-4 pb-3">Nenhum artigo encontrado para este alerta.</p>
              : (
                <ul className="space-y-1 px-4 pb-3">
                  {kbArticles.map((article) => (
                    <li key={article.article_id}>
                      <a
                        href={`/kb?article=${article.article_id}`}
                        className="flex items-center gap-2 text-xs text-[var(--brand)] hover:underline"
                        onClick={(e) => { e.preventDefault(); navigate(`/kb?article=${article.article_id}`); }}
                      >
                        <span className="flex-1 truncate">{article.title}</span>
                        {article.category_name && (
                          <Badge variant="muted">{article.category_name}</Badge>
                        )}
                      </a>
                    </li>
                  ))}
                </ul>
              )
        )}
      </Card>
    </div>
  );
}
