import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useCanOperate } from "@/hooks/usePermission";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";

interface PredictionOutcome {
  outcome_id: string;
  resource_id: string;
  metric_id: string;
  outcome: "mitigated" | "occurred" | "false_positive";
  note: string;
  recorded_at: string;
  recorded_by: string;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

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

interface Anomaly {
  resource_id: string;
  metric_id: string;
  value: number;
  observed_at: string;
  mean: number;
  stddev: number;
  z_score: number;
  resource_name: string;
  metric_name: string;
  unit: string;
}

interface AnomalyFP {
  fp_id: string;
  resource_id: string;
  metric_id: string;
  note: string;
  marked_at: string;
  marked_by: string;
}

interface AnomalyConfig {
  config_id: string;
  resource_id: string;
  metric_id: string;
  enabled: boolean;
  threshold: number | null;
  updated_at: string;
}

interface AnomalyResult {
  window_hours: number;
  threshold: number;
  count: number;
  anomalies: Anomaly[];
}

interface Prediction {
  resource_id: string;
  metric_id: string;
  resource_name: string;
  metric_name: string;
  unit: string;
  current_value: number;
  slope_per_hour: number;
  confidence: number;
  predicted_critical_at: string | null;
  hours_to_critical: number | null;
  last_seen: string | null;
}

interface PredictionResult {
  horizon_hours: number;
  threshold_pct: number;
  count: number;
  predictions: Prediction[];
}

interface CapacityItem {
  resource_id: string;
  metric_id: string;
  resource_name: string;
  metric_name: string;
  unit: string;
  current_avg: number;
  slope_per_day: number;
  r_squared: number;
  forecast_30d: number | null;
  forecast_60d: number | null;
  forecast_90d: number | null;
  at_risk: boolean;
  day_count: number;
  history: { day: string; avg: number }[];
}

interface CapacityResult {
  total: number;
  at_risk: number;
  items: CapacityItem[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

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

function typeLabel(t: Finding["finding_type"], tFn: (k: string) => string) {
  const map: Record<Finding["finding_type"], string> = {
    anomaly: tFn("aiops.typeAnomaly"),
    correlation: tFn("aiops.typeCorrelation"),
    root_cause: tFn("aiops.typeRootCause"),
    prediction: tFn("aiops.typePrediction"),
  };
  return map[t];
}

function fmtTs(iso: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtConfidence(c: number | null) {
  if (c === null) return "—";
  return `${Math.round(c * 100)}%`;
}

function fmtNum(n: number | null, decimals = 1) {
  if (n === null || n === undefined) return "—";
  return n.toFixed(decimals);
}

// ---------------------------------------------------------------------------
// Tab components
// ---------------------------------------------------------------------------

function FindingsTab({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
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
    <div className="space-y-3">
      <div className="flex items-center justify-end gap-2">
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
          {showDismissed ? t("aiops.hideDismissed") : t("aiops.showDismissed")}
        </button>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">{t("aiops.loadError")}</p>
      ) : findings.length === 0 ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] py-4 text-center">
            {t("aiops.noFindings")}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {findings.map((f) => (
            <Card key={f.finding_id} className="overflow-hidden">
              <CardHeader>
                <div className="flex items-start gap-2 min-w-0 flex-1">
                  <div className="flex flex-wrap gap-1.5 flex-shrink-0 mt-0.5">
                    <Badge variant={typeVariant(f.finding_type)}>{typeLabel(f.finding_type, t)}</Badge>
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
                      {t("aiops.dismiss")}
                    </Button>
                  )}
                </div>
              </CardHeader>

              {expanded === f.finding_id && (
                <div className="px-4 pb-4 space-y-3">
                  <p className="text-xs text-[var(--text)] leading-relaxed">{f.explanation}</p>

                  {f.evidence_refs && f.evidence_refs.length > 0 && (
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] mb-1">{t("aiops.evidence")}</p>
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
                    <span>{t("aiops.model")} <span className="font-mono">{f.model_id}</span></span>
                    <span>{t("aiops.generated")} {fmtTs(f.created_at)}</span>
                    <span>{t("aiops.expires")} {fmtTs(f.expires_at)}</span>
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

function AnomaliesTab({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const canOperate = useCanOperate();
  const [windowHours, setWindowHours] = useState(24);
  const [threshold, setThreshold] = useState(2.5);
  const [showFP, setShowFP] = useState(false);

  const q = useQuery({
    queryKey: ["aiops-anomalies", tenantId, windowHours, threshold],
    queryFn: () =>
      api.get<AnomalyResult>(
        `/api/v1/aiops/anomalies?window_hours=${windowHours}&threshold=${threshold}&limit=100`
      ),
    refetchInterval: 180_000,
  });

  const fpQ = useQuery<AnomalyFP[]>({
    queryKey: ["aiops-anomaly-fp", tenantId],
    queryFn: () => api.get<AnomalyFP[]>("/api/v1/aiops/anomalies/false-positives"),
  });

  const configQ = useQuery<AnomalyConfig[]>({
    queryKey: ["aiops-anomaly-configs", tenantId],
    queryFn: () => api.get<AnomalyConfig[]>("/api/v1/aiops/anomalies/configs"),
  });

  const fpMap = new Map((fpQ.data ?? []).map(fp => [`${fp.resource_id}::${fp.metric_id}`, fp]));
  const configMap = new Map((configQ.data ?? []).map(c => [`${c.resource_id}::${c.metric_id}`, c]));

  const markFPMut = useMutation({
    mutationFn: (body: { resource_id: string; metric_id: string }) =>
      api.post("/api/v1/aiops/anomalies/false-positives", { ...body, note: "" }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["aiops-anomaly-fp"] }); toast({ title: "Falso positivo marcado" }); },
    onError: () => toast({ title: "Erro ao marcar falso positivo", variant: "destructive" }),
  });

  const clearFPMut = useMutation({
    mutationFn: ({ resource_id, metric_id }: { resource_id: string; metric_id: string }) =>
      api.delete(`/api/v1/aiops/anomalies/false-positives/${resource_id}/${metric_id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["aiops-anomaly-fp"] }); toast({ title: "Marcação removida" }); },
    onError: () => toast({ title: "Erro ao remover marcação", variant: "destructive" }),
  });

  const configMut = useMutation({
    mutationFn: ({ resource_id, metric_id, enabled, threshold: thr }: { resource_id: string; metric_id: string; enabled: boolean; threshold: number | null }) =>
      api.put(`/api/v1/aiops/anomalies/config/${resource_id}/${metric_id}`, { enabled, threshold: thr }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aiops-anomaly-configs"] }),
    onError: () => toast({ title: "Erro ao salvar config", variant: "destructive" }),
  });

  const anomalies = (q.data?.anomalies ?? []).filter(a => {
    const cfg = configMap.get(`${a.resource_id}::${a.metric_id}`);
    if (cfg && !cfg.enabled) return false;
    if (!showFP && fpMap.has(`${a.resource_id}::${a.metric_id}`)) return false;
    return true;
  });

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          {t("aiops.anomalies.window")}
          <select
            value={windowHours}
            onChange={(e) => setWindowHours(Number(e.target.value))}
            className="ml-1 px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-1)] text-xs text-[var(--text)]"
          >
            {[1, 6, 12, 24, 48, 72, 168].map((h) => (
              <option key={h} value={h}>{h}h</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          {t("aiops.anomalies.threshold")}
          <select
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
            className="ml-1 px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-1)] text-xs text-[var(--text)]"
          >
            {[1.5, 2.0, 2.5, 3.0, 3.5].map((v) => (
              <option key={v} value={v}>Z &gt; {v}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)] cursor-pointer">
          <input type="checkbox" checked={showFP} onChange={e => setShowFP(e.target.checked)} className="w-3 h-3" />
          Exibir FPs
        </label>
        <button
          onClick={() => q.refetch()}
          disabled={q.isFetching}
          className="text-xs px-2.5 py-0.5 rounded border border-[var(--border)] hover:border-[var(--brand)] transition-colors disabled:opacity-50"
        >
          {q.isFetching ? "..." : "Scan agora"}
        </button>
        {q.data && (
          <span className="text-[10px] text-[var(--text-muted)] ml-auto">
            {anomalies.length} / {q.data.count} {t("aiops.anomalies.detected")}
          </span>
        )}
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">{t("aiops.anomalies.loadError")}</p>
      ) : anomalies.length === 0 ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] py-4 text-center">
            {t("aiops.anomalies.none")}
          </p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]">
                <th className="text-left px-3 py-2 font-medium">{t("aiops.anomalies.resource")}</th>
                <th className="text-left px-3 py-2 font-medium">{t("aiops.anomalies.metric")}</th>
                <th className="text-right px-3 py-2 font-medium">{t("aiops.anomalies.value")}</th>
                <th className="text-right px-3 py-2 font-medium">{t("aiops.anomalies.mean")}</th>
                <th className="text-right px-3 py-2 font-medium">{t("aiops.anomalies.zscore")}</th>
                <th className="text-left px-3 py-2 font-medium">{t("aiops.anomalies.detectedAt")}</th>
                {canOperate && <th className="px-3 py-2 font-medium text-center">Ações</th>}
              </tr>
            </thead>
            <tbody>
              {anomalies.map((a, i) => {
                const key = `${a.resource_id}::${a.metric_id}`;
                const isFP = fpMap.has(key);
                const cfg = configMap.get(key);
                return (
                  <tr
                    key={`${key}-${i}`}
                    className={[
                      "border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)] transition-colors",
                      isFP ? "opacity-60" : "",
                    ].join(" ")}
                  >
                    <td className="px-3 py-2 font-medium text-[var(--text)]">
                      {a.resource_name}
                      {cfg && !cfg.enabled && (
                        <span className="ml-1.5 text-[10px] px-1 rounded bg-[var(--surface-2)] text-[var(--text-muted)]">desativ.</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-[var(--text-secondary)]">
                      {a.metric_name}
                      {a.unit && <span className="ml-1 text-[10px] text-[var(--text-muted)]">{a.unit}</span>}
                      {cfg?.threshold && (
                        <span className="ml-1.5 text-[10px] text-[var(--text-muted)]">Z&gt;{cfg.threshold}</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--text)]">{fmtNum(a.value)}</td>
                    <td className="px-3 py-2 text-right font-mono text-[var(--text-muted)]">{fmtNum(a.mean)}</td>
                    <td className="px-3 py-2 text-right">
                      <span className={[
                        "font-mono font-semibold",
                        a.z_score > 4 ? "text-[var(--red)]" : a.z_score > 3 ? "text-[var(--orange,#f97316)]" : "text-[var(--yellow,#eab308)]",
                      ].join(" ")}>
                        {fmtNum(a.z_score, 2)}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[var(--text-muted)] whitespace-nowrap">{fmtTs(a.observed_at)}</td>
                    {canOperate && (
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          {isFP ? (
                            <button
                              onClick={() => clearFPMut.mutate({ resource_id: a.resource_id, metric_id: a.metric_id })}
                              disabled={clearFPMut.isPending}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] hover:border-[var(--brand)] transition-colors"
                            >
                              Limpar FP
                            </button>
                          ) : (
                            <button
                              onClick={() => markFPMut.mutate({ resource_id: a.resource_id, metric_id: a.metric_id })}
                              disabled={markFPMut.isPending}
                              className="text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] hover:border-amber-500 text-amber-600 transition-colors"
                            >
                              Falso+
                            </button>
                          )}
                          <button
                            onClick={() => configMut.mutate({
                              resource_id: a.resource_id,
                              metric_id: a.metric_id,
                              enabled: cfg ? !cfg.enabled : false,
                              threshold: cfg?.threshold ?? null,
                            })}
                            disabled={configMut.isPending}
                            title={cfg && !cfg.enabled ? "Habilitar detecção" : "Desabilitar detecção"}
                            className={[
                              "text-[10px] px-1.5 py-0.5 rounded border transition-colors",
                              cfg && !cfg.enabled
                                ? "border-green-500 text-green-600 hover:bg-green-500/10"
                                : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--brand)]",
                            ].join(" ")}
                          >
                            {cfg && !cfg.enabled ? "Habilitar" : "Desativ."}
                          </button>
                        </div>
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const OUTCOME_LABELS: Record<string, string> = {
  mitigated: "Mitigado",
  occurred: "Ocorreu",
  false_positive: "Falso positivo",
};

const OUTCOME_VARIANTS: Record<string, "success" | "danger" | "muted"> = {
  mitigated: "success",
  occurred: "danger",
  false_positive: "muted",
};

function PredictionsTab({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const canOperate = useCanOperate();
  const [horizonHours, setHorizonHours] = useState(72);

  const q = useQuery({
    queryKey: ["aiops-predictions", tenantId, horizonHours],
    queryFn: () =>
      api.get<PredictionResult>(
        `/api/v1/aiops/predictions?horizon_hours=${horizonHours}`
      ),
    refetchInterval: 300_000,
  });

  const outcomesQ = useQuery<PredictionOutcome[]>({
    queryKey: ["aiops-prediction-outcomes", tenantId],
    queryFn: () =>
      api.get("/api/v1/aiops/predictions/outcomes").then((r) => r.data),
    refetchInterval: 300_000,
  });

  const outcomesMap = new Map<string, PredictionOutcome>(
    (outcomesQ.data ?? []).map((o) => [`${o.resource_id}::${o.metric_id}`, o])
  );

  const recordMut = useMutation({
    mutationFn: (body: { resource_id: string; metric_id: string; outcome: string }) =>
      api.post("/api/v1/aiops/predictions/outcomes", body),
    onSuccess: () => {
      toast("Desfecho registrado.", "success");
      qc.invalidateQueries({ queryKey: ["aiops-prediction-outcomes", tenantId] });
    },
    onError: () => toast("Erro ao registrar desfecho.", "error"),
  });

  const clearMut = useMutation({
    mutationFn: ({ resource_id, metric_id }: { resource_id: string; metric_id: string }) =>
      api.delete(`/api/v1/aiops/predictions/outcomes/${encodeURIComponent(resource_id)}/${encodeURIComponent(metric_id)}`),
    onSuccess: () => {
      toast("Desfecho removido.", "success");
      qc.invalidateQueries({ queryKey: ["aiops-prediction-outcomes", tenantId] });
    },
    onError: () => toast("Erro ao remover desfecho.", "error"),
  });

  const predictions = q.data?.predictions ?? [];

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          {t("aiops.predictions.horizon")}
          <select
            value={horizonHours}
            onChange={(e) => setHorizonHours(Number(e.target.value))}
            className="ml-1 px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-1)] text-xs text-[var(--text)]"
          >
            {[24, 48, 72, 168, 336, 720].map((h) => (
              <option key={h} value={h}>{h}h</option>
            ))}
          </select>
        </label>
        {q.isFetching && <Spinner className="w-3 h-3" />}
        {q.data && (
          <span className="text-[10px] text-[var(--text-muted)] ml-auto">
            {q.data.count} {t("aiops.predictions.atRisk")}
          </span>
        )}
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">{t("aiops.predictions.hint")}</p>

      {q.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">{t("aiops.predictions.loadError")}</p>
      ) : predictions.length === 0 ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] py-4 text-center">
            {t("aiops.predictions.none")}
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {predictions.map((p, i) => {
            const key = `${p.resource_id}::${p.metric_id}`;
            const outcome = outcomesMap.get(key);
            return (
              <Card key={`${p.resource_id}-${p.metric_id}-${i}`} className="p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text)]">{p.resource_name}</p>
                    <p className="text-xs text-[var(--text-secondary)]">
                      {p.metric_name}
                      {p.unit && <span className="ml-1 text-[10px] text-[var(--text-muted)]">{p.unit}</span>}
                    </p>
                  </div>
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    {outcome ? (
                      <Badge variant={OUTCOME_VARIANTS[outcome.outcome]}>
                        {OUTCOME_LABELS[outcome.outcome]}
                      </Badge>
                    ) : p.predicted_critical_at ? (
                      <Badge variant="danger">
                        {t("aiops.predictions.critical")} {fmtTs(p.predicted_critical_at)}
                      </Badge>
                    ) : (
                      <Badge variant="warning">
                        {p.hours_to_critical !== null
                          ? `~${Math.round(p.hours_to_critical)}h`
                          : t("aiops.predictions.trending")}
                      </Badge>
                    )}
                  </div>
                </div>
                <div className="mt-2 flex flex-wrap gap-4 text-[10px] text-[var(--text-muted)]">
                  <span>{t("aiops.predictions.current")} <span className="font-mono text-[var(--text)]">{fmtNum(p.current_value)}%</span></span>
                  <span>{t("aiops.predictions.slopeHour")} <span className="font-mono text-[var(--text)]">{fmtNum(p.slope_per_hour, 3)}</span></span>
                  <span>R² <span className="font-mono text-[var(--text)]">{fmtNum(p.confidence, 3)}</span></span>
                </div>
                {canOperate && (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {outcome ? (
                      <button
                        onClick={() => clearMut.mutate({ resource_id: p.resource_id, metric_id: p.metric_id })}
                        disabled={clearMut.isPending}
                        className="text-[10px] text-[var(--text-muted)] underline disabled:opacity-40"
                      >
                        Limpar desfecho
                      </button>
                    ) : (
                      <>
                        {(["mitigated", "occurred", "false_positive"] as const).map((o) => (
                          <button
                            key={o}
                            onClick={() => recordMut.mutate({ resource_id: p.resource_id, metric_id: p.metric_id, outcome: o })}
                            disabled={recordMut.isPending}
                            className={`text-[10px] px-2 py-0.5 rounded border transition-colors disabled:opacity-40 ${
                              o === "mitigated"
                                ? "border-[var(--green)] text-[var(--green)] hover:bg-[var(--green)] hover:text-white"
                                : o === "occurred"
                                ? "border-[var(--red)] text-[var(--red)] hover:bg-[var(--red)] hover:text-white"
                                : "border-[var(--muted)] text-[var(--muted)] hover:bg-[var(--surface)] hover:text-[var(--fg)]"
                            }`}
                          >
                            {OUTCOME_LABELS[o]}
                          </button>
                        ))}
                      </>
                    )}
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

function CapacityTab({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const [metricKey, setMetricKey] = useState("");

  const q = useQuery({
    queryKey: ["aiops-capacity", tenantId, metricKey],
    queryFn: () => {
      const params = metricKey ? `?metric_key=${encodeURIComponent(metricKey)}` : "";
      return api.get<CapacityResult>(`/api/v1/aiops/capacity${params}`);
    },
    refetchInterval: 600_000,
  });

  const items = q.data?.items ?? [];
  const atRisk = q.data?.at_risk ?? 0;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-muted)]">
          {t("aiops.capacity.filterMetric")}
          <input
            type="text"
            value={metricKey}
            onChange={(e) => setMetricKey(e.target.value)}
            placeholder="cpu, disk, mem…"
            className="ml-1 px-2 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-1)] text-xs text-[var(--text)] w-32"
          />
        </label>
        {q.isFetching && <Spinner className="w-3 h-3" />}
        {q.data && (
          <span className="text-[10px] text-[var(--text-muted)] ml-auto">
            {atRisk} {t("aiops.capacity.atRisk30d")} · {q.data.total} {t("aiops.capacity.tracked")}
          </span>
        )}
      </div>
      <p className="text-[10px] text-[var(--text-muted)]">{t("aiops.capacity.hint")}</p>

      {q.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">{t("aiops.capacity.loadError")}</p>
      ) : items.length === 0 ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] py-4 text-center">
            {t("aiops.capacity.none")}
          </p>
        </Card>
      ) : (
        <div className="overflow-x-auto rounded-lg border border-[var(--border)]">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-[var(--border)] bg-[var(--surface-2)] text-[var(--text-muted)]">
                <th className="text-left px-3 py-2 font-medium">{t("aiops.capacity.resource")}</th>
                <th className="text-left px-3 py-2 font-medium">{t("aiops.capacity.metric")}</th>
                <th className="text-right px-3 py-2 font-medium">{t("aiops.capacity.current")}</th>
                <th className="text-right px-3 py-2 font-medium">30d</th>
                <th className="text-right px-3 py-2 font-medium">60d</th>
                <th className="text-right px-3 py-2 font-medium">90d</th>
                <th className="text-center px-3 py-2 font-medium">{t("aiops.capacity.risk")}</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item, i) => (
                <tr
                  key={`${item.resource_id}-${item.metric_id}-${i}`}
                  className={[
                    "border-b border-[var(--border)] last:border-0 hover:bg-[var(--surface-2)] transition-colors",
                    item.at_risk ? "bg-[var(--red-surface,rgba(239,68,68,0.04))]" : "",
                  ].join(" ")}
                >
                  <td className="px-3 py-2 font-medium text-[var(--text)]">{item.resource_name}</td>
                  <td className="px-3 py-2 text-[var(--text-secondary)]">
                    {item.metric_name}
                    {item.unit && <span className="ml-1 text-[10px] text-[var(--text-muted)]">{item.unit}</span>}
                  </td>
                  <td className="px-3 py-2 text-right font-mono">{fmtNum(item.current_avg)}%</td>
                  <td className={`px-3 py-2 text-right font-mono ${item.at_risk ? "text-[var(--red)] font-semibold" : ""}`}>
                    {item.forecast_30d !== null ? `${fmtNum(item.forecast_30d)}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--text-secondary)]">
                    {item.forecast_60d !== null ? `${fmtNum(item.forecast_60d)}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-right font-mono text-[var(--text-secondary)]">
                    {item.forecast_90d !== null ? `${fmtNum(item.forecast_90d)}%` : "—"}
                  </td>
                  <td className="px-3 py-2 text-center">
                    {item.at_risk ? (
                      <Badge variant="danger">⚠</Badge>
                    ) : (
                      <Badge variant="success">✓</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type Tab = "findings" | "anomalies" | "predictions" | "capacity";

export function AIOpsPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("findings");

  const tabs: { id: Tab; label: string }[] = [
    { id: "findings", label: t("aiops.tabs.findings") },
    { id: "anomalies", label: t("aiops.tabs.anomalies") },
    { id: "predictions", label: t("aiops.tabs.predictions") },
    { id: "capacity", label: t("aiops.tabs.capacity") },
  ];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold">{t("aiops.title")}</h2>
        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
          {t("aiops.subtitle")}
        </p>
      </div>

      <div className="flex gap-0 border-b border-[var(--border)]">
        {tabs.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={[
              "px-4 py-2 text-xs font-medium border-b-2 -mb-px transition-colors",
              tab === id
                ? "border-[var(--brand)] text-[var(--brand)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "findings"    && <FindingsTab    tenantId={tenantId} />}
      {tab === "anomalies"   && <AnomaliesTab   tenantId={tenantId} />}
      {tab === "predictions" && <PredictionsTab tenantId={tenantId} />}
      {tab === "capacity"    && <CapacityTab    tenantId={tenantId} />}
    </div>
  );
}
