import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useToast } from "@/components/ui/toast";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

type Tab = "events" | "policy";

interface ErrorEvent {
  event_id: string;
  application_id: string;
  error_code: string;
  error_message: string;
  occurred_at: string;
  received_at: string;
  severity_hint: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL" | null;
  status: "received" | "processing" | "processed" | "failed";
  source_principal_id: string;
  operation: string | null;
}

interface Policy {
  severity_threshold: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  auto_open_ticket: boolean;
  manual_override_only: boolean;
  notify_channels: string[];
  automation_triggers: { script_id: string }[];
  updated_by?: string;
  updated_at?: string;
}

interface Destination {
  destination_config_id: string;
  channel_class: string;
  destination_ref: string;
  label: string;
}

interface Script {
  script_id: string;
  name: string;
  script_type: string;
  enabled: boolean;
}

const SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;

const CHANNEL_LABELS: Record<string, string> = {
  "whatsapp_business@1": "WhatsApp",
  "email_smtp@1": "Email",
  "slack@1": "Slack",
};

function sevVariant(s: string | null): "info" | "warning" | "danger" | "muted" {
  if (s === "CRITICAL") return "danger";
  if (s === "HIGH") return "warning";
  if (s === "MEDIUM") return "info";
  return "muted";
}

function statusVariant(s: string): "success" | "warning" | "danger" | "muted" {
  if (s === "processed") return "success";
  if (s === "processing") return "warning";
  if (s === "failed") return "danger";
  return "muted";
}

function fmtTs(iso?: string) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function EventDetail({
  event,
  tenantId,
  onBack,
}: {
  event: ErrorEvent;
  tenantId: string;
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [assignTo, setAssignTo] = useState("");
  const [showAssignForm, setShowAssignForm] = useState(false);

  const openTicketMut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/itsm/changes", {
        title: event.error_code || "Erro de aplicação",
        description: event.error_message,
        category:
          event.severity_hint === "CRITICAL" || event.severity_hint === "HIGH"
            ? "emergency"
            : "normal",
        risk:
          event.severity_hint === "CRITICAL" ? "critical" :
          event.severity_hint === "HIGH" ? "high" : "medium",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-changes"] });
      toast("Ticket ITSM criado com sucesso.", "success");
    },
    onError: () => {
      toast("Erro ao criar ticket ITSM.", "error");
    },
  });

  const markProcessedMut = useMutation({
    mutationFn: () =>
      api.patch(
        `/api/v1/alerting/tenants/${tenantId}/application-error-events/${event.event_id}`,
        { status: "processed" }
      ),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ir-events", tenantId] });
      toast("Evento marcado como processado.", "success");
      onBack();
    },
    onError: () => {
      toast("Erro ao marcar evento como processado.", "error");
    },
  });

  const assignMut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/itsm/changes", {
        title: event.error_code || "Erro de aplicação",
        description: `${event.error_message}\n\nAtribuído a: ${assignTo}`,
        category: "emergency",
        risk: "high",
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["itsm-changes"] });
      toast(`Evento atribuído a "${assignTo}" via ticket ITSM.`, "success");
      setAssignTo("");
      setShowAssignForm(false);
    },
    onError: () => {
      toast("Erro ao atribuir evento.", "error");
    },
  });

  return (
    <div className="space-y-4">
      <button
        onClick={onBack}
        className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] flex items-center gap-1"
      >
        ← Voltar
      </button>
      <Card>
        <CardHeader>
          <span className="text-sm font-medium">Evento de Erro — Detalhes</span>
          <Badge variant={sevVariant(event.severity_hint)}>{event.severity_hint ?? "N/A"}</Badge>
          <Badge variant={statusVariant(event.status)}>{event.status}</Badge>
        </CardHeader>
        <div className="space-y-2 text-sm">
          <Row label="Event ID" value={event.event_id} mono />
          <Row label="Aplicação" value={event.application_id} mono />
          <Row label="Código do erro" value={event.error_code} mono />
          <Row label="Mensagem" value={event.error_message} />
          <Row label="Ocorreu em" value={fmtTs(event.occurred_at)} />
          <Row label="Recebido em" value={fmtTs(event.received_at)} />
          <Row label="Operação" value={event.operation ?? "—"} />
          <Row label="Principal" value={event.source_principal_id} mono />
        </div>
      </Card>

      {/* Actions */}
      <Card>
        <CardHeader>
          <span className="text-sm font-medium">Ações</span>
        </CardHeader>
        <div className="space-y-3">
          {/* Open ITSM ticket */}
          {event.status !== "processed" && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                onClick={() => openTicketMut.mutate()}
                disabled={openTicketMut.isPending}
              >
                {openTicketMut.isPending ? <Spinner className="w-4 h-4" /> : "Abrir ticket ITSM"}
              </Button>
              {openTicketMut.isError && (
                <span className="text-xs text-[var(--red)]">Falha ao criar ticket.</span>
              )}
              {openTicketMut.isSuccess && (
                <span className="text-xs text-[var(--green,#10b981)]">Ticket criado.</span>
              )}
            </div>
          )}

          {/* Mark as processed */}
          {(event.status === "received" || event.status === "processing") && (
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="secondary"
                onClick={() => markProcessedMut.mutate()}
                disabled={markProcessedMut.isPending}
              >
                {markProcessedMut.isPending ? (
                  <Spinner className="w-4 h-4" />
                ) : (
                  "Marcar como processado"
                )}
              </Button>
              {markProcessedMut.isError && (
                <span className="text-xs text-[var(--red)]">Falha ao atualizar status.</span>
              )}
            </div>
          )}

          {/* Assign to */}
          <div className="space-y-2">
            {!showAssignForm ? (
              <Button variant="secondary" onClick={() => setShowAssignForm(true)}>
                Atribuir a…
              </Button>
            ) : (
              <div className="flex flex-wrap items-center gap-2">
                <input
                  type="text"
                  value={assignTo}
                  onChange={(e) => setAssignTo(e.target.value)}
                  placeholder="Nome ou e-mail do responsável"
                  className="flex-1 min-w-[180px] bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-1.5 text-xs focus:outline-none focus:border-[var(--brand)]"
                />
                <Button
                  onClick={() => assignMut.mutate()}
                  disabled={!assignTo.trim() || assignMut.isPending}
                >
                  {assignMut.isPending ? <Spinner className="w-4 h-4" /> : "Atribuir"}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => {
                    setShowAssignForm(false);
                    setAssignTo("");
                  }}
                >
                  Cancelar
                </Button>
                {assignMut.isError && (
                  <span className="text-xs text-[var(--red)]">Falha ao atribuir.</span>
                )}
              </div>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex gap-3 py-1.5 border-b border-[var(--border)] last:border-0">
      <span className="w-36 flex-shrink-0 text-[var(--text-muted)] text-xs">{label}</span>
      <span className={["text-xs break-all", mono ? "font-mono" : ""].join(" ")}>{value}</span>
    </div>
  );
}

