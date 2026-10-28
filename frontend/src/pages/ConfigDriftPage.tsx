import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { GitCompare, Plus, Trash2, ScanSearch, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/api/client";
import { useToast } from "@/hooks/use-toast";
import { PageInfoButton } from "@/components/PageInfoButton";

interface Props {
  tenantId: string;
}

interface Baseline {
  baseline_id: string;
  source_id: string;
  resource_ref: string;
  config_key: string;
  expected_value: string;
  captured_at: string;
  captured_by: string | null;
}

interface DriftEvent {
  drift_id: string;
  baseline_id: string | null;
  source_id: string;
  resource_ref: string;
  config_key: string;
  expected_value: string;
  actual_value: string;
  detected_at: string;
  acknowledged_at: string | null;
  acknowledged_by: string | null;
  state: "open" | "acknowledged" | "resolved";
}

interface ScanResult {
  scanned: number;
  drifts_found: number;
}

interface Summary {
  total_baselines: number;
  open_drifts: number;
  last_scan_at: string | null;
}

type Tab = "events" | "baselines";

function stateVariant(state: string): "danger" | "warning" | "muted" {
  if (state === "open") return "danger";
  if (state === "acknowledged") return "warning";
  return "muted";
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

const EMPTY_FORM = { source_id: "", resource_ref: "", config_key: "", expected_value: "" };

export function ConfigDriftPage({ tenantId }: Props) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("events");
  const [eventFilter, setEventFilter] = useState("open");
  const [addOpen, setAddOpen] = useState(false);
  const [form, setForm] = useState({ ...EMPTY_FORM });

  const summaryQ = useQuery<Summary>({
    queryKey: ["drift-summary", tenantId],
    queryFn: () => api.get<Summary>("/api/v1/drift/summary"),
    refetchInterval: 60_000,
  });

  const baselinesQ = useQuery<Baseline[]>({
    queryKey: ["drift-baselines", tenantId],
    queryFn: () => api.get<Baseline[]>("/api/v1/drift/baselines"),
  });

  const eventsQ = useQuery<DriftEvent[]>({
    queryKey: ["drift-events", tenantId, eventFilter],
    queryFn: () =>
      api.get<DriftEvent[]>(`/api/v1/drift/events${eventFilter ? `?state=${eventFilter}` : ""}`),
    refetchInterval: 30_000,
  });

  const scanMut = useMutation<ScanResult>({
    mutationFn: () => api.post<ScanResult>("/api/v1/drift/scan"),
    onSuccess: (data) => {
      toast({
        title: t("drift.scan_complete"),
        description: t("drift.scan_result", {
          scanned: data.scanned,
          found: data.drifts_found,
        }),
      });
      qc.invalidateQueries({ queryKey: ["drift-events"] });
      qc.invalidateQueries({ queryKey: ["drift-summary"] });
    },
    onError: () => toast({ title: t("drift.scan_error"), variant: "destructive" }),
  });

  const createMut = useMutation({
    mutationFn: () => api.post("/api/v1/drift/baselines", form),
    onSuccess: () => {
      toast({ title: t("drift.baseline_created") });
      setAddOpen(false);
      setForm({ ...EMPTY_FORM });
      qc.invalidateQueries({ queryKey: ["drift-baselines"] });
      qc.invalidateQueries({ queryKey: ["drift-summary"] });
    },
    onError: () => toast({ title: t("drift.baseline_error"), variant: "destructive" }),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/drift/baselines/${id}`),
    onSuccess: () => {
      toast({ title: t("drift.baseline_deleted") });
      qc.invalidateQueries({ queryKey: ["drift-baselines"] });
      qc.invalidateQueries({ queryKey: ["drift-summary"] });
    },
    onError: () => toast({ title: t("drift.delete_error"), variant: "destructive" }),
  });

  const ackMut = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/drift/events/${id}/acknowledge`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drift-events"] });
      qc.invalidateQueries({ queryKey: ["drift-summary"] });
    },
  });

  const resolveMut = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/drift/events/${id}/resolve`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["drift-events"] });
      qc.invalidateQueries({ queryKey: ["drift-summary"] });
    },
  });

  const summary = summaryQ.data;
  const tabs: { id: Tab; label: string }[] = [
    { id: "events", label: t("drift.tab_events") },
    { id: "baselines", label: t("drift.tab_baselines") },
  ];

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <GitCompare className="w-5 h-5 text-[var(--brand)]" />
          <div>
            <h1 className="text-base font-semibold">{t("drift.title")}</h1>
            <p className="text-[11px] text-[var(--text-muted)]">{t("drift.subtitle")}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <PageInfoButton screenId="config-drift" />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => scanMut.mutate()}
            disabled={scanMut.isPending}
          >
            <ScanSearch className="w-3.5 h-3.5" />
            {scanMut.isPending ? t("drift.scanning") : t("drift.run_scan")}
          </Button>
        </div>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: t("drift.total_baselines"), value: summary?.total_baselines ?? "—", accent: "" },
          { label: t("drift.open_drifts"), value: summary?.open_drifts ?? "—", accent: "text-[var(--red)]" },
          { label: t("drift.last_scan"), value: fmtDate(summary?.last_scan_at ?? null), accent: "text-sm" },
        ].map(({ label, value, accent }) => (
          <div key={label} className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4">
            <p className="text-[11px] text-[var(--text-muted)] uppercase tracking-wide">{label}</p>
            <p className={`text-xl font-bold mt-1 ${accent}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
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

      {/* Events tab */}
      {tab === "events" && (
        <div className="space-y-3">
          <div className="flex gap-2 flex-wrap">
            {(["open", "acknowledged", "resolved", ""] as const).map(s => (
              <button
                key={s}
                onClick={() => setEventFilter(s)}
                className={[
                  "px-3 py-1 rounded-full text-xs font-medium border transition-colors",
                  eventFilter === s
                    ? "bg-[var(--brand)] text-white border-[var(--brand)]"
                    : "text-[var(--text-muted)] border-[var(--border)] hover:border-[var(--brand)]",
                ].join(" ")}
              >
                {s === "" ? t("drift.all") : t(`drift.state_${s}`)}
              </button>
            ))}
          </div>

          <div className="rounded-lg border border-[var(--border)] overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr>
                  {[
                    t("drift.col_resource"), t("drift.col_key"),
                    t("drift.col_expected"), t("drift.col_actual"),
                    t("drift.col_detected"), t("drift.col_state"),
                    t("drift.col_actions"),
                  ].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-medium text-[var(--text-muted)] whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {eventsQ.isLoading ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-[var(--text-muted)]">
                      {t("common.loading")}
                    </td>
                  </tr>
                ) : !eventsQ.data?.length ? (
                  <tr>
                    <td colSpan={7} className="px-3 py-8 text-center text-[var(--text-muted)]">
                      {t("drift.no_events")}
                    </td>
                  </tr>
                ) : eventsQ.data.map(ev => (
                  <tr key={ev.drift_id} className="hover:bg-[var(--surface-1)]">
                    <td className="px-3 py-2 font-mono max-w-[140px] truncate">{ev.resource_ref}</td>
                    <td className="px-3 py-2 font-mono max-w-[120px] truncate">{ev.config_key}</td>
                    <td className="px-3 py-2 text-[var(--green)] max-w-[100px] truncate">{ev.expected_value}</td>
                    <td className="px-3 py-2 text-[var(--red)] max-w-[100px] truncate">{ev.actual_value}</td>
                    <td className="px-3 py-2 text-[var(--text-muted)] whitespace-nowrap">{fmtDate(ev.detected_at)}</td>
                    <td className="px-3 py-2">
                      <Badge variant={stateVariant(ev.state)}>{t(`drift.state_${ev.state}`)}</Badge>
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1 justify-end">
                        {ev.state === "open" && (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => ackMut.mutate(ev.drift_id)}
                            disabled={ackMut.isPending}
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            {t("drift.acknowledge")}
                          </Button>
                        )}
                        {ev.state !== "resolved" && (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => resolveMut.mutate(ev.drift_id)}
                            disabled={resolveMut.isPending}
                          >
                            <XCircle className="w-3 h-3" />
                            {t("drift.resolve")}
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Baselines tab */}
      {tab === "baselines" && (
        <div className="space-y-3">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="w-3.5 h-3.5" />
              {t("drift.add_baseline")}
            </Button>
          </div>

          {/* Add baseline form (inline panel) */}
          {addOpen && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--surface-1)] p-4 space-y-3">
              <h3 className="text-sm font-medium">{t("drift.add_baseline")}</h3>
              <div className="grid grid-cols-2 gap-3">
                {(["source_id", "resource_ref", "config_key", "expected_value"] as const).map(f => (
                  <div key={f} className="space-y-1">
                    <label className="text-xs text-[var(--text-muted)]">{t(`drift.field_${f}`)}</label>
                    <input
                      value={form[f]}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                        setForm(prev => ({ ...prev, [f]: e.target.value }))
                      }
                      placeholder={t(`drift.placeholder_${f}`)}
                      className="w-full px-2.5 py-1.5 text-xs rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder-[var(--text-dim)] focus:outline-none focus:border-[var(--brand)]"
                    />
                  </div>
                ))}
              </div>
              <div className="flex gap-2 justify-end">
                <Button size="sm" variant="ghost" onClick={() => { setAddOpen(false); setForm({ ...EMPTY_FORM }); }}>
                  {t("common.cancel") ?? "Cancelar"}
                </Button>
                <Button
                  size="sm"
                  onClick={() => createMut.mutate()}
                  disabled={
                    createMut.isPending ||
                    !form.source_id || !form.resource_ref ||
                    !form.config_key || !form.expected_value
                  }
                >
                  {t("drift.save_baseline")}
                </Button>
              </div>
            </div>
          )}

          <div className="rounded-lg border border-[var(--border)] overflow-auto">
            <table className="w-full text-xs">
              <thead className="bg-[var(--surface-2)]">
                <tr>
                  {[
                    t("drift.col_resource"), t("drift.col_key"),
                    t("drift.col_expected"), t("drift.col_captured_by"),
                    t("drift.col_captured_at"), t("drift.col_actions"),
                  ].map(h => (
                    <th key={h} className="px-3 py-2 text-left font-medium text-[var(--text-muted)] whitespace-nowrap">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border)]">
                {baselinesQ.isLoading ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-[var(--text-muted)]">
                      {t("common.loading")}
                    </td>
                  </tr>
                ) : !baselinesQ.data?.length ? (
                  <tr>
                    <td colSpan={6} className="px-3 py-8 text-center text-[var(--text-muted)]">
                      {t("drift.no_baselines")}
                    </td>
                  </tr>
                ) : baselinesQ.data.map(b => (
                  <tr key={b.baseline_id} className="hover:bg-[var(--surface-1)]">
                    <td className="px-3 py-2 font-mono max-w-[140px] truncate">{b.resource_ref}</td>
                    <td className="px-3 py-2 font-mono max-w-[120px] truncate">{b.config_key}</td>
                    <td className="px-3 py-2 max-w-[140px] truncate">{b.expected_value}</td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">{b.captured_by ?? "—"}</td>
                    <td className="px-3 py-2 text-[var(--text-muted)] whitespace-nowrap">{fmtDate(b.captured_at)}</td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => deleteMut.mutate(b.baseline_id)}
                        disabled={deleteMut.isPending}
                      >
                        <Trash2 className="w-3.5 h-3.5 text-[var(--red)]" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
