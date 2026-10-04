import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { AlertTriangle, CheckCircle2, HelpCircle, RefreshCw, Activity, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";

interface ClientHealth {
  tenant_id: string;
  display_name: string;
  health: "ok" | "warning" | "critical" | "unknown";
  active_alerts: number;
  critical_alerts: number;
  warning_alerts: number;
  source_count: number;
}

interface MSPData {
  clients: ClientHealth[];
  own_tenant_id: string;
}

interface ClientAlert {
  alert_id: string;
  source_kind: string;
  lifecycle_state: string;
  severity: string | null;
  monitoring_resource_id: string | null;
  opened_at: string | null;
}

interface ClientDetail {
  tenant_id: string;
  alerts: ClientAlert[];
}

function HealthBadge({ health }: { health: ClientHealth["health"] }) {
  if (health === "critical")
    return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
        style={{ background: "color-mix(in srgb, var(--red) 15%, transparent)", color: "var(--red)" }}>
        <AlertTriangle size={11} strokeWidth={2.5} />
        Crítico
      </span>
    );
  if (health === "warning")
    return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
        style={{ background: "color-mix(in srgb, var(--yellow, #f59e0b) 15%, transparent)", color: "var(--yellow, #f59e0b)" }}>
        <AlertTriangle size={11} strokeWidth={2.5} />
        Atenção
      </span>
    );
  if (health === "ok")
    return (
      <span className="flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full"
        style={{ background: "color-mix(in srgb, var(--green, #10b981) 15%, transparent)", color: "var(--green, #10b981)" }}>
        <CheckCircle2 size={11} strokeWidth={2.5} />
        Operacional
      </span>
    );
  return (
    <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full"
      style={{ background: "var(--surface-2)", color: "var(--text-muted)" }}>
      <HelpCircle size={11} />
      Desconhecido
    </span>
  );
}

function HealthDot({ health }: { health: ClientHealth["health"] }) {
  const colors: Record<string, string> = {
    critical: "var(--red)",
    warning: "var(--yellow, #f59e0b)",
    ok: "var(--green, #10b981)",
    unknown: "var(--text-dim)",
  };
  return (
    <span
      className="w-2.5 h-2.5 rounded-full flex-shrink-0"
      style={{
        background: colors[health] ?? colors.unknown,
        boxShadow: health === "critical" ? `0 0 6px color-mix(in srgb, var(--red) 60%, transparent)` : undefined,
      }}
    />
  );
}

function sevVariant(s: string | null): "danger" | "warning" | "info" | "muted" {
  if (s === "critical") return "danger";
  if (s === "warning" || s === "degraded") return "warning";
  if (s === "info") return "info";
  return "muted";
}

