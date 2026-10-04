import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface PolicyVersion {
  policy_id: string;
  policy_version: number;
  source_kind: "monitoring_problem" | "monitoring_health_projection";
  problem_min_severity: string | null;
  health_classes: string[] | null;
  monitoring_source_id: string | null;
  monitoring_resource_id: string | null;
  superseded: boolean;
  effective_enabled: boolean;
  is_effective: boolean;
  created_at: string;
}

const SEVERITIES = ["informational", "warning", "degraded", "critical"];
const HEALTH_CLASSES = ["unknown", "healthy", "degraded", "unhealthy"];

function severityVariant(s: string): "success" | "warning" | "danger" | "muted" {
  if (s === "critical") return "danger";
  if (s === "degraded") return "warning";
  if (s === "warning") return "warning";
  return "muted";
}

function groupPolicies(versions: PolicyVersion[]): Map<string, PolicyVersion[]> {
  const map = new Map<string, PolicyVersion[]>();
  for (const v of versions) {
    if (!map.has(v.policy_id)) map.set(v.policy_id, []);
    map.get(v.policy_id)!.push(v);
  }
  return map;
}

function conditionLabel(v: PolicyVersion): string {
  if (v.source_kind === "monitoring_problem") {
    return `severity ≥ ${v.problem_min_severity ?? "?"}`;
  }
  return `health in [${(v.health_classes ?? []).join(", ")}]`;
}

interface PolicyFormData {
  policy_id: string;
  source_kind: "monitoring_problem" | "monitoring_health_projection";
  problem_min_severity: string;
  health_classes: string[];
  monitoring_source_id: string;
}

const EMPTY_FORM: PolicyFormData = {
  policy_id: "",
  source_kind: "monitoring_problem",
  problem_min_severity: "warning",
  health_classes: ["degraded", "unhealthy"],
  monitoring_source_id: "",
};

