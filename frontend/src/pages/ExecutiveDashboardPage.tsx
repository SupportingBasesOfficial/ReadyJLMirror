import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { PageInfoButton } from "@/components/PageInfoButton";
import {
  AlertTriangle,
  Activity,
  GitPullRequest,
  Server,
  ShieldAlert,
  Building2,
  TrendingUp,
} from "lucide-react";

interface AlertKPIs {
  active: number;
  resolved_24h: number;
  total: number;
}

interface IncidentKPIs {
  open: number;
  in_progress: number;
  resolved: number;
  closed: number;
}

interface ChangeKPIs {
  draft: number;
  review: number;
  approved: number;
  scheduled: number;
  implementing: number;
  complete: number;
  cancelled: number;
}

interface MonitoringSourceKPIs {
  total: number;
  enabled: number;
  disabled: number;
}

interface TopTenantRow {
  tenant_id: string;
  display_name: string;
  active_alerts: number;
  total_alerts: number;
}

interface OverviewData {
  scope: "platform" | "tenant";
  tenant_id: string | null;
  alerts: AlertKPIs;
  incidents: IncidentKPIs;
  changes: ChangeKPIs;
  monitoring_sources: MonitoringSourceKPIs;
  sla_breaches_30d: number;
  top_tenants: TopTenantRow[];
}

function KpiTile({
  label,
  value,
  sub,
  icon: Icon,
  accent,
}: {
  label: string;
  value: number | string;
  sub?: string;
  icon: React.ElementType;
  accent?: "danger" | "warning" | "success" | "neutral";
}) {
  const accentMap: Record<string, string> = {
    danger: "text-red-500",
    warning: "text-amber-500",
    success: "text-emerald-500",
    neutral: "text-[var(--text-muted)]",
  };
  const color = accentMap[accent ?? "neutral"];
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4 flex items-start gap-3">
      <div className={`mt-0.5 flex-shrink-0 ${color}`}>
        <Icon size={18} />
      </div>
      <div className="min-w-0">
        <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide font-medium truncate">
          {label}
        </p>
        <p className="text-2xl font-bold leading-tight mt-0.5">{value}</p>
        {sub && (
          <p className="text-xs text-[var(--text-muted)] mt-0.5">{sub}</p>
        )}
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <h2 className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] mt-6 mb-3">
      {children}
    </h2>
  );
}

function StateRow({
  label,
  value,
  variant,
}: {
  label: string;
  value: number;
  variant?: "success" | "warning" | "danger" | "muted";
}) {
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-[var(--border)] last:border-0">
      <span className="text-sm text-[var(--text-secondary)]">{label}</span>
      <Badge variant={variant ?? "muted"}>{value}</Badge>
    </div>
  );
}

