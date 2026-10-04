import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";

interface Entitlement {
  entitlement_id: string;
  capability: string;
  state: string;
}

interface MeterSnapshot {
  meter: string;
  quantity: number;
  window_end: string;
}

interface Contract {
  contract_id: string;
  plan_ref: string | null;
  state: string;
  effective_from: string | null;
  effective_until: string | null;
}

interface Summary {
  tenant_id: string;
  contract: Contract | null;
  entitlements: Entitlement[];
  meter_snapshot: MeterSnapshot[];
}

interface UsageRow {
  usage_id: string;
  meter: string;
  quantity: number;
  window_start: string;
  window_end: string;
}

function capLabel(cap: string) {
  return { monitoring: "Monitoring", alerting: "Alerting", itsm: "ITSM", aiops: "AIOps" }[cap] ?? cap;
}

function meterLabel(m: string) {
  return {
    monitoring_sources_active: "Sources active",
    monitoring_resources_observed: "Resources observed",
    alerting_alerts_active: "Alerts active",
    alert_transitions_24h: "Alert transitions (24 h)",
    aiops_findings_active: "AIOps findings active",
  }[m] ?? m;
}

function fmtTs(iso?: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

interface BillingStatus {
  adapter: string;
  status: string;
  detail: string | null;
}

export function FinOpsPage({ tenantId }: { tenantId: string }) {
  const summaryQ = useQuery({
    queryKey: ["finops-summary", tenantId],
    queryFn: () => api.get<Summary>("/api/v1/finops/summary"),
    refetchInterval: 120_000,
  });

  const usageQ = useQuery({
    queryKey: ["finops-usage", tenantId],
    queryFn: () => api.get<UsageRow[]>("/api/v1/finops/usage?days=3&limit=100"),
    refetchInterval: 120_000,
  });

  const billingQ = useQuery({
    queryKey: ["billing-status"],
    queryFn: () => api.get<BillingStatus>("/api/v1/billing/status"),
    staleTime: 300_000,
  });

  const s = summaryQ.data;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">FinOps</h2>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Plan, entitlements and usage metering — observation only
          </p>
        </div>
        {summaryQ.isFetching && <Spinner className="w-3 h-3" />}
      </div>

      {summaryQ.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : summaryQ.isError ? (
        <p className="text-xs text-[var(--red)]">Failed to load FinOps data.</p>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {/* Contract */}
          <Card className="flex flex-col gap-3">
            <CardHeader><span className="text-sm font-medium">Contract</span></CardHeader>
            {!s?.contract ? (
              <p className="text-xs text-[var(--text-muted)]">No active contract.</p>
            ) : (
              <dl className="space-y-1.5">
                <div className="flex justify-between text-xs">
                  <dt className="text-[var(--text-muted)]">Plan</dt>
                  <dd className="font-mono text-[var(--text)]">{s.contract.plan_ref ?? "—"}</dd>
                </div>
                <div className="flex justify-between text-xs">
                  <dt className="text-[var(--text-muted)]">State</dt>
                  <dd>
                    <Badge variant={s.contract.state === "active" ? "success" : "muted"}>
                      {s.contract.state}
                    </Badge>
                  </dd>
                </div>
                <div className="flex justify-between text-xs">
                  <dt className="text-[var(--text-muted)]">From</dt>
                  <dd className="text-[var(--text)]">{fmtDate(s.contract.effective_from)}</dd>
                </div>
                {s.contract.effective_until && (
                  <div className="flex justify-between text-xs">
                    <dt className="text-[var(--text-muted)]">Until</dt>
                    <dd className="text-[var(--text)]">{fmtDate(s.contract.effective_until)}</dd>
                  </div>
                )}
                <div className="flex justify-between text-xs">
                  <dt className="text-[var(--text-muted)]">ID</dt>
                  <dd className="font-mono text-[10px] text-[var(--text-muted)] truncate max-w-[130px]">
                    {s.contract.contract_id}
                  </dd>
                </div>
              </dl>
            )}
          </Card>

          {/* Entitlements */}
          <Card className="flex flex-col gap-3">
            <CardHeader><span className="text-sm font-medium">Entitlements</span></CardHeader>
            {(!s?.entitlements || s.entitlements.length === 0) ? (
              <p className="text-xs text-[var(--text-muted)]">No entitlements.</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {s.entitlements.map((e) => (
                  <Badge key={e.entitlement_id} variant="success">
                    {capLabel(e.capability)}
                  </Badge>
                ))}
              </div>
            )}
          </Card>

          {/* Billing adapter */}
          <Card className="flex flex-col gap-3">
            <CardHeader>
              <span className="text-sm font-medium">Billing adapter</span>
              {billingQ.data && (
                <Badge variant={billingQ.data.adapter === "stub" ? "muted" : "success"}>
                  {billingQ.data.adapter}
                </Badge>
              )}
            </CardHeader>
            {billingQ.isLoading ? (
              <Spinner className="w-4 h-4" />
            ) : billingQ.data ? (
              <div className="space-y-1.5 text-xs">
                <div className="flex justify-between">
                  <span className="text-[var(--text-muted)]">Status</span>
                  <Badge variant={billingQ.data.status === "active" ? "success" : "warning"}>
                    {billingQ.data.status}
                  </Badge>
                </div>
                {billingQ.data.detail && (
                  <p className="text-[var(--text-muted)] text-[11px] leading-relaxed">
                    {billingQ.data.detail}
                  </p>
                )}
                <p className="text-[10px] text-[var(--text-muted)]">
                  Set <span className="font-mono">BILLING_ADAPTER</span> env to connect a provider.
                </p>
              </div>
            ) : null}
          </Card>

          {/* Latest meter snapshot */}
          <Card className="flex flex-col gap-3">
            <CardHeader><span className="text-sm font-medium">Current usage</span></CardHeader>
            {(!s?.meter_snapshot || s.meter_snapshot.length === 0) ? (
              <p className="text-xs text-[var(--text-muted)]">
                No readings yet — the worker meters usage hourly.
              </p>
            ) : (
              <dl className="space-y-1.5">
                {s.meter_snapshot.map((m) => (
                  <div key={m.meter} className="flex justify-between text-xs">
                    <dt className="text-[var(--text-muted)] truncate max-w-[160px]">
                      {meterLabel(m.meter)}
                    </dt>
                    <dd className="font-mono text-[var(--text)] font-medium tabular-nums">
                      {m.quantity}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
          </Card>
        </div>
      )}

      {/* Usage history */}
      <Card className="p-0 overflow-hidden">
        <CardHeader className="px-4 py-2.5">
          <span className="text-sm font-medium">Usage history (last 3 days)</span>
          {usageQ.isFetching && <Spinner className="w-3 h-3" />}
        </CardHeader>
        {usageQ.isLoading ? (
          <div className="flex justify-center py-6"><Spinner /></div>
        ) : usageQ.isError ? (
          <p className="text-xs text-[var(--red)] px-4 py-3">Failed to load usage history.</p>
        ) : !usageQ.data || usageQ.data.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] px-4 py-3">
            No usage records yet. The worker writes readings every hour.
          </p>
        ) : (
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="px-4 py-2.5 font-medium">Meter</th>
                <th className="px-4 py-2.5 font-medium tabular-nums">Quantity</th>
                <th className="px-4 py-2.5 font-medium">Window end</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {usageQ.data.map((r) => (
                <tr key={r.usage_id} className="hover:bg-[var(--surface-2)] transition-colors">
                  <td className="px-4 py-2 text-[var(--text-muted)]">{meterLabel(r.meter)}</td>
                  <td className="px-4 py-2 font-mono font-medium tabular-nums text-[var(--text)]">
                    {r.quantity}
                  </td>
                  <td className="px-4 py-2 text-[var(--text-muted)] whitespace-nowrap">
                    {fmtTs(r.window_end)}
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
