import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useCanOperate } from "@/hooks/usePermission";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface SLAPolicy {
  sla_id: string;
  name: string;
  severity_match?: string;
  response_secs: number;
  resolve_secs: number;
  enabled: boolean;
  created_at: string;
}

interface SLATracker {
  tracker_id: string;
  alert_id: string;
  sla_name: string;
  alert_fired_at: string;
  response_deadline: string;
  resolve_deadline: string;
  acknowledged_at?: string;
  resolved_at?: string;
  response_breached: boolean;
  resolve_breached: boolean;
}

interface SLABreach {
  breach_id: string;
  alert_id: string;
  sla_name: string;
  breach_type: string;
  breached_at: string;
  deadline_was: string;
}

function fmtSecs(s: number) {
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function CreatePolicyForm({ tenantId, onDone }: { tenantId: string; onDone: () => void }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [severity, setSeverity] = useState("");
  const [respMins, setRespMins] = useState("60");
  const [resMins, setResMins] = useState("480");
  const [err, setErr] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/sla/policies", {
        name,
        severity_match: severity.trim() || null,
        response_secs: parseInt(respMins) * 60,
        resolve_secs: parseInt(resMins) * 60,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["sla-policies", tenantId] });
      onDone();
    },
    onError: (e: unknown) => setErr((e as { detail?: string })?.detail ?? "Failed."),
  });

  return (
    <Card className="p-4 space-y-3">
      <h3 className="text-sm font-medium">{t("sla.newPolicyTitle")}</h3>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("sla.policyName")}</label>
        <input value={name} onChange={e => setName(e.target.value)}
          placeholder="e.g. Critical SLA"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      <div className="space-y-1">
        <label className="text-xs text-[var(--text-muted)]">{t("sla.severityMatch")}</label>
        <input value={severity} onChange={e => setSeverity(e.target.value)}
          placeholder="critical, high, medium, low…"
          className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
      </div>
      <div className="flex gap-2">
        <div className="flex-1 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">{t("sla.responseTime")}</label>
          <input type="number" min="1" value={respMins} onChange={e => setRespMins(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
        </div>
        <div className="flex-1 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">{t("sla.resolveTime")}</label>
          <input type="number" min="1" value={resMins} onChange={e => setResMins(e.target.value)}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]" />
        </div>
      </div>
      {err && <p className="text-xs text-[var(--red)]">{err}</p>}
      <div className="flex gap-2">
        <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
          disabled={mut.isPending || !name.trim()}>
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}{t("escalation.create")}
        </Button>
        <Button variant="secondary" size="sm" onClick={onDone}>{t("common.cancel")}</Button>
      </div>
    </Card>
  );
}