function PolicyForm({
  initial,
  onDone,
}: {
  initial?: Partial<PolicyFormData>;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState<PolicyFormData>({ ...EMPTY_FORM, ...initial });
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        policy_id: form.policy_id,
        source_kind: form.source_kind,
        make_effective: true,
      };
      if (form.source_kind === "monitoring_problem") {
        body.problem_min_severity = form.problem_min_severity;
      } else {
        body.health_classes = form.health_classes;
      }
      if (form.monitoring_source_id) {
        body.monitoring_source_id = form.monitoring_source_id;
      }
      return api.post("/api/v1/alerting/policies", body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alert-policies"] });
      onDone();
    },
    onError: (e: Error) => setError(e.message),
  });

  const toggleHC = (hc: string) => {
    setForm((f) => ({
      ...f,
      health_classes: f.health_classes.includes(hc)
        ? f.health_classes.filter((c) => c !== hc)
        : [...f.health_classes, hc],
    }));
  };

  return (
    <div className="space-y-3 text-xs">
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-[var(--text-muted)] mb-1">Policy ID</label>
          <input
            value={form.policy_id}
            onChange={(e) => setForm((f) => ({ ...f, policy_id: e.target.value }))}
            readOnly={!!initial?.policy_id}
            placeholder="e.g. jl-prod-warn"
            className="w-full px-2 py-1.5 rounded border border-[var(--border)]
              bg-[var(--surface-2)] text-[var(--text)] font-mono text-xs
              disabled:opacity-60"
          />
        </div>
        <div>
          <label className="block text-[var(--text-muted)] mb-1">Source kind</label>
          <select
            value={form.source_kind}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                source_kind: e.target.value as PolicyFormData["source_kind"],
              }))
            }
            className="w-full px-2 py-1.5 rounded border border-[var(--border)]
              bg-[var(--surface-2)] text-[var(--text)] text-xs cursor-pointer"
          >
            <option value="monitoring_problem">monitoring_problem</option>
            <option value="monitoring_health_projection">monitoring_health_projection</option>
          </select>
        </div>
      </div>

      {form.source_kind === "monitoring_problem" ? (
        <div>
          <label className="block text-[var(--text-muted)] mb-1">
            Min severity (inclusive)
          </label>
          <select
            value={form.problem_min_severity}
            onChange={(e) =>
              setForm((f) => ({ ...f, problem_min_severity: e.target.value }))
            }
            className="px-2 py-1.5 rounded border border-[var(--border)]
              bg-[var(--surface-2)] text-[var(--text)] text-xs cursor-pointer"
          >
            {SEVERITIES.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      ) : (
        <div>
          <label className="block text-[var(--text-muted)] mb-1">Health classes (trigger on)</label>
          <div className="flex gap-2 flex-wrap">
            {HEALTH_CLASSES.map((hc) => (
              <label key={hc} className="flex items-center gap-1 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.health_classes.includes(hc)}
                  onChange={() => toggleHC(hc)}
                />
                <span>{hc}</span>
              </label>
            ))}
          </div>
        </div>
      )}

      <div>
        <label className="block text-[var(--text-muted)] mb-1">
          Monitoring source ID (optional scope)
        </label>
        <input
          value={form.monitoring_source_id}
          onChange={(e) =>
            setForm((f) => ({ ...f, monitoring_source_id: e.target.value }))
          }
          placeholder="mon-src_…"
          className="w-full px-2 py-1.5 rounded border border-[var(--border)]
            bg-[var(--surface-2)] text-[var(--text)] font-mono text-xs"
        />
      </div>

      {error && <p className="text-[var(--red)] text-xs">{error}</p>}

      <div className="flex gap-2">
        <Button
          size="sm"
          onClick={() => create.mutate()}
          disabled={!form.policy_id || create.isPending}
        >
          {create.isPending ? <Spinner className="w-3 h-3" /> : "Create & activate"}
        </Button>
        <Button size="sm" variant="secondary" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function AlertPoliciesPage({ tenantId: _tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [showForm, setShowForm] = useState(false);
  const [newVersionFor, setNewVersionFor] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const q = useQuery({
    queryKey: ["alert-policies"],
    queryFn: () => api.get<PolicyVersion[]>("/api/v1/alerting/policies"),
    refetchInterval: 60_000,
  });

  const toggleEffective = useMutation({
    mutationFn: ({ policy_id, policy_version, enabled }: {
      policy_id: string; policy_version: number; enabled: boolean;
    }) =>
      api.post(`/api/v1/alerting/policies/${policy_id}/effective`, {
        policy_version,
        enabled,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alert-policies"] }),
  });

  const versions = q.data ?? [];
  const grouped = groupPolicies(versions);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Alert policies</h2>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Immutable · append-only · version-controlled
          </p>
        </div>
        <div className="flex items-center gap-2">
          {q.isFetching && <Spinner className="w-3 h-3" />}
          <Button size="sm" onClick={() => { setShowForm(true); setNewVersionFor(null); }}>
            New policy
          </Button>
        </div>
      </div>

      {(showForm && !newVersionFor) && (
        <Card className="flex flex-col gap-3">
          <CardHeader>
            <span className="text-sm font-medium">Create policy</span>
          </CardHeader>
          <PolicyForm onDone={() => setShowForm(false)} />
        </Card>
      )}

      {q.isLoading ? (
        <Spinner className="w-5 h-5" />
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Could not load policies.</p>
      ) : grouped.size === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No alert policies defined.</p>
      ) : (
        <div className="space-y-3">
          {Array.from(grouped.entries()).map(([policyId, pvs]) => {
            const effective = pvs.find((v) => v.is_effective);
            const historical = pvs.filter((v) => !v.is_effective);
            const isExpanded = expanded.has(policyId);

            return (
              <Card key={policyId} className="flex flex-col gap-3">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm text-[var(--brand)]">{policyId}</span>
                    {effective && (
                      <Badge variant="muted">v{effective.policy_version}</Badge>
                    )}
                    {effective?.source_kind === "monitoring_problem" && (
                      <Badge variant={severityVariant(effective.problem_min_severity ?? "")}>
                        {conditionLabel(effective)}
                      </Badge>
                    )}
                    {effective?.source_kind === "monitoring_health_projection" && (
                      <Badge variant="warning">{conditionLabel(effective)}</Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    {effective && (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() =>
                          toggleEffective.mutate({
                            policy_id: policyId,
                            policy_version: effective.policy_version,
                            enabled: !effective.effective_enabled,
                          })
                        }
                        disabled={toggleEffective.isPending}
                      >
                        {effective.effective_enabled ? "Disable" : "Enable"}
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        setNewVersionFor(policyId);
                        setShowForm(true);
                      }}
                    >
                      New version
                    </Button>
                    {historical.length > 0 && (
                      <button
                        onClick={() =>
                          setExpanded((s) => {
                            const n = new Set(s);
                            n.has(policyId) ? n.delete(policyId) : n.add(policyId);
                            return n;
                          })
                        }
                        className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
                      >
                        {isExpanded ? "Hide" : `History (${historical.length})`}
                      </button>
                    )}
                  </div>
                </div>

                {effective?.monitoring_source_id && (
                  <p className="text-xs text-[var(--text-muted)]">
                    Scope: <span className="font-mono">{effective.monitoring_source_id}</span>
                  </p>
                )}

                {newVersionFor === policyId && showForm && (
                  <div className="border-t border-[var(--border)] pt-3">
                    <p className="text-xs text-[var(--text-muted)] mb-2">New version for {policyId}</p>
                    <PolicyForm
                      initial={{ policy_id: policyId, source_kind: effective?.source_kind }}
                      onDone={() => { setShowForm(false); setNewVersionFor(null); }}
                    />
                  </div>
                )}

                {isExpanded && historical.length > 0 && (
                  <div className="border-t border-[var(--border)] pt-2 space-y-1">
                    {historical.map((v) => (
                      <div key={v.policy_version} className="flex items-center gap-2 text-xs text-[var(--text-muted)]">
                        <span className="font-mono">v{v.policy_version}</span>
                        <span>{conditionLabel(v)}</span>
                        {v.superseded && <Badge variant="muted">superseded</Badge>}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}
