import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

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
}

interface Transition {
  alert_transition_id: string;
  from_lifecycle_state: string;
  to_lifecycle_state: string;
  source_revision: number;
  occurred_at: string;
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
  const q = useQuery({
    queryKey: ["alert", alertId],
    queryFn: () =>
      api.get<{ alert: AlertFull; transitions: Transition[] }>(
        `/api/v1/alerting/alerts/${alertId}`,
      ),
  });

  if (q.isLoading) {
    return <div className="flex justify-center py-12"><Spinner /></div>;
  }

  if (q.isError || !q.data) {
    return (
      <div>
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">← Back</Button>
        <p className="text-xs text-[var(--red)]">Failed to load alert.</p>
      </div>
    );
  }

  const a = q.data.alert;
  const transitions = q.data.transitions;
  const ev = a.source_evidence_summary;
  const sevClass = ev?.severity_class as string | undefined;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onBack}
          className="text-xs text-[var(--brand)] cursor-pointer hover:underline bg-none border-none p-0"
        >
          ← Alerts
        </button>
        <h2 className="text-sm font-semibold font-mono truncate">{a.alert_id}</h2>
        <Badge variant={sevVariant(sevClass)}>
          {(sevClass ?? "unknown").toUpperCase()}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <Card>
          <CardHeader><span className="text-sm font-medium">Details</span></CardHeader>
          <dl>
            <KV label="State" value={a.lifecycle_state} />
            <KV label="Source kind" value={a.source_kind} />
            <KV label="Policy" value={`${a.policy_id} v${a.policy_version}`} />
            <KV label="Monitoring source" value={a.monitoring_source_id} />
            <KV label="Resource" value={a.monitoring_resource_id} />
            <KV label="Opened" value={fmtTs(a.opened_at)} />
            <KV label="Resolved" value={a.resolved_at ? fmtTs(a.resolved_at) : "—"} />
          </dl>
        </Card>

        <Card>
          <CardHeader><span className="text-sm font-medium">Evidence summary</span></CardHeader>
          <pre className="text-[10px] text-[var(--text-muted)] overflow-x-auto whitespace-pre-wrap break-all">
            {JSON.stringify(ev, null, 2)}
          </pre>
        </Card>
      </div>

      {transitions.length > 0 && (
        <Card>
          <CardHeader><span className="text-sm font-medium">Lifecycle transitions</span></CardHeader>
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
    </div>
  );
}
