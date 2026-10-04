import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface MaintenanceWindow {
  window_id: string;
  label: string;
  source_ids: string[] | null;
  starts_at: string;
  ends_at: string;
  created_by: string;
  created_at: string;
  active: boolean;
}

function fmtDT(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  });
}

function toLocalInput(iso: string): string {
  // Converts UTC ISO to local datetime-local input value
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function nowPlusMinutes(mins: number): string {
  return toLocalInput(new Date(Date.now() + mins * 60_000).toISOString());
}

function statusVariant(w: MaintenanceWindow): "success" | "muted" {
  return w.active ? "success" : "muted";
}

export function MaintenancePage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [label, setLabel] = useState("");
  const [sourceIdsRaw, setSourceIdsRaw] = useState("");
  const [startsAt, setStartsAt] = useState(nowPlusMinutes(0));
  const [endsAt, setEndsAt] = useState(nowPlusMinutes(60));
  const [formErr, setFormErr] = useState<string | null>(null);

  const { data: windows = [], isLoading, isError } = useQuery<MaintenanceWindow[]>({
    queryKey: ["maintenance-windows", tenantId],
    queryFn: () =>
      api.get<MaintenanceWindow[]>(`/api/v1/maintenance/windows?tenant_id=${tenantId}`),
    refetchInterval: 30_000,
  });

  const createMut = useMutation({
    mutationFn: (body: object) =>
      api.post<MaintenanceWindow>("/api/v1/maintenance/windows", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["maintenance-windows"] });
      setShowForm(false);
      resetForm();
    },
    onError: (e: unknown) => {
      const msg = (e as Error)?.message;
      setFormErr(msg ?? "Failed to create window");
    },
  });

  const cancelMut = useMutation({
    mutationFn: (windowId: string) =>
      api.delete<{ window_id: string; cancelled: boolean }>(
        `/api/v1/maintenance/windows/${windowId}?tenant_id=${tenantId}`
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["maintenance-windows"] }),
  });

  function resetForm() {
    setLabel("");
    setSourceIdsRaw("");
    setStartsAt(nowPlusMinutes(0));
    setEndsAt(nowPlusMinutes(60));
    setFormErr(null);
  }

  function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setFormErr(null);
    const source_ids =
      sourceIdsRaw.trim() === ""
        ? null
        : sourceIdsRaw
            .split(/[\n,]+/)
            .map((s) => s.trim())
            .filter(Boolean);
    const starts = new Date(startsAt).toISOString();
    const ends = new Date(endsAt).toISOString();
    if (new Date(ends) <= new Date(starts)) {
      setFormErr("End time must be after start time");
      return;
    }
    createMut.mutate({
      tenant_id: tenantId,
      label,
      source_ids,
      starts_at: starts,
      ends_at: ends,
    });
  }

  const active = windows.filter((w) => w.active);
  const upcoming = windows.filter((w) => !w.active);

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">Maintenance Windows</h1>
          <p className="text-sm text-[var(--muted)] mt-0.5">
            Alert notifications are suppressed for sources during active windows.
            Alerts still fire — only delivery is muted.
          </p>
        </div>
        {!showForm && (
          <Button onClick={() => { setShowForm(true); resetForm(); }}>
            + New Window
          </Button>
        )}
      </div>

      {/* Create form */}
      {showForm && (
        <Card>
          <form onSubmit={handleCreate} className="p-4 space-y-4">
            <h2 className="font-semibold">New Maintenance Window</h2>

            <div className="space-y-1">
              <label className="text-sm font-medium">Label *</label>
              <input
                className="w-full border border-[var(--border)] rounded px-2 py-1.5 text-sm bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                placeholder="e.g. Planned DB upgrade"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                required
              />
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium">
                Source IDs{" "}
                <span className="text-[var(--muted)]">(comma-separated, blank = all sources)</span>
              </label>
              <textarea
                className="w-full border border-[var(--border)] rounded px-2 py-1.5 text-sm bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)] font-mono"
                rows={2}
                placeholder="mon-src-abc, mon-src-def"
                value={sourceIdsRaw}
                onChange={(e) => setSourceIdsRaw(e.target.value)}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-1">
                <label className="text-sm font-medium">Starts at *</label>
                <input
                  type="datetime-local"
                  className="w-full border border-[var(--border)] rounded px-2 py-1.5 text-sm bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                  value={startsAt}
                  onChange={(e) => setStartsAt(e.target.value)}
                  required
                />
              </div>
              <div className="space-y-1">
                <label className="text-sm font-medium">Ends at *</label>
                <input
                  type="datetime-local"
                  className="w-full border border-[var(--border)] rounded px-2 py-1.5 text-sm bg-[var(--surface)] focus:outline-none focus:ring-1 focus:ring-[var(--brand)]"
                  value={endsAt}
                  onChange={(e) => setEndsAt(e.target.value)}
                  required
                />
              </div>
            </div>

            {formErr && (
              <p className="text-sm text-red-500">{formErr}</p>
            )}

            <div className="flex gap-2">
              <Button type="submit" disabled={createMut.isPending || !label}>
                {createMut.isPending ? "Creating…" : "Create"}
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowForm(false)}
              >
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {isLoading && <Spinner />}
      {isError && (
        <p className="text-sm text-red-500">Failed to load maintenance windows.</p>
      )}

      {/* Active windows */}
      {active.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide">
            Active
          </h2>
          {active.map((w) => (
            <WindowCard
              key={w.window_id}
              window={w}
              onCancel={() => cancelMut.mutate(w.window_id)}
              cancelling={cancelMut.isPending}
            />
          ))}
        </section>
      )}

      {/* Upcoming windows */}
      {upcoming.length > 0 && (
        <section className="space-y-2">
          <h2 className="text-sm font-semibold text-[var(--muted)] uppercase tracking-wide">
            Upcoming
          </h2>
          {upcoming.map((w) => (
            <WindowCard
              key={w.window_id}
              window={w}
              onCancel={() => cancelMut.mutate(w.window_id)}
              cancelling={cancelMut.isPending}
            />
          ))}
        </section>
      )}

      {!isLoading && windows.length === 0 && (
        <p className="text-sm text-[var(--muted)]">
          No maintenance windows. Active and upcoming windows appear here.
        </p>
      )}
    </div>
  );
}

function WindowCard({
  window: w,
  onCancel,
  cancelling,
}: {
  window: MaintenanceWindow;
  onCancel: () => void;
  cancelling: boolean;
}) {
  return (
    <Card>
      <div className="p-4 flex items-start justify-between gap-4">
        <div className="flex-1 min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            <span className="font-medium truncate">{w.label}</span>
            <Badge variant={statusVariant(w)}>
              {w.active ? "active" : "upcoming"}
            </Badge>
          </div>
          <p className="text-xs text-[var(--muted)]">
            {fmtDT(w.starts_at)} → {fmtDT(w.ends_at)}
          </p>
          {w.source_ids ? (
            <p className="text-xs text-[var(--muted)] font-mono truncate">
              Sources: {w.source_ids.join(", ")}
            </p>
          ) : (
            <p className="text-xs text-[var(--muted)]">All sources</p>
          )}
          <p className="text-xs text-[var(--muted)]">
            Created by {w.created_by} · {fmtDT(w.created_at)}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={onCancel}
          disabled={cancelling}
        >
          Cancel
        </Button>
      </div>
    </Card>
  );
}
