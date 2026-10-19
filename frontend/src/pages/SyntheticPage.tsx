import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useCanOperate } from "@/hooks/usePermission";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { useToast } from "@/components/ui/toast";

interface SyntheticCheck {
  check_id: string;
  name: string;
  url: string;
  method: string;
  expected_status: number;
  timeout_seconds: number;
  interval_seconds: number;
  enabled: boolean;
  last_checked_at: string | null;
  last_ok: boolean | null;
  last_status_code: number | null;
  last_response_ms: number | null;
  last_error: string | null;
  created_at: string;
}

interface CheckResult {
  result_id: string;
  checked_at: string;
  ok: boolean;
  status_code: number | null;
  response_ms: number | null;
  error: string | null;
}

function statusBadge(check: SyntheticCheck) {
  if (check.last_checked_at === null)
    return <Badge variant="muted">Pendente</Badge>;
  if (check.last_ok)
    return <Badge variant="success">OK</Badge>;
  return <Badge variant="danger">FAIL</Badge>;
}

function fmtMs(ms: number | null): string {
  if (ms === null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtInterval(s: number): string {
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const diff = Date.now() - new Date(iso).getTime();
  const s = Math.floor(diff / 1000);
  if (s < 60) return `${s}s atrás`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m atrás`;
  return `${Math.floor(m / 60)}h atrás`;
}

const INTERVAL_OPTIONS = [
  { label: "30s", value: 30 },
  { label: "1m", value: 60 },
  { label: "5m", value: 300 },
  { label: "15m", value: 900 },
  { label: "30m", value: 1800 },
  { label: "1h", value: 3600 },
];

function CheckForm({
  initial,
  onSave,
  onCancel,
  isPending,
}: {
  initial?: Partial<SyntheticCheck>;
  onSave: (data: {
    name: string; url: string; method: string;
    expected_status: number; timeout_seconds: number;
    interval_seconds: number; enabled: boolean;
  }) => void;
  onCancel: () => void;
  isPending: boolean;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [url, setUrl] = useState(initial?.url ?? "");
  const [method, setMethod] = useState(initial?.method ?? "GET");
  const [expectedStatus, setExpectedStatus] = useState(initial?.expected_status ?? 200);
  const [timeout, setTimeout_] = useState(initial?.timeout_seconds ?? 10);
  const [interval, setInterval_] = useState(initial?.interval_seconds ?? 300);
  const [enabled, setEnabled] = useState(initial?.enabled ?? true);

  const inp = "w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]";

  return (
    <Card className="p-4 space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Nome</label>
          <input className={inp} value={name} onChange={(e) => setName(e.target.value)}
            placeholder="ex: Site principal" />
        </div>
        <div className="col-span-2 space-y-1">
          <label className="text-xs text-[var(--text-muted)]">URL</label>
          <input className={inp} value={url} onChange={(e) => setUrl(e.target.value)}
            placeholder="https://exemplo.com/health" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Método</label>
          <select className={inp} value={method} onChange={(e) => setMethod(e.target.value)}>
            <option value="GET">GET</option>
            <option value="HEAD">HEAD</option>
            <option value="POST">POST</option>
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Status esperado</label>
          <input className={inp} type="number" min={100} max={599}
            value={expectedStatus} onChange={(e) => setExpectedStatus(Number(e.target.value))} />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Intervalo</label>
          <select className={inp} value={interval} onChange={(e) => setInterval_(Number(e.target.value))}>
            {INTERVAL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>
        <div className="space-y-1">
          <label className="text-xs text-[var(--text-muted)]">Timeout (s)</label>
          <input className={inp} type="number" min={1} max={30}
            value={timeout} onChange={(e) => setTimeout_(Number(e.target.value))} />
        </div>
      </div>
      <label className="flex items-center gap-2 text-xs text-[var(--text)] cursor-pointer">
        <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)}
          className="rounded" />
        Habilitado
      </label>
      <div className="flex gap-2">
        <Button size="sm" disabled={isPending || !name.trim() || !url.trim()}
          onClick={() => onSave({ name, url, method, expected_status: expectedStatus,
            timeout_seconds: timeout, interval_seconds: interval, enabled })}>
          {isPending && <Spinner className="w-3 h-3 mr-1" />}
          Salvar
        </Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancelar</Button>
      </div>
    </Card>
  );
}

function ResultsTimeline({ checkId, tenantId: _tenantId }: { checkId: string; tenantId: string }) {
  const q = useQuery({
    queryKey: ["synthetic-results", checkId],
    queryFn: () => api.get<CheckResult[]>(`/api/v1/synthetic/checks/${checkId}/results?limit=30`),
    refetchInterval: 30_000,
  });

  if (q.isLoading) return <div className="flex justify-center py-3"><Spinner /></div>;
  if (q.isError) return <p className="text-[10px] text-[var(--red)]">Erro ao carregar resultados.</p>;
  const results = q.data ?? [];
  if (results.length === 0)
    return <p className="text-[10px] text-[var(--text-muted)]">Sem resultados ainda.</p>;

  return (
    <div className="space-y-2">
      <div className="flex gap-0.5" title="Últimos resultados (mais recente à direita)">
        {[...results].reverse().map((r) => (
          <div
            key={r.result_id}
            title={`${new Date(r.checked_at).toLocaleString()} — ${r.ok ? "OK" : "FAIL"} ${r.status_code ?? ""} ${r.response_ms != null ? r.response_ms + "ms" : ""}${r.error ? " — " + r.error : ""}`}
            className={`h-4 flex-1 rounded-sm ${r.ok ? "bg-[var(--green,#22c55e)]" : "bg-[var(--red)]"}`}
          />
        ))}
      </div>
      <div className="space-y-1">
        {results.slice(0, 5).map((r) => (
          <div key={r.result_id} className="flex items-center gap-3 text-[10px] text-[var(--text-muted)]">
            <span className={`font-medium ${r.ok ? "text-[var(--green,#22c55e)]" : "text-[var(--red)]"}`}>
              {r.ok ? "OK" : "FAIL"}
            </span>
            <span className="font-mono">{r.status_code ?? "—"}</span>
            <span>{fmtMs(r.response_ms)}</span>
            <span>{new Date(r.checked_at).toLocaleString()}</span>
            {r.error && (
              <span className="truncate max-w-[200px] text-[var(--red)]">{r.error}</span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function CheckRow({
  check,
  tenantId,
  canOperate,
  onDelete,
}: {
  check: SyntheticCheck;
  tenantId: string;
  canOperate: boolean;
  onDelete: () => void;
}) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);

  const runMut = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; status_code: number | null; response_ms: number; error: string | null }>(
        `/api/v1/synthetic/checks/${check.check_id}/run`, {}),
    onSuccess: (r) => {
      toast(r.ok ? `OK — ${r.status_code} em ${r.response_ms}ms` : `FAIL — ${r.status_code ?? r.error}`,
        r.ok ? "success" : "error");
      qc.invalidateQueries({ queryKey: ["synthetic-checks"] });
      qc.invalidateQueries({ queryKey: ["synthetic-results", check.check_id] });
    },
    onError: () => toast("Erro ao executar check.", "error"),
  });

  const toggleMut = useMutation({
    mutationFn: () =>
      api.patch(`/api/v1/synthetic/checks/${check.check_id}`, { enabled: !check.enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["synthetic-checks"] });
    },
    onError: () => toast("Erro ao atualizar check.", "error"),
  });

  const updateMut = useMutation({
    mutationFn: (data: Partial<SyntheticCheck>) =>
      api.patch(`/api/v1/synthetic/checks/${check.check_id}`, data),
    onSuccess: () => {
      toast("Check atualizado.", "success");
      qc.invalidateQueries({ queryKey: ["synthetic-checks"] });
      setEditing(false);
    },
    onError: (e: unknown) => {
      toast((e as { detail?: string })?.detail ?? "Erro ao atualizar.", "error");
    },
  });

  if (editing) {
    return (
      <CheckForm
        initial={check}
        onSave={(data) => updateMut.mutate(data)}
        onCancel={() => setEditing(false)}
        isPending={updateMut.isPending}
      />
    );
  }

  return (
    <div className="border border-[var(--border)] rounded-lg overflow-hidden">
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex-shrink-0">{statusBadge(check)}</div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-[var(--text)] truncate">
              {check.name}
            </span>
            {!check.enabled && (
              <span className="text-[10px] text-[var(--text-muted)] border border-[var(--border)] rounded px-1">
                desabilitado
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 mt-0.5 text-[10px] text-[var(--text-muted)]">
            <span className="font-mono truncate max-w-[240px]">{check.url}</span>
            <span>·</span>
            <span>{check.method}</span>
            <span>·</span>
            <span>a cada {fmtInterval(check.interval_seconds)}</span>
            {check.last_response_ms !== null && (
              <>
                <span>·</span>
                <span>{fmtMs(check.last_response_ms)}</span>
              </>
            )}
            {check.last_checked_at && (
              <>
                <span>·</span>
                <span>{fmtAgo(check.last_checked_at)}</span>
              </>
            )}
          </div>
        </div>
        {canOperate && (
          <div className="flex items-center gap-2 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
            <button
              onClick={() => runMut.mutate()}
              disabled={runMut.isPending}
              className="text-[10px] text-[var(--brand)] underline disabled:opacity-40"
            >
              {runMut.isPending ? "executando…" : "executar"}
            </button>
            <button
              onClick={() => toggleMut.mutate()}
              disabled={toggleMut.isPending}
              className="text-[10px] text-[var(--text-muted)] underline"
            >
              {check.enabled ? "pausar" : "ativar"}
            </button>
            <button
              onClick={() => setEditing(true)}
              className="text-[10px] text-[var(--text-muted)] underline"
            >
              editar
            </button>
            <button
              onClick={onDelete}
              className="text-[10px] text-[var(--text-muted)] hover:text-[var(--red)] underline"
            >
              remover
            </button>
          </div>
        )}
        <span className="text-[var(--text-muted)] text-xs flex-shrink-0">
          {expanded ? "▲" : "▼"}
        </span>
      </div>
      {expanded && (
        <div className="border-t border-[var(--border)] px-4 py-3 bg-[var(--surface-2)]">
          <ResultsTimeline checkId={check.check_id} tenantId={tenantId} />
        </div>
      )}
    </div>
  );
}

export function SyntheticPage({ tenantId }: { tenantId: string }) {
  const canOperate = useCanOperate();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["synthetic-checks", tenantId],
    queryFn: () => api.get<SyntheticCheck[]>("/api/v1/synthetic/checks"),
    refetchInterval: 30_000,
  });

  const createMut = useMutation({
    mutationFn: (data: Omit<SyntheticCheck, "check_id" | "last_checked_at" | "last_ok" | "last_status_code" | "last_response_ms" | "last_error" | "created_at">) =>
      api.post("/api/v1/synthetic/checks", data),
    onSuccess: () => {
      toast("Check criado.", "success");
      qc.invalidateQueries({ queryKey: ["synthetic-checks"] });
      setAdding(false);
    },
    onError: (e: unknown) => {
      toast((e as { detail?: string })?.detail ?? "Erro ao criar check.", "error");
    },
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => api.delete(`/api/v1/synthetic/checks/${id}`),
    onSuccess: () => {
      toast("Check removido.", "success");
      qc.invalidateQueries({ queryKey: ["synthetic-checks"] });
      setDeletingId(null);
    },
    onError: () => toast("Erro ao remover.", "error"),
  });

  const checks = q.data ?? [];
  const deletingCheck = checks.find((c) => c.check_id === deletingId);

  const okCount = checks.filter((c) => c.last_ok === true).length;
  const failCount = checks.filter((c) => c.last_ok === false).length;

  return (
    <div className="space-y-4">
      {deletingId && deletingCheck && (
        <ConfirmModal
          title="Remover check"
          description={`Remover "${deletingCheck.name}"? Os resultados históricos também serão excluídos.`}
          confirmLabel="Remover"
          destructive
          isPending={deleteMut.isPending}
          onConfirm={() => deleteMut.mutate(deletingId)}
          onCancel={() => setDeletingId(null)}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Monitoramento Sintético</h2>
          <p className="text-xs text-[var(--text-muted)] mt-0.5">
            Checks HTTP periódicos para verificar disponibilidade de URLs.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {checks.length > 0 && (
            <div className="flex items-center gap-2 text-xs">
              {okCount > 0 && (
                <span className="text-[var(--green,#22c55e)] font-medium">{okCount} OK</span>
              )}
              {failCount > 0 && (
                <span className="text-[var(--red)] font-medium">{failCount} FAIL</span>
              )}
            </div>
          )}
          {canOperate && !adding && (
            <Button size="sm" onClick={() => setAdding(true)}>
              Novo check
            </Button>
          )}
        </div>
      </div>

      {canOperate && adding && (
        <CheckForm
          onSave={(data) => createMut.mutate(data as Parameters<typeof createMut.mutate>[0])}
          onCancel={() => setAdding(false)}
          isPending={createMut.isPending}
        />
      )}

      {q.isLoading ? (
        <div className="flex justify-center py-8"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Erro ao carregar checks.</p>
      ) : checks.length === 0 && !adding ? (
        <Card className="p-6 text-center">
          <p className="text-sm text-[var(--text-muted)]">
            Nenhum check configurado.
          </p>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Adicione um check HTTP para monitorar a disponibilidade de sites e APIs.
          </p>
        </Card>
      ) : (
        <div className="space-y-2">
          {checks.map((check) => (
            <CheckRow
              key={check.check_id}
              check={check}
              tenantId={tenantId}
              canOperate={canOperate}
              onDelete={() => setDeletingId(check.check_id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
