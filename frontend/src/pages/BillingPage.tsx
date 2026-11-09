import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { FileText, CheckCircle, XCircle, DollarSign, TrendingUp, Clock } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Invoice {
  invoice_id: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
  currency: string;
  status: string;
  due_at?: string;
  paid_at?: string;
  created_at: string;
  line_items?: { description: string; quantity: number; unit_price_cents: number }[];
}

interface BillingSummary {
  adapter: string;
  open_invoices: { count: number; amount_cents: number; currency: string }[];
  current_month_usage: { meter: string; total_quantity: number; since?: string }[];
  last_paid_invoice?: {
    invoice_id: string; amount_cents: number; currency: string; paid_at?: string;
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

const STATUS_COLORS: Record<string, "muted" | "info" | "warning" | "success" | "danger"> = {
  draft: "muted", open: "warning", paid: "success", void: "muted",
};

const STATUS_LABELS: Record<string, string> = {
  draft: "Rascunho", open: "Em aberto", paid: "Pago", void: "Cancelado",
};

function fmtCents(cents: number, currency = "BRL") {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency }).format(cents / 100);
}

function fmtDate(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString("pt-BR"); } catch { return iso; }
}

function fmtPeriod(start?: string, end?: string) {
  if (!start || !end) return "—";
  return `${fmtDate(start)} – ${fmtDate(end)}`;
}

const METER_LABELS: Record<string, string> = {
  api_requests: "Requisições API",
  monitored_hosts: "Hosts monitorados",
  alert_evaluations: "Avaliações de alerta",
  synthetic_checks: "Checks sintéticos",
  report_exports: "Relatórios gerados",
  storage_gb: "Armazenamento (GB)",
};

// ── Invoice Detail ────────────────────────────────────────────────────────────

