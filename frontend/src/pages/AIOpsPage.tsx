import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useCanOperate } from "@/hooks/usePermission";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";

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
  const canOperate = useCanOperate();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState<string | null>(null);
  const [showDismissed, setShowDismissed] = useState(false);
  const qc = useQueryClient();
  const { toast } = useToast();

  const q = useQuery({
    queryKey: ["aiops-findings", tenantId, showDismissed],
    queryFn: () =>
      api.get<Finding[]>(
        showDismissed
          ? `/api/v1/aiops/findings?limit=50&include_dismissed=true`
          : `/api/v1/aiops/findings?limit=50`
      ),
    refetchInterval: 120_000,
  });

  const dismiss = useMutation({
    mutationFn: (finding_id: string) =>
      api.post(`/api/v1/aiops/findings/${finding_id}/dismiss`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["aiops-findings", tenantId] });
      toast("Finding descartado", "success");
    },
    onError: () => toast("Erro ao descartar", "error"),
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
        <div className="flex items-center gap-2">
          {q.isFetching && <Spinner className="w-3 h-3" />}
          <button
            onClick={() => setShowDismissed((v) => !v)}
            className={[
              "px-3 py-1 rounded-full text-xs cursor-pointer border transition-colors",
              showDismissed
                ? "border-[var(--brand)] text-[var(--brand)] bg-[var(--surface-2)]"
                : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)]",
            ].join(" ")}
          >
            {showDismissed ? "Ocultar descartados" : "Ver descartados"}
          </button>
        </div>
      </div>
      {showDismissed && (
        <p className="text-[10px] text-[var(--text-muted)]">
          Nota: findings descartados não são listados caso o servidor não suporte o filtro.
        </p>
      )}

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
                  {canOperate && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => dismiss.mutate(f.finding_id)}
                      disabled={dismiss.isPending}
                      className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)]"
                    >
                      Dismiss
                    </Button>
                  )}
                </div>
              </CardHeader>

              {expanded === f.finding_id && (
                <div className="px-4 pb-4 space-y-3">
                  <p className="text-xs text-[var(--text)] leading-relaxed">{f.explanation}</p>

                  {f.evidence_refs && f.evidence_refs.length > 0 && (
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] mb-1">Referenced evidence</p>
                      <div className="flex flex-wrap gap-1">
                        {f.evidence_refs.map((ref) => {
                          const isAlert = ref.startsWith("alert:");
                          if (isAlert) {
                            const alertId = ref.slice("alert:".length);
                            return (
                              <a
                                key={ref}
                                href={`/alerts?highlight=${alertId}`}
                                onClick={(e) => {
                                  e.preventDefault();
                                  navigate(`/alerts?highlight=${alertId}`);
                                }}
                                className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--brand)] text-[var(--brand)] hover:underline cursor-pointer"
                              >
                                {ref}
                              </a>
                            );
                          }
                          return (
                            <span
                              key={ref}
                              className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text-muted)]"
                            >
                              {ref}
                            </span>
                          );
                        })}
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