function EventsTab({ tenantId }: { tenantId: string }) {
  const [selected, setSelected] = useState<ErrorEvent | null>(null);

  const q = useQuery({
    queryKey: ["ir-events", tenantId],
    queryFn: () =>
      api.get<{ events: ErrorEvent[] }>(
        `/api/v1/alerting/tenants/${tenantId}/application-error-events`
      ).then((r) => {
        if (!Array.isArray(r?.events)) throw new Error("Unexpected response shape");
        return r.events;
      }),
    refetchInterval: 30_000,
  });

  if (selected) return <EventDetail event={selected} tenantId={tenantId} onBack={() => setSelected(null)} />;

  const events = q.data ?? [];

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          Eventos de erro de aplicações integradas via webhook G11.
        </p>
        {q.isFetching && !q.isLoading && <Spinner className="w-3 h-3" />}
      </div>
      <Card className="p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)] p-4">Falha ao carregar eventos.</p>
        ) : events.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] p-4">Nenhum evento de erro registrado.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="px-4 py-2.5 font-medium">Severidade</th>
                <th className="px-4 py-2.5 font-medium">Aplicação</th>
                <th className="px-4 py-2.5 font-medium">Código</th>
                <th className="px-4 py-2.5 font-medium">Mensagem</th>
                <th className="px-4 py-2.5 font-medium">Status</th>
                <th className="px-4 py-2.5 font-medium">Ocorreu em</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {events.map((e) => (
                <tr
                  key={e.event_id}
                  onClick={() => setSelected(e)}
                  className="hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
                >
                  <td className="px-4 py-2.5">
                    <Badge variant={sevVariant(e.severity_hint)}>
                      {e.severity_hint ?? "N/A"}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[10px] text-[var(--text)] max-w-[120px] truncate">
                    {e.application_id}
                  </td>
                  <td className="px-4 py-2.5 font-mono text-[10px] text-[var(--text)] max-w-[120px] truncate">
                    {e.error_code}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text)] max-w-[220px] truncate">
                    {e.error_message}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={statusVariant(e.status)}>{e.status}</Badge>
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                    {fmtTs(e.occurred_at)}
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

function ChannelPicker({
  tenantId,
  selected,
  onChange,
}: {
  tenantId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const navigate = useNavigate();
  const q = useQuery<Destination[]>({
    queryKey: ["notif-channels", tenantId],
    queryFn: () => api.get<Destination[]>("/api/v1/alerting/notification-channels"),
  });

  const destinations = q.data ?? [];

  function toggle(id: string) {
    onChange(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    );
  }

  if (q.isLoading) return <div className="text-xs text-[var(--text-muted)]">Carregando canais…</div>;

  if (destinations.length === 0) {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        Nenhum canal configurado.{" "}
        <a
          href="/channels"
          className="text-[var(--brand)] hover:underline cursor-pointer"
          onClick={(e) => {
            e.preventDefault();
            navigate("/channels");
          }}
        >
          Adicione em Canais de Notificação.
        </a>
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {destinations.map((d) => {
        const active = selected.includes(d.destination_config_id);
        return (
          <button
            key={d.destination_config_id}
            type="button"
            onClick={() => toggle(d.destination_config_id)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors"
            style={{
              background: active ? "color-mix(in srgb, var(--brand) 12%, var(--surface))" : "var(--surface-2)",
              borderColor: active ? "var(--brand)" : "var(--border)",
              color: active ? "var(--brand)" : "var(--text-muted)",
            }}
          >
            <span className="text-[10px] font-medium">{CHANNEL_LABELS[d.channel_class] ?? d.channel_class}</span>
            <span className="truncate max-w-[120px]">{d.label || d.destination_ref}</span>
          </button>
        );
      })}
    </div>
  );
}

function ScriptPicker({
  tenantId,
  selected,
  onChange,
}: {
  tenantId: string;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const q = useQuery<Script[]>({
    queryKey: ["automation-scripts", tenantId],
    queryFn: () => api.get<Script[]>("/api/v1/automation/scripts"),
  });

  const scripts = (q.data ?? []).filter((s) => s.enabled);

  function toggle(id: string) {
    onChange(
      selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id]
    );
  }

  if (q.isLoading) return <div className="text-xs text-[var(--text-muted)]">Carregando scripts…</div>;

  if (scripts.length === 0) {
    return (
      <p className="text-xs text-[var(--text-muted)]">
        Nenhum script de automação ativo.{" "}
        <button onClick={() => navigate("/automation")} className="text-[var(--brand)] hover:underline">
          Crie em Automação.
        </button>
      </p>
    );
  }

  return (
    <div className="flex flex-wrap gap-2">
      {scripts.map((s) => {
        const active = selected.includes(s.script_id);
        return (
          <button
            key={s.script_id}
            type="button"
            onClick={() => toggle(s.script_id)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs border transition-colors"
            style={{
              background: active ? "color-mix(in srgb, var(--brand) 12%, var(--surface))" : "var(--surface-2)",
              borderColor: active ? "var(--brand)" : "var(--border)",
              color: active ? "var(--brand)" : "var(--text-muted)",
            }}
          >
            <span className="font-mono text-[10px]">{s.script_type}</span>
            <span className="truncate max-w-[140px]">{s.name}</span>
          </button>
        );
      })}
    </div>
  );
}

function PolicyTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const q = useQuery({
    queryKey: ["ir-policy", tenantId],
    queryFn: () =>
      api.get<Policy>(`/api/v1/alerting/tenants/${tenantId}/incident-response-policy`),
  });

  const [form, setForm] = useState<Policy | null>(null);
  const [isDirty, setIsDirty] = useState(false);
  const policy = form ?? q.data ?? null;

  function updateForm(patch: Partial<Policy>) {
    setForm((prev) => ({ ...(prev ?? q.data!), ...patch }));
    setIsDirty(true);
  }

  const mut = useMutation({
    mutationFn: (body: Policy) =>
      api.put(`/api/v1/alerting/tenants/${tenantId}/incident-response-policy`, {
        severity_threshold: body.severity_threshold,
        auto_open_ticket: body.auto_open_ticket,
        manual_override_only: body.manual_override_only,
        notify_channels: body.notify_channels,
        automation_triggers: body.automation_triggers.map((t) => ({ script_id: t.script_id })),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ir-policy", tenantId] });
      setForm(null);
      setIsDirty(false);
      toast("Política salva com sucesso.", "success");
    },
  });

  if (q.isLoading) return <div className="flex justify-center py-8"><Spinner /></div>;
  if (!policy) return <p className="text-xs text-[var(--red)] p-4">Falha ao carregar política.</p>;

  const dirty = isDirty;
  const selectedChannels = policy.notify_channels ?? [];
  const selectedScripts = (policy.automation_triggers ?? []).map((t) => t.script_id);

  return (
    <div className="space-y-4 max-w-lg">
      <p className="text-xs text-[var(--text-muted)]">
        Define o comportamento automático ao receber eventos de erro de aplicações.
      </p>

      <Card>
        <CardHeader>
          <span className="text-sm font-medium">Política de Resposta a Incidentes</span>
          {policy.updated_at && (
            <span className="text-xs text-[var(--text-muted)]">
              atualizado em {fmtTs(policy.updated_at)}
            </span>
          )}
        </CardHeader>

        <div className="space-y-5">
          {/* Severity threshold */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">
              Severidade mínima para acionar
            </label>
            <select
              value={policy.severity_threshold}
              onChange={(e) =>
                updateForm({ severity_threshold: e.target.value as Policy["severity_threshold"] })
              }
              className="w-full bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm focus:outline-none focus:border-[var(--brand)]"
            >
              {SEVERITIES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>

          {/* Auto open ticket */}
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={policy.auto_open_ticket}
              onChange={(e) =>
                updateForm({ auto_open_ticket: e.target.checked })
              }
              className="accent-[var(--brand)] w-4 h-4"
            />
            <div>
              <p className="text-sm font-medium">Abrir ticket automaticamente</p>
              <p className="text-xs text-[var(--text-muted)]">
                Cria um ticket ITSM quando o limiar de severidade for atingido.
              </p>
            </div>
          </label>

          {/* Manual override only */}
          <label className="flex items-center gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={policy.manual_override_only}
              onChange={(e) =>
                updateForm({ manual_override_only: e.target.checked })
              }
              className="accent-[var(--brand)] w-4 h-4"
            />
            <div>
              <p className="text-sm font-medium">Apenas ação manual</p>
              <p className="text-xs text-[var(--text-muted)]">
                Desativa todas as ações automáticas — requer intervenção manual.
              </p>
            </div>
          </label>

          {/* Notify channels */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">
              Canais de notificação
              <span className="ml-1 text-[var(--text-dim)]">(selecione um ou mais)</span>
            </label>
            <ChannelPicker
              tenantId={tenantId}
              selected={selectedChannels}
              onChange={(ids) => updateForm({ notify_channels: ids })}
            />
          </div>

          {/* Automation triggers */}
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1.5">
              Scripts de automação a disparar
              <span className="ml-1 text-[var(--text-dim)]">(selecione um ou mais)</span>
            </label>
            <ScriptPicker
              tenantId={tenantId}
              selected={selectedScripts}
              onChange={(ids) =>
                updateForm({ automation_triggers: ids.map((id) => ({ script_id: id })) })
              }
            />
          </div>

          {/* Actions */}
          <div className="flex gap-2 pt-2">
            <Button
              onClick={() => mut.mutate(policy)}
              disabled={!dirty || mut.isPending}
            >
              {mut.isPending ? <Spinner className="w-4 h-4" /> : "Salvar política"}
            </Button>
            {dirty && (
              <Button variant="secondary" onClick={() => { setForm(null); setIsDirty(false); }}>
                Cancelar
              </Button>
            )}
          </div>

          {mut.isError && (
            <p className="text-xs text-[var(--red)]">Falha ao salvar. Tente novamente.</p>
          )}
          {mut.isSuccess && !isDirty && (
            <p className="text-xs text-[var(--green)]">Política salva com sucesso.</p>
          )}
        </div>
      </Card>
    </div>
  );
}

export function IncidentResponsePage({ tenantId }: { tenantId: string }) {
  const [tab, setTab] = useState<Tab>("events");

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Incident Response</h2>
      </div>

      <div className="flex gap-1.5">
        {(["events", "policy"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={[
              "px-3 py-1 rounded-full text-xs cursor-pointer border transition-colors",
              tab === t
                ? "border-[var(--brand)] text-[var(--brand)] bg-[var(--surface-2)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)]",
            ].join(" ")}
          >
            {t === "events" ? "Eventos" : "Política"}
          </button>
        ))}
      </div>

      {tab === "events" ? (
        <EventsTab tenantId={tenantId} />
      ) : (
        <PolicyTab tenantId={tenantId} />
      )}
    </div>
  );
}