function InvoiceDetail({
  invoice, canAdmin, onAction,
}: { invoice: Invoice; canAdmin: boolean; onAction: () => void }) {
  const paid = useMutation({
    mutationFn: () => api.post(`/api/v1/billing/invoices/${invoice.invoice_id}/mark-paid`, {}),
    onSuccess: onAction,
  });
  const voidMut = useMutation({
    mutationFn: () => api.post(`/api/v1/billing/invoices/${invoice.invoice_id}/void`, {}),
    onSuccess: onAction,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p className="text-xs text-[var(--text-muted)]">{invoice.invoice_id}</p>
          <p className="text-sm font-semibold mt-0.5">{fmtPeriod(invoice.period_start, invoice.period_end)}</p>
        </div>
        {canAdmin && invoice.status === "open" && (
          <div className="flex gap-1.5">
            <Button size="sm" onClick={() => paid.mutate()} disabled={paid.isPending}>
              <CheckCircle className="w-3 h-3" /> Marcar pago
            </Button>
            <Button size="sm" variant="ghost" onClick={() => voidMut.mutate()} disabled={voidMut.isPending}>
              <XCircle className="w-3 h-3" /> Cancelar
            </Button>
          </div>
        )}
        {canAdmin && invoice.status === "draft" && (
          <Button size="sm" variant="ghost" onClick={() => voidMut.mutate()} disabled={voidMut.isPending}>
            <XCircle className="w-3 h-3" /> Cancelar
          </Button>
        )}
      </div>

      <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs">
        <div className="text-[var(--text-muted)]">Total</div>
        <div className="font-semibold text-[var(--text)]">{fmtCents(invoice.amount_cents, invoice.currency)}</div>
        <div className="text-[var(--text-muted)]">Status</div>
        <div><Badge variant={STATUS_COLORS[invoice.status]}>{STATUS_LABELS[invoice.status] ?? invoice.status}</Badge></div>
        <div className="text-[var(--text-muted)]">Vencimento</div>
        <div className={!invoice.due_at ? "" : new Date(invoice.due_at) < new Date() && invoice.status === "open" ? "text-red-400" : ""}>
          {fmtDate(invoice.due_at)}
        </div>
        {invoice.paid_at && <>
          <div className="text-[var(--text-muted)]">Pago em</div>
          <div className="text-green-500">{fmtDate(invoice.paid_at)}</div>
        </>}
      </div>

      {invoice.line_items && invoice.line_items.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Itens</p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[var(--text-muted)] border-b border-[var(--border)]">
                  <th className="text-left pb-1 font-medium">Descrição</th>
                  <th className="text-right pb-1 font-medium">Qtd</th>
                  <th className="text-right pb-1 font-medium">Unit.</th>
                  <th className="text-right pb-1 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {invoice.line_items.map((item, i) => (
                  <tr key={i} className="border-b border-[var(--border)] last:border-0">
                    <td className="py-1 text-[var(--text)]">{item.description}</td>
                    <td className="py-1 text-right text-[var(--text-muted)]">{item.quantity}</td>
                    <td className="py-1 text-right text-[var(--text-muted)]">{fmtCents(item.unit_price_cents, invoice.currency)}</td>
                    <td className="py-1 text-right font-medium">{fmtCents(item.quantity * item.unit_price_cents, invoice.currency)}</td>
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

// ── Main Page ─────────────────────────────────────────────────────────────────

export function BillingPage({ tenantId, permissions = [] }: {
  tenantId: string;
  permissions?: string[];
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [selected, setSelected] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string>("");

  const canAdmin = permissions.includes("tenant:admin");

  const { data: summary, isLoading: loadingSummary } = useQuery({
    queryKey: ["billing-summary", tenantId],
    queryFn: () => api.get<BillingSummary>("/api/v1/billing/summary"),
    refetchInterval: 60_000,
  });

  const { data: invoices = [], isLoading: loadingInvoices } = useQuery({
    queryKey: ["billing-invoices", tenantId, statusFilter],
    queryFn: () =>
      api.get<Invoice[]>(`/api/v1/billing/invoices${statusFilter ? `?inv_status=${statusFilter}` : ""}`),
    refetchInterval: 60_000,
  });

  const selectedInvoice = invoices.find(i => i.invoice_id === selected) ?? null;

  function invalidate() {
    qc.invalidateQueries({ queryKey: ["billing-invoices", tenantId] });
    qc.invalidateQueries({ queryKey: ["billing-summary", tenantId] });
    setSelected(null);
  }

  const totalOpen = summary?.open_invoices.reduce((s, x) => s + x.amount_cents, 0) ?? 0;
  const openCurrency = summary?.open_invoices[0]?.currency ?? "BRL";

  return (
    <div className="p-4 space-y-4">
      {/* Header */}
      <div>
        <h2 className="text-base font-semibold">{t("nav.billing", "Faturamento")}</h2>
        <p className="text-xs text-[var(--text-muted)] mt-0.5">
          Faturas e uso do período atual
        </p>
      </div>

      {/* Summary tiles */}
      {loadingSummary
        ? <Spinner className="w-4 h-4" />
        : summary && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <Card className="p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <DollarSign className="w-3 h-3" /> Em aberto
              </div>
              <p className="text-xl font-bold text-[var(--text)] font-mono">
                {fmtCents(totalOpen, openCurrency)}
              </p>
              <p className="text-xs text-[var(--text-muted)]">
                {summary.open_invoices.reduce((s, x) => s + x.count, 0)} fatura(s)
              </p>
            </Card>

            {summary.last_paid_invoice && (
              <Card className="p-3 space-y-1">
                <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-green-500">
                  <CheckCircle className="w-3 h-3" /> Último pagamento
                </div>
                <p className="text-xl font-bold text-[var(--text)] font-mono">
                  {fmtCents(summary.last_paid_invoice.amount_cents, summary.last_paid_invoice.currency)}
                </p>
                <p className="text-xs text-[var(--text-muted)]">{fmtDate(summary.last_paid_invoice.paid_at)}</p>
              </Card>
            )}

            <Card className="p-3 space-y-1">
              <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                <TrendingUp className="w-3 h-3" /> Adapter
              </div>
              <p className="text-sm font-semibold capitalize">{summary.adapter}</p>
              <p className="text-xs text-[var(--text-muted)]">Motor de faturamento</p>
            </Card>
          </div>
        )}

      {/* Usage meters */}
      {summary && summary.current_month_usage.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
            Uso no mês atual
          </p>
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
            {summary.current_month_usage.map(u => (
              <div key={u.meter}
                className="bg-[var(--surface-2)] border border-[var(--border)] rounded p-2.5">
                <p className="text-[10px] text-[var(--text-muted)] mb-1">
                  {METER_LABELS[u.meter] ?? u.meter}
                </p>
                <p className="text-sm font-semibold font-mono">
                  {u.total_quantity.toLocaleString("pt-BR")}
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Filter */}
      <div className="flex gap-1 flex-wrap">
        {["", "open", "draft", "paid", "void"].map(s => (
          <button key={s}
            onClick={() => { setStatusFilter(s); setSelected(null); }}
            className={`text-xs px-3 py-1 rounded-full border transition-colors ${
              statusFilter === s
                ? "bg-[var(--brand)] text-white border-transparent"
                : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--brand)]"
            }`}>
            {s ? STATUS_LABELS[s] : "Todas"}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Invoice list */}
        <div className="space-y-2">
          {loadingInvoices && <Spinner className="w-4 h-4 mx-auto mt-8" />}

          {!loadingInvoices && invoices.length === 0 && (
            <Card className="p-8 text-center">
              <FileText className="w-8 h-8 mx-auto text-[var(--text-muted)] mb-2" />
              <p className="text-sm text-[var(--text-muted)]">Nenhuma fatura encontrada</p>
            </Card>
          )}

          {invoices.map(inv => (
            <div key={inv.invoice_id} className="cursor-pointer" onClick={() => setSelected(selected === inv.invoice_id ? null : inv.invoice_id)}>
            <Card
              className={`p-3 transition-colors hover:border-[var(--brand)] ${
                selected === inv.invoice_id ? "border-[var(--brand)] bg-[var(--surface-2)]" : ""
              }`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 mb-1">
                    <Badge variant={STATUS_COLORS[inv.status]}>{STATUS_LABELS[inv.status] ?? inv.status}</Badge>
                  </div>
                  <p className="text-xs font-medium text-[var(--text)]">
                    {fmtPeriod(inv.period_start, inv.period_end)}
                  </p>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-sm font-semibold font-mono text-[var(--text)]">
                      {fmtCents(inv.amount_cents, inv.currency)}
                    </span>
                    {inv.due_at && inv.status === "open" && (
                      <span className={`flex items-center gap-0.5 text-[10px] ${
                        new Date(inv.due_at) < new Date() ? "text-red-400" : "text-[var(--text-muted)]"
                      }`}>
                        <Clock className="w-2.5 h-2.5" />
                        Vence {fmtDate(inv.due_at)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            </Card>
            </div>
          ))}
        </div>

        {/* Detail panel */}
        {selectedInvoice && (
          <Card className="p-4 h-fit sticky top-4">
            <InvoiceDetail invoice={selectedInvoice} canAdmin={canAdmin} onAction={invalidate} />
          </Card>
        )}
      </div>
    </div>
  );
}
