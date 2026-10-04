import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

interface AuditEvent {
  audit_event_id: string;
  action: string;
  actor_kind: string;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  detail: Record<string, unknown>;
  correlation_id: string | null;
  occurred_at: string;
}

const ACTOR_VARIANTS: Record<string, "success" | "warning" | "danger" | "muted"> = {
  principal: "success",
  platform_admin: "warning",
  operator: "warning",
  system: "muted",
  worker: "muted",
  delegated_principal: "success",
};

function fmt(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  });
}

export function AuditPage({ tenantId: _tenantId }: { tenantId: string }) {
  const [filterAction, setFilterAction] = useState("");
  const [filterSubjectType, setFilterSubjectType] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);

  const params = new URLSearchParams({ limit: "100" });
  if (filterAction) params.set("action", filterAction);
  if (filterSubjectType) params.set("subject_type", filterSubjectType);

  const q = useQuery({
    queryKey: ["audit-events", filterAction, filterSubjectType],
    queryFn: () => api.get<AuditEvent[]>(`/api/v1/observability/audit-events?${params}`),
    refetchInterval: 60_000,
  });

  const events = q.data ?? [];

  const actions = Array.from(new Set(events.map((e) => e.action))).sort();
  const subjectTypes = Array.from(new Set(events.map((e) => e.subject_type))).sort();

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Audit trail</h2>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Append-only · tenant-scoped · newest first
          </p>
        </div>
        {q.isFetching && <Spinner className="w-3 h-3" />}
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap">
        <select
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-[var(--border)]
            bg-[var(--surface-2)] text-[var(--text)] cursor-pointer"
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={filterSubjectType}
          onChange={(e) => setFilterSubjectType(e.target.value)}
          className="text-xs px-2 py-1 rounded border border-[var(--border)]
            bg-[var(--surface-2)] text-[var(--text)] cursor-pointer"
        >
          <option value="">All subjects</option>
          {subjectTypes.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className="text-xs text-[var(--text-muted)] self-center ml-1">
          {events.length} events
        </span>
      </div>

      {/* Table */}
      {q.isLoading ? (
        <Spinner className="w-5 h-5" />
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Could not load audit events.</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No audit events found.</p>
      ) : (
        <Card className="overflow-x-auto p-0">
          <table className="w-full text-xs min-w-[640px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th className="text-left px-3 py-2 font-medium">Time</th>
                <th className="text-left px-3 py-2 font-medium">Action</th>
                <th className="text-left px-3 py-2 font-medium">Actor</th>
                <th className="text-left px-3 py-2 font-medium">Subject</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <>
                  <tr
                    key={ev.audit_event_id}
                    onClick={() =>
                      setExpanded(
                        expanded === ev.audit_event_id ? null : ev.audit_event_id
                      )
                    }
                    className="border-b border-[var(--border)] hover:bg-[var(--surface-2)]
                      cursor-pointer transition-colors"
                  >
                    <td className="px-3 py-2 font-mono text-[var(--text-muted)] whitespace-nowrap">
                      {fmt(ev.occurred_at)}
                    </td>
                    <td className="px-3 py-2 font-mono text-[var(--brand)]">
                      {ev.action}
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-1.5">
                        <Badge variant={ACTOR_VARIANTS[ev.actor_kind] ?? "muted"}>
                          {ev.actor_kind}
                        </Badge>
                        {ev.actor_id && (
                          <span className="text-[var(--text-muted)] truncate max-w-[140px]">
                            {ev.actor_id}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <span className="text-[var(--text-muted)] mr-1.5">{ev.subject_type}</span>
                      <span className="font-mono truncate">{ev.subject_id}</span>
                    </td>
                  </tr>
                  {expanded === ev.audit_event_id && (
                    <tr key={`${ev.audit_event_id}-detail`} className="bg-[var(--surface-2)]">
                      <td colSpan={4} className="px-3 py-2">
                        <pre className="text-[10px] text-[var(--text-muted)] overflow-x-auto whitespace-pre-wrap break-all">
                          {JSON.stringify(
                            {
                              audit_event_id: ev.audit_event_id,
                              correlation_id: ev.correlation_id,
                              detail: ev.detail,
                            },
                            null,
                            2
                          )}
                        </pre>
                      </td>
                    </tr>
                  )}
                </>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