function fmtTs(iso: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function ClientDetailPanel({
  client,
  onClose,
}: {
  client: ClientHealth;
  onClose: () => void;
}) {
  const q = useQuery<ClientDetail>({
    queryKey: ["msp-client-detail", client.tenant_id],
    queryFn: () => api.get<ClientDetail>(`/api/v1/msp/clients/${client.tenant_id}/detail`),
    refetchInterval: 30_000,
  });

  const alerts = q.data?.alerts ?? [];

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40"
        style={{ background: "rgba(0,0,0,0.35)" }}
        onClick={onClose}
      />
      {/* Panel */}
      <div
        className="fixed right-0 top-0 bottom-0 z-50 flex flex-col"
        style={{
          width: "min(480px, 100vw)",
          background: "var(--surface)",
          borderLeft: "1px solid var(--border)",
          boxShadow: "-4px 0 24px rgba(0,0,0,0.18)",
        }}
      >
        {/* Header */}
        <div
          className="flex items-start justify-between p-4 border-b flex-shrink-0"
          style={{ borderColor: "var(--border)" }}
        >
          <div className="flex items-center gap-3 min-w-0">
            <div
              className="w-9 h-9 rounded-lg flex items-center justify-center text-sm font-bold flex-shrink-0"
              style={{
                background: "color-mix(in srgb, var(--brand) 15%, var(--surface-2))",
                color: "var(--brand)",
              }}
            >
              {client.display_name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?"}
            </div>
            <div className="min-w-0">
              <div className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>
                {client.display_name}
              </div>
              <div className="text-[10px] font-mono truncate" style={{ color: "var(--text-dim)" }}>
                {client.tenant_id}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2 flex-shrink-0">
            <HealthBadge health={client.health} />
            <button
              onClick={onClose}
              className="p-1 rounded hover:bg-[var(--surface-2)] transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Metrics row */}
        <div
          className="grid grid-cols-3 gap-px border-b flex-shrink-0"
          style={{ borderColor: "var(--border)", background: "var(--border)" }}
        >
          {[
            { label: "Alertas ativos", value: client.active_alerts, red: client.active_alerts > 0 },
            { label: "Críticos", value: client.critical_alerts, red: client.critical_alerts > 0 },
            { label: "Fontes", value: client.source_count, red: false },
          ].map(({ label, value, red }) => (
            <div key={label} className="flex flex-col items-center py-3" style={{ background: "var(--surface)" }}>
              <span
                className="text-xl font-bold tabular-nums"
                style={{ color: red ? "var(--red)" : "var(--text)" }}
              >
                {value}
              </span>
              <span className="text-[10px] mt-0.5" style={{ color: "var(--text-dim)" }}>{label}</span>
            </div>
          ))}
        </div>

        {/* Alert list */}
        <div className="flex-1 overflow-y-auto">
          <div
            className="px-4 py-2.5 text-[10px] font-semibold uppercase tracking-wider sticky top-0"
            style={{
              color: "var(--text-muted)",
              background: "var(--surface-2)",
              borderBottom: "1px solid var(--border)",
            }}
          >
            Alertas ativos recentes
          </div>

          {q.isLoading ? (
            <div className="flex justify-center py-10">
              <RefreshCw size={16} className="animate-spin" style={{ color: "var(--text-muted)" }} />
            </div>
          ) : q.isError ? (
            <p className="text-xs text-center py-10" style={{ color: "var(--red)" }}>
              Falha ao carregar alertas.
            </p>
          ) : alerts.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-10 gap-2">
              <CheckCircle2 size={24} style={{ color: "var(--green, #10b981)" }} />
              <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                Nenhum alerta ativo.
              </p>
            </div>
          ) : (
            <div className="divide-y" style={{ borderColor: "var(--border)" }}>
              {alerts.map((a) => (
                <div key={a.alert_id} className="px-4 py-3 flex flex-col gap-1">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-medium truncate" style={{ color: "var(--text)" }}>
                      {a.source_kind}
                    </span>
                    <Badge variant={sevVariant(a.severity)}>
                      {a.severity ?? "N/A"}
                    </Badge>
                  </div>
                  {a.monitoring_resource_id && (
                    <span className="text-[10px] font-mono truncate" style={{ color: "var(--text-dim)" }}>
                      {a.monitoring_resource_id}
                    </span>
                  )}
                  <span className="text-[10px]" style={{ color: "var(--text-dim)" }}>
                    {fmtTs(a.opened_at)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}

function ClientCard({
  client,
  onClick,
}: {
  client: ClientHealth;
  onClick: () => void;
}) {
  const initials = client.display_name
    .split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();

  return (
    <div
      onClick={onClick}
      className="rounded-xl border p-4 flex flex-col gap-3 transition-all cursor-pointer select-none hover:shadow-md"
      style={{
        background: "var(--surface)",
        borderColor: client.health === "critical"
          ? "color-mix(in srgb, var(--red) 40%, var(--border))"
          : "var(--border)",
        boxShadow: client.health === "critical"
          ? "0 0 0 1px color-mix(in srgb, var(--red) 20%, transparent)"
          : undefined,
      }}
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2.5 min-w-0">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold flex-shrink-0"
            style={{ background: "color-mix(in srgb, var(--brand) 15%, var(--surface-2))", color: "var(--brand)" }}
          >
            {initials || "?"}
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold truncate" style={{ color: "var(--text)" }}>
              {client.display_name}
            </div>
            <div className="text-[10px] truncate" style={{ color: "var(--text-dim)" }}>
              {client.tenant_id}
            </div>
          </div>
        </div>
        <HealthDot health={client.health} />
      </div>

      {/* Status badge */}
      <HealthBadge health={client.health} />

      {/* Metrics */}
      <div className="grid grid-cols-3 gap-2 pt-1 border-t" style={{ borderColor: "var(--border)" }}>
        <div className="text-center">
          <div className="text-lg font-bold tabular-nums" style={{
            color: client.active_alerts > 0 ? "var(--red)" : "var(--text-muted)"
          }}>
            {client.active_alerts}
          </div>
          <div className="text-[10px]" style={{ color: "var(--text-dim)" }}>alertas</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold tabular-nums" style={{
            color: client.critical_alerts > 0 ? "var(--red)" : "var(--text-muted)"
          }}>
            {client.critical_alerts}
          </div>
          <div className="text-[10px]" style={{ color: "var(--text-dim)" }}>críticos</div>
        </div>
        <div className="text-center">
          <div className="text-lg font-bold tabular-nums" style={{ color: "var(--text)" }}>
            {client.source_count}
          </div>
          <div className="text-[10px]" style={{ color: "var(--text-dim)" }}>fontes</div>
        </div>
      </div>

      <div className="text-[10px] text-center" style={{ color: "var(--text-dim)" }}>
        Clique para ver detalhes
      </div>
    </div>
  );
}

export function MSPOverviewPage({ tenantId }: { tenantId: string }) {
  const [selectedClient, setSelectedClient] = useState<ClientHealth | null>(null);

  const { data, isLoading, isError, refetch, isFetching } = useQuery<MSPData>({
    queryKey: ["msp-clients", tenantId],
    queryFn: () => api.get<MSPData>("/api/v1/msp/clients"),
    refetchInterval: 30_000,
  });

  const clients = data?.clients ?? [];
  const critical = clients.filter((c) => c.health === "critical").length;
  const warning = clients.filter((c) => c.health === "warning").length;
  const ok = clients.filter((c) => c.health === "ok").length;

  return (
    <div className="space-y-6">
      {/* Summary bar */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
            Portfólio de Clientes
          </h2>
          {data && (
            <span className="text-xs px-2 py-0.5 rounded-full border"
              style={{ color: "var(--text-muted)", borderColor: "var(--border)", background: "var(--surface-2)" }}>
              {clients.length} {clients.length === 1 ? "cliente" : "clientes"}
            </span>
          )}
        </div>
        <div className="flex items-center gap-4">
          {data && (
            <div className="flex items-center gap-3 text-xs" style={{ color: "var(--text-muted)" }}>
              {critical > 0 && (
                <span className="flex items-center gap-1" style={{ color: "var(--red)" }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: "var(--red)" }} />
                  {critical} crítico{critical > 1 ? "s" : ""}
                </span>
              )}
              {warning > 0 && (
                <span className="flex items-center gap-1" style={{ color: "var(--yellow, #f59e0b)" }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: "var(--yellow, #f59e0b)" }} />
                  {warning} atenção
                </span>
              )}
              {ok > 0 && (
                <span className="flex items-center gap-1" style={{ color: "var(--green, #10b981)" }}>
                  <span className="w-2 h-2 rounded-full" style={{ background: "var(--green, #10b981)" }} />
                  {ok} operacional{ok > 1 ? "is" : ""}
                </span>
              )}
            </div>
          )}
          <button
            onClick={() => refetch()}
            disabled={isFetching}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded-lg border transition-colors disabled:opacity-50"
            style={{
              color: "var(--text-muted)",
              borderColor: "var(--border)",
              background: "var(--surface)",
            }}
          >
            <RefreshCw size={11} className={isFetching ? "animate-spin" : ""} />
            Atualizar
          </button>
        </div>
      </div>

      {/* Loading */}
      {isLoading && (
        <div className="flex items-center justify-center py-20 gap-2" style={{ color: "var(--text-muted)" }}>
          <RefreshCw size={14} className="animate-spin" />
          <span className="text-sm">Carregando clientes…</span>
        </div>
      )}

      {/* Error */}
      {isError && (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <AlertTriangle size={24} className="mx-auto mb-2" style={{ color: "var(--red)" }} />
            <p className="text-sm" style={{ color: "var(--text-muted)" }}>Falha ao carregar clientes.</p>
            <button
              onClick={() => refetch()}
              className="mt-3 text-xs underline"
              style={{ color: "var(--brand)" }}
            >
              Tentar novamente
            </button>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!isLoading && !isError && clients.length === 0 && (
        <div className="flex items-center justify-center py-20">
          <div className="text-center">
            <Activity size={28} className="mx-auto mb-3" style={{ color: "var(--text-dim)" }} />
            <p className="text-sm font-medium mb-1" style={{ color: "var(--text-muted)" }}>
              Nenhum cliente gerenciado
            </p>
            <p className="text-xs" style={{ color: "var(--text-dim)" }}>
              Clientes aparecem aqui quando delegated_grants são configurados.
            </p>
          </div>
        </div>
      )}

      {/* Client grid */}
      {clients.length > 0 && (
        <div className="grid gap-4" style={{
          gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
        }}>
          {clients.map((client) => (
            <ClientCard
              key={client.tenant_id}
              client={client}
              onClick={() => setSelectedClient(client)}
            />
          ))}
        </div>
      )}

      {/* Detail panel */}
      {selectedClient && (
        <ClientDetailPanel
          client={selectedClient}
          onClose={() => setSelectedClient(null)}
        />
      )}
    </div>
  );
}
