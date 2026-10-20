import { useState } from "react";
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
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";

interface Destination {
  destination_config_id: string;
  channel_class: string;
  destination_ref: string;
  label: string;
  created_at: string;
}

const CHANNEL_LABELS: Record<string, string> = {
  "whatsapp_business@1": "WhatsApp",
  "email_smtp@1": "Email",
  "slack@1": "Slack",
};

const CHANNEL_OPTIONS = [
  { value: "email_smtp@1", label: "Email (SMTP)" },
  { value: "whatsapp_business@1", label: "WhatsApp Business" },
  { value: "slack@1", label: "Slack Webhook" },
];

function channelVariant(cls: string): "info" | "success" | "muted" {
  if (cls === "whatsapp_business@1") return "success";
  if (cls === "email_smtp@1") return "info";
  return "muted";
}

function fmtTs(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function AddDestinationForm({
  tenantId,
  onDone,
}: {
  tenantId: string;
  onDone: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [channel, setChannel] = useState("email_smtp@1");
  const [destRef, setDestRef] = useState("");
  const [label, setLabel] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/alerting/notification-channels", {
        channel_class: channel,
        destination_ref: destRef.trim(),
        label: label.trim(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notification-channels", tenantId] });
      toast("Canal criado com sucesso", "success");
      onDone();
    },
    onError: (e: unknown) => {
      const detail = (e as { detail?: string; message?: string })?.detail
        ?? (e as Error)?.message
        ?? "Falha ao adicionar canal.";
      setErr(detail);
      toast("Erro: " + detail, "error");
    },
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("channels.addTitle")}</h3>

      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("channels.channelField")}</label>
        <select
          value={channel}
          onChange={(e) => setChannel(e.target.value)}
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
        >
          {CHANNEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("channels.destField")}</label>
        <input
          type="text"
          value={destRef}
          onChange={(e) => setDestRef(e.target.value)}
          placeholder={
            channel === "email_smtp@1"
              ? "ops@example.com"
              : channel === "slack@1"
              ? "https://hooks.slack.com/..."
              : "+55119..."
          }
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("channels.labelField")}</label>
        <input
          type="text"
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. NOC on-call email"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
        />
      </div>

      {err && <p className="text-xs text-[var(--red)]">{err}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !destRef.trim() || !label.trim()}
        >
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}
          {t("channels.addBtn")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>
          {t("common.cancel")}
        </Button>
      </div>
    </Card>
  );
}

// ── Delivery log types ─────────────────────────────────────────────────────

interface NotificationIntent {
  notification_intent_id: string;
  alert_id: string;
  reason: string;
  destination_ref: string;
  created_at: string;
  current_state: string | null;
  attempt_count: number | null;
  retry_required: boolean | null;
  next_attempt_at: string | null;
}

interface NotificationAttempt {
  notification_attempt_id: string;
  attempt_number: number;
  outcome: string;
  provider_message_ref: string | null;
  failure_class: string | null;
  started_at: string | null;
  completed_at: string | null;
}

interface NotificationEvidence {
  notification_evidence_id: string;
  normalized_state: string;
  provider_callback_id: string | null;
  observed_at: string;
}

interface NotificationDetail {
  intent: NotificationIntent;
  attempts: NotificationAttempt[];
  evidence: NotificationEvidence[];
}

function stateVariant(s: string | null): "success" | "danger" | "warning" | "muted" {
  if (!s) return "muted";
  if (s === "delivered") return "success";
  if (s === "failed" || s === "permanently_failed") return "danger";
  if (s === "pending" || s === "retry_pending") return "warning";
  return "muted";
}

function fmtTs2(iso?: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString("pt-BR"); } catch { return iso; }
}

