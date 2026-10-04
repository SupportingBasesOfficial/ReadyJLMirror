import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { AlertDetail } from "./AlertDetail";

interface RawAlert {
  alert_id: string;
  lifecycle_state: string;
  source_kind: string;
  monitoring_source_id: string;
  monitoring_resource_id: string;
  source_evidence_summary: { severity_class?: string; problem_id?: string; health_classes?: string[] };
  opened_at: string;
  resolved_at?: string;
  snoozed_until?: string;
}

const SNOOZE_OPTIONS = [
  { label: "30 min", value: 30 },
  { label: "1 hour", value: 60 },
  { label: "4 hours", value: 240 },
  { label: "8 hours", value: 480 },
  { label: "24 hours", value: 1440 },
];

function sevVariant(cls?: string): "danger" | "warning" | "info" | "muted" {
  if (cls === "critical") return "danger";
  if (cls === "degraded" || cls === "warning") return "warning";
  if (cls === "informational") return "info";
  return "muted";
}

function lcVariant(state: string): "warning" | "success" | "muted" {
  if (state === "active") return "warning";
  if (state === "resolved") return "success";
  return "muted";
}

function alertTitle(a: RawAlert): string {
  const ev = a.source_evidence_summary;
  if (ev?.problem_id) return ev.problem_id;
  if (ev?.health_classes?.length) return ev.health_classes.join(", ");
  return a.monitoring_resource_id || a.source_kind;
}

function fmtTs(iso?: string) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtSnoozeExpiry(iso: string): string {
  try {
    const diffMin = Math.round((new Date(iso).getTime() - Date.now()) / 60_000);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.round(diffMin / 60);
    if (diffHr < 24) return `${diffHr}h`;
    return `${Math.round(diffHr / 24)}d`;
  } catch {
    return "";
  }
}

function SnoozeControl({
  alert,
  onSnooze,
  onUnsnooze,
  isBusy,
}: {
  alert: RawAlert;
  onSnooze: (minutes: number) => void;
  onUnsnooze: () => void;
  isBusy: boolean;
}) {
  const [open, setOpen] = useState(false);

  if (alert.snoozed_until) {
    return (
      <div className="flex items-center gap-1.5">
        <Badge variant="warning">
          snoozed {fmtSnoozeExpiry(alert.snoozed_until)}
        </Badge>
        <button
          onClick={(e) => { e.stopPropagation(); onUnsnooze(); }}
          disabled={isBusy}
          className="text-[10px] text-[var(--text-muted)] underline hover:text-[var(--text)] disabled:opacity-40"
        >
          cancel
        </button>
      </div>
    );
  }

  if (open) {
    return (
      <div
        className="flex items-center gap-1 flex-wrap"
        onClick={(e) => e.stopPropagation()}
      >
        {SNOOZE_OPTIONS.map((opt) => (
          <button
            key={opt.value}
            onClick={() => { onSnooze(opt.value); setOpen(false); }}
            disabled={isBusy}
            className="px-2 py-0.5 rounded text-[10px] bg-[var(--surface-2)] border border-[var(--border)] hover:border-[var(--brand)] hover:text-[var(--brand)] disabled:opacity-40 transition-colors"
          >
            {opt.label}
          </button>
        ))}
        <button
          onClick={() => setOpen(false)}
          className="text-[10px] text-[var(--text-muted)] px-1"
        >
          ✕
        </button>
      </div>
    );
  }

  return (
    <Button
      variant="secondary"
      size="sm"
      onClick={(e: React.MouseEvent) => { e.stopPropagation(); setOpen(true); }}
      disabled={isBusy}
    >
      Snooze
    </Button>
  );
}

function loadAlertFilter(tenantId: string): "active" | "all" {
  try {
    const v = localStorage.getItem(`jlm_alerts_filter_${tenantId}`);
    return (v === "all" ? "all" : "active");
  } catch { return "active"; }
}

