import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { ShieldAlert, Plus, Trash2, ScanSearch, CheckCircle2, XCircle, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { api } from "@/api/client";
import { useToast } from "@/hooks/use-toast";
import { PageInfoButton } from "@/components/PageInfoButton";

interface Props {
  tenantId: string;
}

interface Rule {
  rule_id: string;
  name: string;
  description: string;
  severity: "critical" | "high" | "medium" | "low";
  condition_type: "metric_threshold" | "manual";
  condition_config: Record<string, unknown>;
  enabled: boolean;
  created_at: string;
}

interface Finding {
  finding_id: string;
  rule_id: string;
  rule_name: string;
  severity: "critical" | "high" | "medium" | "low";
  resource_ref: string | null;
  status: "open" | "resolved" | "false_positive";
  detail: string;
  remediation: string | null;
  found_at: string;
  resolved_at: string | null;
}

type Tab = "findings" | "rules";

function severityVariant(sev: string): "danger" | "warning" | "info" | "muted" {
  if (sev === "critical") return "danger";
  if (sev === "high") return "warning";
  if (sev === "medium") return "info";
  return "muted";
}

function statusVariant(s: string): "danger" | "muted" | "warning" {
  if (s === "open") return "danger";
  if (s === "false_positive") return "warning";
  return "muted";
}

function fmtDate(iso: string | null) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

export function SecurityAuditPage({ tenantId }: Props) {
  const { toast } = useToast();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("findings");
  const [statusFilter, setStatusFilter] = useState<string>("open");

  // ── Queries ──────────────────────────────────────────────────────────────

  const rulesQ = useQuery<Rule[]>({
    queryKey: ["sec-rules", tenantId],
    queryFn: () => api.get("/api/v1/security-audit/rules").then(r => r.data),
  });

  const findingsQ = useQuery<Finding[]>({
    queryKey: ["sec-findings", tenantId, statusFilter],
    queryFn: () =>
      api.get("/api/v1/security-audit/findings", {
        params: { status_filter: statusFilter || undefined, limit: 200 },
      }).then(r => r.data),
  });

  // ── Mutations ─────────────────────────────────────────────────────────────

  const scanMut = useMutation({
    mutationFn: () => api.post("/api/v1/security-audit/scan", {}),
    onSuccess: (res) => {
      const { created, skipped, rules_evaluated } = res.data;
      toast(`Scan concluído: ${created} finding(s) criados, ${rules_evaluated} regras avaliadas.`, "success");
      qc.invalidateQueries({ queryKey: ["sec-findings", tenantId] });
    },
    onError: () => toast("Erro ao executar scan.", "error"),
  });

  const deleteRuleMut = useMutation({
    mutationFn: (rule_id: string) =>
      api.delete(`/api/v1/security-audit/rules/${rule_id}`),
    onSuccess: () => {
      toast("Regra removida.", "success");
      qc.invalidateQueries({ queryKey: ["sec-rules", tenantId] });
      qc.invalidateQueries({ queryKey: ["sec-findings", tenantId] });
    },
    onError: () => toast("Erro ao remover regra.", "error"),
  });

  const resolveFindingMut = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/api/v1/security-audit/findings/${id}`, { status }),
    onSuccess: () => {
      toast("Finding atualizado.", "success");
      qc.invalidateQueries({ queryKey: ["sec-findings", tenantId] });
    },
    onError: () => toast("Erro ao atualizar finding.", "error"),
  });

  // ── New Rule Form ─────────────────────────────────────────────────────────

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    name: "", description: "", severity: "medium", condition_type: "manual",
  });

  const createRuleMut = useMutation({
    mutationFn: () =>
      api.post("/api/v1/security-audit/rules", {
        name: form.name.trim(),
        description: form.description,
        severity: form.severity,
        condition_type: form.condition_type,
        condition_config: {},
      }),
    onSuccess: () => {
      toast("Regra criada.", "success");
      setForm({ name: "", description: "", severity: "medium", condition_type: "manual" });
      setShowForm(false);
      qc.invalidateQueries({ queryKey: ["sec-rules", tenantId] });
    },
    onError: (e: any) => {
      const msg = e?.response?.data?.detail ?? "Erro ao criar regra.";
      toast(msg, "error");
    },
  });

  // ── Render ────────────────────────────────────────────────────────────────

  const findings = findingsQ.data ?? [];
  const rules = rulesQ.data ?? [];

  const openCount = (findingsQ.data ?? []).filter(f => f.status === "open").length;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ShieldAlert size={20} className="text-[var(--red)]" />
          <h1 className="text-lg font-semibold text-[var(--fg)]">Auditoria de Segurança</h1>
          {openCount > 0 && (
            <Badge variant="danger" className="ml-1">{openCount} aberto{openCount !== 1 ? "s" : ""}</Badge>
          )}
          <PageInfoButton page="security-audit" />
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => scanMut.mutate()}
          disabled={scanMut.isPending}
          className="flex items-center gap-1.5"
        >
          <ScanSearch size={14} />
          {scanMut.isPending ? "Executando..." : "Executar Scan"}
        </Button>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        {(["findings", "rules"] as Tab[]).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t
                ? "border-[var(--accent)] text-[var(--accent)]"
                : "border-transparent text-[var(--muted)] hover:text-[var(--fg)]"
            }`}
          >
            {t === "findings" ? "Findings" : "Regras"}
          </button>
        ))}
      </div>

      {/* ── Findings Tab ── */}
      {tab === "findings" && (
        <div className="space-y-4">
          {/* Filter */}
          <div className="flex gap-2">
            {["open", "resolved", "false_positive", ""].map(s => (
              <button
                key={s || "all"}
                onClick={() => setStatusFilter(s)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? "bg-[var(--accent)] text-white"
                    : "bg-[var(--surface)] text-[var(--muted)] hover:text-[var(--fg)]"
                }`}
              >
                {s === "" ? "Todos" : s === "open" ? "Abertos" : s === "resolved" ? "Resolvidos" : "Falso positivo"}
              </button>
            ))}
          </div>

          {findingsQ.isLoading ? (
            <p className="text-sm text-[var(--muted)]">Carregando...</p>
          ) : findings.length === 0 ? (
            <p className="text-sm text-[var(--muted)] py-8 text-center">Nenhum finding encontrado.</p>
          ) : (
            <div className="border border-[var(--border)] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[var(--surface)] text-[var(--muted)] text-xs uppercase">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Regra</th>
                    <th className="px-4 py-2.5 text-left">Severidade</th>
                    <th className="px-4 py-2.5 text-left">Recurso</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                    <th className="px-4 py-2.5 text-left">Encontrado</th>
                    <th className="px-4 py-2.5 text-left">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {findings.map(f => (
                    <tr key={f.finding_id} className="hover:bg-[var(--surface-hover)]">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-[var(--fg)]">{f.rule_name}</div>
                        {f.detail && f.detail !== "pending_manual_review" && (
                          <div className="text-[10px] text-[var(--muted)] mt-0.5 max-w-xs truncate">{f.detail}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={severityVariant(f.severity)}>{f.severity}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--muted)]">
                        {f.resource_ref ?? "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={statusVariant(f.status)}>
                          {f.status === "open" ? "aberto" : f.status === "resolved" ? "resolvido" : "falso positivo"}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--muted)] text-xs whitespace-nowrap">
                        {fmtDate(f.found_at)}
                      </td>
                      <td className="px-4 py-2.5">
                        {f.status === "open" && (
                          <div className="flex gap-2">
                            <button
                              onClick={() => resolveFindingMut.mutate({ id: f.finding_id, status: "resolved" })}
                              disabled={resolveFindingMut.isPending}
                              className="text-[10px] text-[var(--green)] underline whitespace-nowrap disabled:opacity-50"
                            >
                              Resolver
                            </button>
                            <button
                              onClick={() => resolveFindingMut.mutate({ id: f.finding_id, status: "false_positive" })}
                              disabled={resolveFindingMut.isPending}
                              className="text-[10px] text-[var(--muted)] underline whitespace-nowrap disabled:opacity-50"
                            >
                              Falso+
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ── Rules Tab ── */}
      {tab === "rules" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setShowForm(v => !v)} className="flex items-center gap-1.5">
              <Plus size={14} />
              Nova Regra
            </Button>
          </div>

          {showForm && (
            <div className="border border-[var(--border)] rounded-lg p-4 space-y-3 bg-[var(--surface)]">
              <h3 className="text-sm font-semibold text-[var(--fg)]">Nova Regra</h3>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Nome *</label>
                  <input
                    className="w-full px-3 py-1.5 text-sm rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
                    value={form.name}
                    onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                    placeholder="Ex: CPU alta"
                  />
                </div>
                <div>
                  <label className="block text-xs text-[var(--muted)] mb-1">Severidade</label>
                  <select
                    className="w-full px-3 py-1.5 text-sm rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
                    value={form.severity}
                    onChange={e => setForm(f => ({ ...f, severity: e.target.value }))}
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Descrição</label>
                <input
                  className="w-full px-3 py-1.5 text-sm rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  placeholder="Descreva o que esta regra verifica"
                />
              </div>
              <div>
                <label className="block text-xs text-[var(--muted)] mb-1">Tipo de condição</label>
                <select
                  className="w-full px-3 py-1.5 text-sm rounded border border-[var(--border)] bg-[var(--bg)] text-[var(--fg)]"
                  value={form.condition_type}
                  onChange={e => setForm(f => ({ ...f, condition_type: e.target.value }))}
                >
                  <option value="manual">Manual (checklist)</option>
                  <option value="metric_threshold">Threshold de métrica</option>
                </select>
              </div>
              <div className="flex gap-2 justify-end pt-1">
                <Button size="sm" variant="outline" onClick={() => setShowForm(false)}>Cancelar</Button>
                <Button
                  size="sm"
                  onClick={() => createRuleMut.mutate()}
                  disabled={createRuleMut.isPending || !form.name.trim()}
                >
                  {createRuleMut.isPending ? "Salvando..." : "Criar Regra"}
                </Button>
              </div>
            </div>
          )}

          {rulesQ.isLoading ? (
            <p className="text-sm text-[var(--muted)]">Carregando...</p>
          ) : rules.length === 0 ? (
            <p className="text-sm text-[var(--muted)] py-8 text-center">
              Nenhuma regra criada. Crie a primeira regra para iniciar a auditoria.
            </p>
          ) : (
            <div className="border border-[var(--border)] rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-[var(--surface)] text-[var(--muted)] text-xs uppercase">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Nome</th>
                    <th className="px-4 py-2.5 text-left">Severidade</th>
                    <th className="px-4 py-2.5 text-left">Tipo</th>
                    <th className="px-4 py-2.5 text-left">Status</th>
                    <th className="px-4 py-2.5 text-left">Criado</th>
                    <th className="px-4 py-2.5 text-left">Ações</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {rules.map(r => (
                    <tr key={r.rule_id} className="hover:bg-[var(--surface-hover)]">
                      <td className="px-4 py-2.5">
                        <div className="font-medium text-[var(--fg)]">{r.name}</div>
                        {r.description && (
                          <div className="text-[10px] text-[var(--muted)] mt-0.5 max-w-xs truncate">{r.description}</div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={severityVariant(r.severity)}>{r.severity}</Badge>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--muted)] text-xs">
                        {r.condition_type === "manual" ? "Manual" : "Threshold"}
                      </td>
                      <td className="px-4 py-2.5">
                        {r.enabled ? (
                          <span className="text-xs text-[var(--green)] flex items-center gap-1">
                            <CheckCircle2 size={12} /> Ativa
                          </span>
                        ) : (
                          <span className="text-xs text-[var(--muted)] flex items-center gap-1">
                            <XCircle size={12} /> Inativa
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--muted)] text-xs whitespace-nowrap">
                        {fmtDate(r.created_at)}
                      </td>
                      <td className="px-4 py-2.5">
                        <button
                          onClick={() => {
                            if (confirm(`Remover regra "${r.name}"? Os findings associados também serão removidos.`)) {
                              deleteRuleMut.mutate(r.rule_id);
                            }
                          }}
                          disabled={deleteRuleMut.isPending}
                          className="text-[var(--red)] hover:opacity-70 disabled:opacity-30"
                          title="Remover regra"
                        >
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