function DeliveryRow({ intent, tenantId }: { intent: NotificationIntent; tenantId: string }) {
  const [open, setOpen] = useState(false);

  const detailQ = useQuery({
    queryKey: ["notification-detail", intent.notification_intent_id],
    queryFn: () => api.get<NotificationDetail>(
      `/api/v1/alerting/notifications/${intent.notification_intent_id}?tenant_id=${tenantId}`
    ),
    enabled: open,
    staleTime: 60_000,
  });

  return (
    <>
      <tr
        className="hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
        onClick={() => setOpen(o => !o)}
      >
        <td className="px-4 py-2.5">
          {open ? <ChevronDown size={12} className="text-[var(--text-muted)]" /> : <ChevronRight size={12} className="text-[var(--text-muted)]" />}
        </td>
        <td className="px-2 py-2.5">
          <Badge variant={stateVariant(intent.current_state)}>
            {intent.current_state ?? "unknown"}
          </Badge>
        </td>
        <td className="px-2 py-2.5 font-mono text-[11px] text-[var(--text-muted)] truncate max-w-[140px]">
          {intent.alert_id}
        </td>
        <td className="px-2 py-2.5 text-[11px]">{intent.reason}</td>
        <td className="px-2 py-2.5 text-[11px] text-[var(--text-muted)] truncate max-w-[160px]">
          {intent.destination_ref}
        </td>
        <td className="px-2 py-2.5 text-[11px] text-[var(--text-muted)] whitespace-nowrap">
          {fmtTs2(intent.created_at)}
        </td>
        <td className="px-2 py-2.5 text-center text-[11px]">
          {intent.attempt_count ?? 0}
          {intent.retry_required && <span className="text-[var(--brand)] ml-1">↺</span>}
        </td>
      </tr>
      {open && (
        <tr>
          <td colSpan={7} className="px-4 pb-3 bg-[var(--surface-2)]">
            {detailQ.isLoading ? (
              <div className="py-2"><Spinner className="w-4 h-4" /></div>
            ) : detailQ.isError ? (
              <p className="text-[11px] text-[var(--red)]">Falha ao carregar detalhes.</p>
            ) : (
              <div className="flex gap-6 py-2">
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Tentativas</div>
                  {(detailQ.data?.attempts ?? []).length === 0 ? (
                    <div className="text-[11px] text-[var(--text-muted)]">Nenhuma tentativa</div>
                  ) : (
                    <div className="space-y-1">
                      {(detailQ.data?.attempts ?? []).map(a => (
                        <div key={a.notification_attempt_id} className="text-[11px] flex gap-3">
                          <span className="text-[var(--text-muted)]">#{a.attempt_number}</span>
                          <Badge variant={a.outcome === "success" ? "success" : a.outcome === "failure" ? "danger" : "muted"}>
                            {a.outcome}
                          </Badge>
                          {a.failure_class && <span className="text-[var(--red)] text-[10px]">{a.failure_class}</span>}
                          <span className="text-[var(--text-muted)]">{fmtTs2(a.started_at)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                {(detailQ.data?.evidence ?? []).length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-[var(--text-muted)] mb-1">Evidências</div>
                    <div className="space-y-1">
                      {(detailQ.data?.evidence ?? []).map(ev => (
                        <div key={ev.notification_evidence_id} className="text-[11px] flex gap-3">
                          <Badge variant={ev.normalized_state === "delivered" ? "success" : "muted"}>{ev.normalized_state}</Badge>
                          <span className="text-[var(--text-muted)]">{fmtTs2(ev.observed_at)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

function DeliveryLog({ tenantId }: { tenantId: string }) {
  const q = useQuery({
    queryKey: ["notifications-log", tenantId],
    queryFn: () => api.get<NotificationIntent[]>(
      `/api/v1/alerting/notifications?limit=50&tenant_id=${tenantId}`
    ),
    refetchInterval: 30_000,
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">Últimas 50 entregas de notificação.</p>
        <button onClick={() => q.refetch()} className="text-[var(--text-muted)] hover:text-[var(--text)]">
          <RefreshCw size={13} />
        </button>
      </div>
      <Card className="p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)] p-4">Falha ao carregar histórico.</p>
        ) : (q.data ?? []).length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] p-4">Nenhuma entrega registrada ainda.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)]">
                <th className="px-4 py-2.5 w-6" />
                <th className="px-2 py-2.5 font-medium">Estado</th>
                <th className="px-2 py-2.5 font-medium">Alert ID</th>
                <th className="px-2 py-2.5 font-medium">Motivo</th>
                <th className="px-2 py-2.5 font-medium">Destino</th>
                <th className="px-2 py-2.5 font-medium">Criado em</th>
                <th className="px-2 py-2.5 font-medium text-center">Tentativas</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {(q.data ?? []).map(intent => (
                <DeliveryRow key={intent.notification_intent_id} intent={intent} tenantId={tenantId} />
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

export function NotificationChannelsPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const canOperate = useCanOperate();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<"channels" | "log">("channels");
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [testingId, setTestingId] = useState<string | null>(null);

  async function runTest(dest: Destination) {
    setTestingId(dest.destination_config_id);
    try {
      const res = await api.post<{ ok: boolean; message: string }>(
        `/api/v1/alerting/notification-channels/${dest.destination_config_id}/test`,
        {},
      );
      toast(res.message ?? "Mensagem de teste enviada.", "success");
    } catch (e: unknown) {
      const detail =
        (e as { detail?: string; message?: string })?.detail ??
        (e as Error)?.message ??
        "Falha ao enviar teste.";
      toast("Erro: " + detail, "error");
    } finally {
      setTestingId(null);
    }
  }

  const q = useQuery({
    queryKey: ["notification-channels", tenantId],
    queryFn: () =>
      api.get<Destination[]>("/api/v1/alerting/notification-channels"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) =>
      api.delete(`/api/v1/alerting/notification-channels/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["notification-channels", tenantId] });
      setDeletingId(null);
      toast("Canal removido", "success");
    },
    onError: (e: Error) => {
      toast("Erro: " + (e.message ?? "Falha ao remover canal."), "error");
    },
  });

  const destinations = q.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Canais de Notificação</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Destinos configurados para alertas e notificações de incidentes.
          </p>
        </div>
        {tab === "channels" && canOperate && !adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Adicionar destino
          </Button>
        )}
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        {(["channels", "log"] as const).map(tabKey => (
          <button
            key={tabKey}
            onClick={() => setTab(tabKey)}
            className={`px-3 py-1.5 text-[12px] font-medium border-b-2 transition-colors ${
              tab === tabKey
                ? "border-[var(--brand)] text-[var(--text)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {tabKey === "channels" ? t("nav.channels") : t("channels.logTitle")}
          </button>
        ))}
      </div>

      {tab === "log" ? (
        <DeliveryLog tenantId={tenantId} />
      ) : (
        <>
      {canOperate && adding && (
        <AddDestinationForm
          tenantId={tenantId}
          onDone={() => setAdding(false)}
        />
      )}

      <Card className="p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)] p-4">{t("channels.loadError")}</p>
        ) : destinations.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] p-4">
            Nenhum destino configurado. Adicione um para habilitar notificações via Email, WhatsApp ou Slack.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="px-4 py-2.5 font-medium">{t("channels.colChannel")}</th>
                <th className="px-4 py-2.5 font-medium">{t("channels.colLabel")}</th>
                <th className="px-4 py-2.5 font-medium">{t("channels.colDest")}</th>
                <th className="px-4 py-2.5 font-medium">{t("channels.colAdded")}</th>
                <th className="px-4 py-2.5 font-medium"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {destinations.map((d) => {
                const removing =
                  deleteMut.isPending &&
                  deleteMut.variables === d.destination_config_id;
                return (
                  <tr key={d.destination_config_id}
                    className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5">
                      <Badge variant={channelVariant(d.channel_class)}>
                        {CHANNEL_LABELS[d.channel_class] ?? d.channel_class}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 font-medium text-[var(--text)]">
                      {d.label}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] font-mono">
                      {d.destination_ref}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtTs(d.created_at)}
                    </td>
                    <td className="px-4 py-2.5">
                      <div className="flex items-center gap-3">
                        {d.channel_class === "slack@1" && canOperate && (
                          <button
                            onClick={() => runTest(d)}
                            disabled={testingId === d.destination_config_id}
                            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--brand)] underline disabled:opacity-40"
                          >
                            {testingId === d.destination_config_id ? "enviando…" : "testar"}
                          </button>
                        )}
                        {canOperate && (
                          <button
                            onClick={() => setDeletingId(d.destination_config_id)}
                            disabled={removing}
                            className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline disabled:opacity-40"
                          >
                            {removing ? t("channels.removing") : "remover"}
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {deletingId && (
        <ConfirmModal
          title="Remover canal"
          description={`Tem certeza que deseja remover "${destinations.find((d) => d.destination_config_id === deletingId)?.label ?? deletingId}"? Esta ação não pode ser desfeita.`}
          confirmLabel="Remover canal"
          destructive
          isPending={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate(deletingId)}
          onCancel={() => setDeletingId(null)}
        />
      )}
        </>
      )}
    </div>
  );
}