export function SLAPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const canOperate = useCanOperate();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [tab, setTab] = useState<"policies" | "active" | "breaches">("policies");

  const policies = useQuery({
    queryKey: ["sla-policies", tenantId],
    queryFn: () => api.get<SLAPolicy[]>("/api/v1/sla/policies"),
  });

  const trackers = useQuery({
    queryKey: ["sla-trackers", tenantId],
    queryFn: () => api.get<SLATracker[]>("/api/v1/sla/trackers"),
    enabled: tab === "active",
    refetchInterval: 30_000,
  });

  const breaches = useQuery({
    queryKey: ["sla-breaches", tenantId],
    queryFn: () => api.get<SLABreach[]>("/api/v1/sla/breaches"),
    enabled: tab === "breaches",
  });

  const disableMut = useMutation({
    mutationFn: (sla_id: string) =>
      api.put(`/api/v1/sla/policies/${sla_id}`, { enabled: false }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sla-policies", tenantId] }),
  });

  const reactivateMut = useMutation({
    mutationFn: (sla_id: string) =>
      api.put(`/api/v1/sla/policies/${sla_id}`, { enabled: true }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["sla-policies", tenantId] }),
  });

  const tabs = [
    { id: "policies" as const, label: t("sla.tabPolicies") },
    { id: "active" as const, label: t("sla.tabActive") },
    { id: "breaches" as const, label: t("sla.tabBreaches") },
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">{t("sla.title")}</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            {t("sla.subtitle")}
          </p>
        </div>
        {canOperate && tab === "policies" && !creating && (
          <Button size="sm" onClick={() => setCreating(true)}>{t("sla.newPolicy")}</Button>
        )}
      </div>

      {canOperate && creating && tab === "policies" && (
        <CreatePolicyForm tenantId={tenantId} onDone={() => setCreating(false)} />
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)] pb-0">
        {tabs.map(tabItem => (
          <button key={tabItem.id} onClick={() => setTab(tabItem.id)}
            className={[
              "px-3 py-1.5 text-xs font-medium rounded-t transition-colors",
              tab === tabItem.id
                ? "bg-[var(--surface-2)] text-[var(--brand)] border-b-2 border-[var(--brand)]"
                : "text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}>
            {tabItem.label}
          </button>
        ))}
      </div>

      {tab === "policies" && (
        <Card className="p-0 overflow-hidden">
          {policies.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (policies.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">
              {t("sla.noItems")}
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("sla.colName")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colSeverity")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colResponse")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colResolve")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colStatus")}</th>
                  <th className="px-4 py-2.5 font-medium"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(policies.data ?? []).map(p => (
                  <tr key={p.sla_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5 font-medium text-[var(--text)]">{p.name}</td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {p.severity_match ?? "all"}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {fmtSecs(p.response_secs)}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)]">
                      {fmtSecs(p.resolve_secs)}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge variant={p.enabled ? "success" : "muted"}>
                        {p.enabled ? t("sla.statusActive") : t("sla.statusDisabled")}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5">
                      {canOperate && (p.enabled ? (
                        <button
                          onClick={() => disableMut.mutate(p.sla_id)}
                          disabled={disableMut.isPending}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline disabled:opacity-40">
                          {t("sla.disable")}
                        </button>
                      ) : (
                        <button
                          onClick={() => reactivateMut.mutate(p.sla_id)}
                          disabled={reactivateMut.isPending}
                          className="text-[10px] text-[var(--brand)] hover:underline disabled:opacity-40">
                          Reativar
                        </button>
                      ))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "active" && (
        <Card className="p-0 overflow-hidden">
          {trackers.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (trackers.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">{t("sla.noTrackers")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("sla.colAlert")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colSLA")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colResponseBy")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colResolveBy")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colStatus")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(trackers.data ?? []).map(tr => (
                  <tr key={tr.tracker_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => navigate(`/alerts?highlight=${tr.alert_id}`)}
                        title={tr.alert_id}
                        className="font-mono text-[10px] text-[var(--brand)] hover:underline cursor-pointer">
                        {tr.alert_id.slice(0, 20)}…
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text)]">{tr.sla_name}</td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={tr.response_breached ? "text-[var(--red)]" : "text-[var(--text-muted)]"}>
                        {fmtTs(tr.response_deadline)}
                        {tr.response_breached && " ⚠"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={tr.resolve_breached ? "text-[var(--red)]" : "text-[var(--text-muted)]"}>
                        {fmtTs(tr.resolve_deadline)}
                        {tr.resolve_breached && " ⚠"}
                      </span>
                    </td>
                    <td className="px-4 py-2.5">
                      {tr.resolve_breached || tr.response_breached
                        ? <Badge variant="danger">{t("sla.breached")}</Badge>
                        : tr.acknowledged_at
                        ? <Badge variant="info">{t("sla.acknowledged")}</Badge>
                        : <Badge variant="warning">{t("common.open")}</Badge>
                      }
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}

      {tab === "breaches" && (
        <Card className="p-0 overflow-hidden">
          {breaches.isLoading ? (
            <div className="flex justify-center py-8"><Spinner /></div>
          ) : (breaches.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)] p-4">{t("sla.noBreaches")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                  <th className="px-4 py-2.5 font-medium">{t("sla.colAlert")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colSLA")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colType")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colDeadline")}</th>
                  <th className="px-4 py-2.5 font-medium">{t("sla.colBreachedAt")}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {(breaches.data ?? []).map(b => (
                  <tr key={b.breach_id} className="hover:bg-[var(--surface-2)] transition-colors">
                    <td className="px-4 py-2.5">
                      <button
                        onClick={() => navigate(`/alerts?highlight=${b.alert_id}`)}
                        title={b.alert_id}
                        className="font-mono text-[10px] text-[var(--brand)] hover:underline cursor-pointer">
                        {b.alert_id.slice(0, 20)}…
                      </button>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text)]">{b.sla_name}</td>
                    <td className="px-4 py-2.5">
                      <Badge variant="danger">{b.breach_type}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtTs(b.deadline_was)}
                    </td>
                    <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                      {fmtTs(b.breached_at)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      )}
    </div>
  );
}