export function ExecutiveDashboardPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();

  const overviewQ = useQuery({
    queryKey: ["executive-overview", tenantId],
    queryFn: () => api.get<OverviewData>("/api/v1/executive/overview"),
    refetchInterval: 60_000,
  });

  if (overviewQ.isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    );
  }

  if (overviewQ.isError || !overviewQ.data) {
    return (
      <div className="p-8 text-center text-[var(--text-muted)]">
        {t("executive.error")}
      </div>
    );
  }

  const d = overviewQ.data;
  const totalIncidents =
    d.incidents.open + d.incidents.in_progress + d.incidents.resolved + d.incidents.closed;
  const activeChanges =
    d.changes.review + d.changes.approved + d.changes.scheduled + d.changes.implementing;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-6">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <TrendingUp size={20} className="text-[var(--brand,#6366f1)]" />
            {t("executive.title")}
          </h1>
          <p className="text-sm text-[var(--text-muted)] mt-0.5">
            {d.scope === "platform" ? t("executive.scope_platform") : t("executive.scope_tenant")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {overviewQ.isFetching && <Spinner />}
          <PageInfoButton screenId="executive" />
        </div>
      </div>

      {/* Top KPIs */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        <KpiTile
          label={t("executive.kpi.alerts_active")}
          value={d.alerts.active}
          sub={t("executive.kpi.alerts_resolved_sub", { n: d.alerts.resolved_24h })}
          icon={AlertTriangle}
          accent={d.alerts.active > 0 ? "danger" : "success"}
        />
        <KpiTile
          label={t("executive.kpi.incidents_open")}
          value={d.incidents.open + d.incidents.in_progress}
          sub={t("executive.kpi.incidents_total_sub", { n: totalIncidents })}
          icon={Activity}
          accent={d.incidents.open > 0 ? "warning" : "neutral"}
        />
        <KpiTile
          label={t("executive.kpi.changes_active")}
          value={activeChanges}
          sub={t("executive.kpi.changes_total_sub", {
            n: Object.values(d.changes).reduce((a, b) => a + b, 0),
          })}
          icon={GitPullRequest}
          accent="neutral"
        />
        <KpiTile
          label={t("executive.kpi.sources_enabled")}
          value={d.monitoring_sources.enabled}
          sub={t("executive.kpi.sources_total_sub", { n: d.monitoring_sources.total })}
          icon={Server}
          accent={d.monitoring_sources.disabled > 0 ? "warning" : "success"}
        />
        <KpiTile
          label={t("executive.kpi.sla_breaches")}
          value={d.sla_breaches_30d}
          sub={t("executive.kpi.sla_sub")}
          icon={ShieldAlert}
          accent={d.sla_breaches_30d > 0 ? "danger" : "success"}
        />
      </div>

      {/* Incidents & Changes detail */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-2">
        {/* Incidents by state */}
        <div>
          <SectionTitle>{t("executive.section.incidents")}</SectionTitle>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <StateRow label={t("executive.incident.open")} value={d.incidents.open} variant="danger" />
            <StateRow label={t("executive.incident.in_progress")} value={d.incidents.in_progress} variant="warning" />
            <StateRow label={t("executive.incident.resolved")} value={d.incidents.resolved} variant="success" />
            <StateRow label={t("executive.incident.closed")} value={d.incidents.closed} variant="muted" />
          </div>
        </div>

        {/* Changes by state */}
        <div>
          <SectionTitle>{t("executive.section.changes")}</SectionTitle>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <StateRow label={t("executive.change.draft")} value={d.changes.draft} variant="muted" />
            <StateRow label={t("executive.change.review")} value={d.changes.review} variant="warning" />
            <StateRow label={t("executive.change.approved")} value={d.changes.approved} variant="success" />
            <StateRow label={t("executive.change.scheduled")} value={d.changes.scheduled} variant="muted" />
            <StateRow label={t("executive.change.implementing")} value={d.changes.implementing} variant="warning" />
            <StateRow label={t("executive.change.complete")} value={d.changes.complete} variant="success" />
            <StateRow label={t("executive.change.cancelled")} value={d.changes.cancelled} variant="muted" />
          </div>
        </div>
      </div>

      {/* Top Tenants (platform admin only) */}
      {d.scope === "platform" && d.top_tenants.length > 0 && (
        <>
          <SectionTitle>
            <span className="flex items-center gap-1.5">
              <Building2 size={12} />
              {t("executive.section.top_tenants")}
            </span>
          </SectionTitle>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-1)] overflow-hidden">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-[var(--border)] bg-[var(--surface-2)]">
                  <th className="text-left px-4 py-2 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                    {t("executive.table.tenant")}
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                    {t("executive.table.active_alerts")}
                  </th>
                  <th className="text-right px-4 py-2 text-xs font-medium text-[var(--text-muted)] uppercase tracking-wide">
                    {t("executive.table.total_alerts")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.top_tenants.map((row) => (
                  <tr
                    key={row.tenant_id}
                    className="border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)] transition-colors"
                  >
                    <td className="px-4 py-2.5 font-medium truncate max-w-[200px]">
                      {row.display_name || row.tenant_id}
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {row.active_alerts > 0 ? (
                        <Badge variant="danger">{row.active_alerts}</Badge>
                      ) : (
                        <span className="text-[var(--text-muted)]">0</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--text-secondary)]">
                      {row.total_alerts}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}
