import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";

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
      toast("Canal adicionado com sucesso.", "success");
      onDone();
    },
    onError: (e: unknown) => {
      const detail = (e as { detail?: string })?.detail;
      setErr(detail ?? "Falha ao adicionar canal.");
    },
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium">Add notification destination</h3>

      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">Channel</label>
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
        <label className="text-xs text-[var(--text-muted)]">
          {channel === "email_smtp@1"
            ? "Email address"
            : channel === "slack@1"
            ? "Webhook URL"
            : "Phone / destination ref"}
        </label>
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
        <label className="text-xs text-[var(--text-muted)]">Label</label>
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
          Add
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

export function NotificationChannelsPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [adding, setAdding] = useState(false);

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
      toast("Canal removido.", "info");
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
        {!adding && (
          <Button size="sm" onClick={() => setAdding(true)}>
            Add destination
          </Button>
        )}
      </div>

      {adding && (
        <AddDestinationForm
          tenantId={tenantId}
          onDone={() => setAdding(false)}
        />
      )}

      <Card className="p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)] p-4">Failed to load channels.</p>
        ) : destinations.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] p-4">
            No destinations configured. Add one to enable email or WhatsApp notifications.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="px-4 py-2.5 font-medium">Channel</th>
                <th className="px-4 py-2.5 font-medium">Label</th>
                <th className="px-4 py-2.5 font-medium">Destination</th>
                <th className="px-4 py-2.5 font-medium">Added</th>
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
                      <button
                        onClick={() =>
                          deleteMut.mutate(d.destination_config_id)
                        }
                        disabled={removing}
                        className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline disabled:opacity-40"
                      >
                        {removing ? "removing…" : "remove"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