export function AlertsPage({ tenantId }: { tenantId: string }) {
  const [filter, setFilter] = useState<"active" | "all">(() => loadAlertFilter(tenantId));

  const setAndSaveFilter = (v: "active" | "all") => {
    setFilter(v);
    try { localStorage.setItem(`jlm_alerts_filter_${tenantId}`, v); } catch { /* */ }
  };
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["alerts", tenantId, filter],
    queryFn: () =>
      api.get<RawAlert[]>(
        `/api/v1/alerting/alerts${filter === "active" ? "?lifecycle_state=active" : ""}`,
      ),
    refetchInterval: 30_000,
  });

  const snoozeMut = useMutation({
    mutationFn: ({ alertId, minutes }: { alertId: string; minutes: number }) =>
      api.post(`/api/v1/alerting/alerts/${alertId}/snooze`, {
        duration_minutes: minutes,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const unsnoozeMut = useMutation({
    mutationFn: (alertId: string) =>
      api.post(`/api/v1/alerting/alerts/${alertId}/unsnooze`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alerts"] }),
  });

  const alerts = q.data ?? [];

  if (selectedId) {
    return (
      <AlertDetail
        tenantId={tenantId}
        alertId={selectedId}
        onBack={() => setSelectedId(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">Alerts</h2>
        <div className="flex gap-1.5">
          {(["active", "all"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setAndSaveFilter(f)}
              className={[
                "px-3 py-1 rounded-full text-xs cursor-pointer border transition-colors",
                filter === f
                  ? "border-[var(--brand)] text-[var(--brand)] bg-[var(--surface-2)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)]",
              ].join(" ")}
            >
              {f === "active" ? "Active" : "All"}
            </button>
          ))}
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        {q.isLoading ? (
          <div className="flex justify-center py-8"><Spinner /></div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)] p-4">Failed to load alerts.</p>
        ) : alerts.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] p-4">No alerts.</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="px-4 py-2.5 font-medium">Severity</th>
                <th className="px-4 py-2.5 font-medium">Event / Resource</th>
                <th className="px-4 py-2.5 font-medium">State</th>
                <th className="px-4 py-2.5 font-medium">Source</th>
                <th className="px-4 py-2.5 font-medium">Opened</th>
                <th className="px-4 py-2.5 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {alerts.map((a) => {
                const busy =
                  (snoozeMut.isPending &&
                    (snoozeMut.variables as { alertId: string } | undefined)?.alertId === a.alert_id) ||
                  (unsnoozeMut.isPending && unsnoozeMut.variables === a.alert_id);
                return (
                  <tr
                    key={a.alert_id}
                    onClick={() => setSelectedId(a.alert_id)}
                    className="hover:bg-[var(--surface-2)] cursor-pointer transition-colors"
                  >
                    <td className="px-4 py-2.5">
                      <Badge variant={sevVariant(a.source_evidence_summary?.severity_class)}>
                        {(a.source_evidence_summary?.severity_class ?? "unknown").toUpperCase()}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text)] max-w-[200px] truncate font-mono text-[10px]">
                      {alertTitle(a)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={lcVariant(a.lifecycle_state)}>{a.lifecycle_state}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] max-w-[120px] truncate font-mono text-[10px]">
                      {a.monitoring_source_id}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtTs(a.opened_at)}
                    </td>
                    <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                      {a.lifecycle_state === "active" && (
                        <SnoozeControl
                          alert={a}
                          onSnooze={(minutes) =>
                            snoozeMut.mutate({ alertId: a.alert_id, minutes })
                          }
                          onUnsnooze={() => unsnoozeMut.mutate(a.alert_id)}
                          isBusy={busy}
                        />
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>

      {q.isFetching && !q.isLoading && (
        <div className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          <Spinner className="w-3 h-3" /> Refreshing…
        </div>
      )}
    </div>
  );
}
