import { useState, useEffect, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";

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

const PAGE_SIZE = 50;

// Known actions across the system — merged with dynamic values from the current page.
// Update this list as new action types are added to the backend.
const KNOWN_ACTIONS = [
  "alert.acknowledged",
  "alert.created",
  "alert.escalated",
  "alert.resolved",
  "alert.snoozed",
  "apikey.created",
  "apikey.revoked",
  "automation.run.created",
  "automation.run.failed",
  "automation.run.succeeded",
  "escalation.policy.created",
  "escalation.policy.updated",
  "itsm.change.approved",
  "itsm.change.created",
  "itsm.change.rejected",
  "itsm.change.updated",
  "maintenance.window.created",
  "maintenance.window.deleted",
  "member.invited",
  "member.removed",
  "notification.channel.created",
  "notification.channel.deleted",
  "policy.created",
  "policy.deleted",
  "policy.updated",
  "report.generated",
  "sla.breach.detected",
  "tenant.settings.updated",
];

// Known subject types across the system — merged with dynamic values from the current page.
const KNOWN_SUBJECT_TYPES = [
  "alert",
  "alert_policy",
  "api_key",
  "automation_run",
  "automation_script",
  "change_request",
  "escalation_policy",
  "host",
  "itsm_change",
  "maintenance_window",
  "member",
  "monitoring_source",
  "notification_channel",
  "report",
  "sla_agreement",
  "tenant",
  "user",
];

export function AuditPage({ tenantId }: { tenantId: string }) {
  const [filterAction, setFilterAction] = useState("");
  const [filterSubjectType, setFilterSubjectType] = useState("");
  const [actorFilter, setActorFilter] = useState("");
  const [debouncedActorFilter, setDebouncedActorFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [expanded, setExpanded] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [exporting, setExporting] = useState(false);
  const { toast } = useToast();

  // Debounce actor filter by 500ms to avoid firing a request on every keystroke
  useEffect(() => {
    const t = setTimeout(() => setDebouncedActorFilter(actorFilter), 500);
    return () => clearTimeout(t);
  }, [actorFilter]);

  const params = new URLSearchParams({ limit: String(PAGE_SIZE), offset: String(page * PAGE_SIZE) });
  if (filterAction) params.set("action", filterAction);
  if (filterSubjectType) params.set("subject_type", filterSubjectType);
  if (debouncedActorFilter) params.set("actor_id", debouncedActorFilter);
  if (dateFrom) params.set("occurred_after", `${dateFrom}T00:00:00Z`);
  if (dateTo) params.set("occurred_before", `${dateTo}T23:59:59Z`);

  const q = useQuery({
    queryKey: [
      "audit-events",
      tenantId,
      filterAction,
      filterSubjectType,
      debouncedActorFilter,
      dateFrom,
      dateTo,
      page,
    ],
    queryFn: () => api.get<AuditEvent[]>(`/api/v1/observability/audit-events?${params}`),
    refetchInterval: 60_000,
  });

  useEffect(() => {
    if (q.isError) toast("Erro ao carregar auditoria", "error");
  }, [q.isError]);

  const events = q.data ?? [];
  const hasNext = events.length === PAGE_SIZE;

  // Merge hardcoded known values with any new values observed on the current page
  const actions = Array.from(new Set([...KNOWN_ACTIONS, ...events.map((e) => e.action)])).sort();
  const subjectTypes = Array.from(
    new Set([...KNOWN_SUBJECT_TYPES, ...events.map((e) => e.subject_type)])
  ).sort();

  const handleExportCSV = async () => {
    setExporting(true);
    try {
      const exportParams = new URLSearchParams();
      if (filterAction) exportParams.set("action", filterAction);
      if (filterSubjectType) exportParams.set("subject_type", filterSubjectType);
      if (debouncedActorFilter) exportParams.set("actor_id", debouncedActorFilter);
      if (dateFrom) exportParams.set("occurred_after", `${dateFrom}T00:00:00Z`);
      if (dateTo) exportParams.set("occurred_before", `${dateTo}T23:59:59Z`);

      const response = await fetch(
        `/api/v1/observability/audit-events/export?${exportParams}`,
        { credentials: "include" }
      );
      if (!response.ok) throw new Error("Export failed");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `audit-export-${new Date().toISOString().slice(0, 10)}.csv`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      toast("Erro ao exportar", "error");
    } finally {
      setExporting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Audit trail</h2>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Append-only · tenant-scoped · newest first
          </p>
        </div>
        <div className="flex items-center gap-2">
          {q.isFetching && <Spinner className="w-3 h-3" />}
          <Button
            size="sm"
            variant="secondary"
            onClick={handleExportCSV}
            disabled={exporting}
          >
            {exporting && <Spinner className="w-3 h-3 mr-1" />}
            Exportar CSV
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex gap-2 flex-wrap items-center">
        {/* Date range */}
        <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
          De
          <input
            type="date"
            value={dateFrom}
            onChange={(e) => { setDateFrom(e.target.value); setPage(0); }}
            className="text-xs px-2 py-1 rounded border border-[var(--border)]
              bg-[var(--surface-2)] text-[var(--text)] cursor-pointer"
          />
        </label>
        <label className="flex items-center gap-1 text-xs text-[var(--text-muted)]">
          Até
          <input
            type="date"
            value={dateTo}
            onChange={(e) => { setDateTo(e.target.value); setPage(0); }}
            className="text-xs px-2 py-1 rounded border border-[var(--border)]
              bg-[var(--surface-2)] text-[var(--text)] cursor-pointer"
          />
        </label>

        {/* Actor filter (debounced 500ms) */}
        <input
          type="text"
          placeholder="Filtrar por ator (ID ou email)"
          value={actorFilter}
          onChange={(e) => { setActorFilter(e.target.value); setPage(0); }}
          className="text-xs px-2 py-1 rounded border border-[var(--border)]
            bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--text-muted)] min-w-[220px]"
        />

        <select
          value={filterAction}
          onChange={(e) => { setFilterAction(e.target.value); setPage(0); }}
          className="text-xs px-2 py-1 rounded border border-[var(--border)]
            bg-[var(--surface-2)] text-[var(--text)] cursor-pointer"
        >
          <option value="">Todos os actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
        <select
          value={filterSubjectType}
          onChange={(e) => { setFilterSubjectType(e.target.value); setPage(0); }}
          className="text-xs px-2 py-1 rounded border border-[var(--border)]
            bg-[var(--surface-2)] text-[var(--text)] cursor-pointer"
        >
          <option value="">Todos os subjects</option>
          {subjectTypes.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <span className="text-xs text-[var(--text-muted)] ml-1">
          {events.length} eventos · página {page + 1}
        </span>
      </div>

      {/* Table */}
      {q.isLoading ? (
        <Spinner className="w-5 h-5" />
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Could not load audit events.</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">
          {page > 0 ? "Nenhum evento nesta página." : "No audit events found."}
        </p>
      ) : (
        <>
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
                  <Fragment key={ev.audit_event_id}>
                    <tr
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
                  </Fragment>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Pagination */}
          <div className="flex items-center justify-between">
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => Math.max(0, p - 1))}
              disabled={page === 0 || q.isFetching}
            >
              ← Anterior
            </Button>
            <span className="text-xs text-[var(--text-muted)]">Página {page + 1}</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={() => setPage((p) => p + 1)}
              disabled={!hasNext || q.isFetching}
            >
              Próxima →
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
