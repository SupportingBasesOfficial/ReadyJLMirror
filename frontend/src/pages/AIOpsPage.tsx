import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface Finding {
  finding_id: string;
  finding_type: "anomaly" | "correlation" | "root_cause" | "prediction";
  severity_hint: "low" | "medium" | "high";
  title: string;
  explanation: string;
  evidence_refs: string[];
  confidence: number | null;
  model_id: string;
  created_at: string;
  expires_at: string;
  dismissed_at: string | null;
}

function typeVariant(t: Finding["finding_type"]): "info" | "warning" | "muted" | "success" {
  if (t === "root_cause") return "warning";
  if (t === "anomaly") return "info";
  if (t === "prediction") return "success";
  return "muted";
}

function sevVariant(s: Finding["severity_hint"]): "danger" | "warning" | "muted" {
  if (s === "high") return "danger";
  if (s === "medium") return "warning";
  return "muted";
}

function typeLabel(t: Finding["finding_type"]) {
  return { anomaly: "Anomaly", correlation: "Correlation", root_cause: "Root cause", prediction: "Prediction" }[t];
}

function fmtTs(iso: string) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtConfidence(c: number | null) {
  if (c === null) return "—";
  return `${Math.round(c * 100)}%`;
}

export function AIOpsPage({ tenantId }: { tenantId: string }) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const qc = useQueryClient();

  const q = useQuery({
    queryKey: ["aiops-findings", tenantId],
    queryFn: () => api.get<Finding[]>(`/api/v1/aiops/findings?limit=50`),
    refetchInterval: 120_000,
  });

  const dismiss = useMutation({
    mutationFn: (finding_id: string) =>
      api.post(`/api/v1/aiops/findings/${finding_id}/dismiss`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aiops-findings", tenantId] }),
  });

  const findings = q.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">AIOps Advisory Findings</h2>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            AI-generated analysis · advisory only · does not create or resolve alerts
          </p>
        </div>
        {q.isFetching && <Spinner className="w-3 h-3" />}
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Failed to load findings.</p>
      ) : findings.length === 0 ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] py-4 text-center">
            No active advisory findings. Analysis runs every 30 minutes when there are active alerts.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {findings.map((f) => (
            <Card key={f.finding_id} className="overflow-hidden">
              <CardHeader>
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <div className="flex flex-wrap gap-1.5 flex-shrink-0 mt-0.5">
                    <Badge variant={typeVariant(f.finding_type)}>{typeLabel(f.finding_type)}</Badge>
                    <Badge variant={sevVariant(f.severity_hint)}>{f.severity_hint}</Badge>
                  </div>
                  <button
                    onClick={() => setExpanded(expanded === f.finding_id ? null : f.finding_id)}
                    className="text-sm font-medium text-left text-[var(--text)] hover:text-[var(--brand)] cursor-pointer bg-none border-none p-0 min-w-0 flex-1"
                  >
                    {f.title}
                  </button>
                </div>
                <div className="flex items-center gap-3 flex-shrink-0">
                  <span className="text-[10px] text-[var(--text-muted)] whitespace-nowrap">
                    conf {fmtConfidence(f.confidence)}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => dismiss.mutate(f.finding_id)}
                    disabled={dismiss.isPending}
                    className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)]"
                  >
                    Dismiss
                  </Button>
                </div>
              </CardHeader>

              {expanded === f.finding_id && (
                <div className="px-4 pb-4 space-y-3">
                  <p className="text-xs text-[var(--text)] leading-relaxed">{f.explanation}</p>

                  {f.evidence_refs && f.evidence_refs.length > 0 && (
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] mb-1">Referenced evidence</p>
                      <div className="flex flex-wrap gap-1">
                        {f.evidence_refs.map((ref) => (
                          <span
                            key={ref}
                            className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-muted)]"
                          >
                            {ref}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}

                  <div className="flex items-center gap-4 text-[10px] text-[var(--text-muted)]">
                    <span>Model: <span className="font-mono">{f.model_id}</span></span>
                    <span>Generated: {fmtTs(f.created_at)}</span>
                    <span>Expires: {fmtTs(f.expires_at)}</span>
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
