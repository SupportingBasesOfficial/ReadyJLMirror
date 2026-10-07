import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, AlertTriangle, AlertOctagon, HelpCircle, RefreshCw } from "lucide-react";

interface ComponentItem {
  name: string;
  description?: string;
  status: "operational" | "degraded" | "outage" | "maintenance";
}

// BFF JSON format from /api/public/status/{slug}
interface StatusData {
  public_name: string;
  status: "operational" | "degraded" | "outage" | "unknown";
  active_alerts: number;
  critical_alerts: number;
  source_count: number;
  components?: ComponentItem[];
}

const STATUS_CONFIG = {
  operational: {
    label: "Todos os sistemas operacionais",
    color: "#6fdc8c",
    bg: "rgba(111,220,140,0.08)",
    border: "rgba(111,220,140,0.2)",
    Icon: CheckCircle,
  },
  degraded: {
    label: "Degradação de performance",
    color: "#e6b450",
    bg: "rgba(230,180,80,0.08)",
    border: "rgba(230,180,80,0.2)",
    Icon: AlertTriangle,
  },
  outage: {
    label: "Interrupção de serviço",
    color: "#ff6b6b",
    bg: "rgba(255,107,107,0.08)",
    border: "rgba(255,107,107,0.2)",
    Icon: AlertOctagon,
  },
  maintenance: {
    label: "Em manutenção",
    color: "#8b93a5",
    bg: "rgba(139,147,165,0.08)",
    border: "rgba(139,147,165,0.2)",
    Icon: HelpCircle,
  },
  unknown: {
    label: "Status desconhecido",
    color: "#8b93a5",
    bg: "rgba(139,147,165,0.08)",
    border: "rgba(139,147,165,0.2)",
    Icon: HelpCircle,
  },
};

const COMPONENT_LABEL: Record<string, string> = {
  operational: "Operacional",
  degraded: "Degradado",
  outage: "Incidente ativo",
  maintenance: "Manutenção",
  unknown: "Desconhecido",
};

async function fetchStatus(slug: string): Promise<StatusData> {
  // Uses BFF's public JSON endpoint — no auth required
  const res = await fetch(`/api/public/status/${slug}`);
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error("fetch_error");
  return res.json();
}

function Dot({ color }: { color: string }) {
  return (
    <span
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        background: color,
        flexShrink: 0,
      }}
    />
  );
}

function monitoringStatus(d: StatusData): keyof typeof STATUS_CONFIG {
  if (d.critical_alerts > 0) return "outage";
  if (d.active_alerts > 0) return "degraded";
  if (d.source_count > 0) return "operational";
  return "unknown";
}

function alertsStatus(d: StatusData): keyof typeof STATUS_CONFIG {
  if (d.critical_alerts > 0) return "outage";
  if (d.active_alerts > 0) return "degraded";
  return "operational";
}

export function StatusPublicPage() {
  const { slug } = useParams<{ slug: string }>();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<StatusData>({
    queryKey: ["public-status", slug],
    queryFn: () => fetchStatus(slug!),
    retry: false,
    refetchInterval: 60_000,
  });

  const now = new Date().toLocaleString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });

  const cfg = data ? STATUS_CONFIG[data.status] ?? STATUS_CONFIG.unknown : null;

  return (
    <div
      style={{
        minHeight: "100vh",
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        fontSize: 14,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <header
        style={{
          background: "var(--surface)",
          borderBottom: "1px solid var(--border)",
          padding: "0 24px",
          height: 56,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
        }}
      >
        <span style={{ fontWeight: 600, fontSize: 15 }}>
          {data?.public_name ?? slug}
        </span>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            color: "var(--text-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
            padding: "4px 8px",
            borderRadius: 6,
          }}
        >
          <RefreshCw size={13} style={{ animation: isFetching ? "spin 1s linear infinite" : "none" }} />
          Atualizar
        </button>
      </header>

      {/* Body */}
      <main style={{ flex: 1, maxWidth: 640, margin: "0 auto", width: "100%", padding: "40px 24px" }}>
        {isLoading && (
          <div style={{ textAlign: "center", paddingTop: 80, color: "var(--text-muted)" }}>
            Carregando status…
          </div>
        )}

        {isError && (error as Error)?.message === "not_found" && (
          <div
            style={{
              textAlign: "center",
              paddingTop: 80,
              color: "var(--text-muted)",
            }}
          >
            <HelpCircle size={40} style={{ margin: "0 auto 16px", opacity: 0.3 }} />
            <p style={{ fontSize: 16, marginBottom: 8, color: "var(--text)" }}>
              Página de status não encontrada
            </p>
            <p style={{ fontSize: 13 }}>
              Verifique o endereço ou contate o responsável pelo serviço.
            </p>
          </div>
        )}

        {isError && (error as Error)?.message !== "not_found" && (
          <div style={{ textAlign: "center", paddingTop: 80, color: "var(--red)" }}>
            Não foi possível carregar o status. Tente novamente em instantes.
          </div>
        )}

        {data && cfg && (
          <>
            {/* Status banner */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 16,
                padding: "20px 24px",
                borderRadius: 14,
                border: `1px solid ${cfg.border}`,
                background: cfg.bg,
                marginBottom: 32,
              }}
            >
              <cfg.Icon size={28} style={{ color: cfg.color, flexShrink: 0 }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 17, color: cfg.color }}>
                  {cfg.label}
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 2 }}>
                  Atualizado em {now}
                </div>
              </div>
            </div>

            {/* Metrics */}
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
                gap: 12,
                marginBottom: 32,
              }}
            >
              {[
                { label: "Alertas ativos", value: data.active_alerts, color: "var(--text)" },
                { label: "Críticos", value: data.critical_alerts, color: data.critical_alerts > 0 ? "var(--red)" : "var(--text-muted)" },
                { label: "Fontes monitoradas", value: data.source_count, color: "var(--brand)" },
              ].map(({ label, value, color }) => (
                <div
                  key={label}
                  style={{
                    padding: "16px 18px",
                    borderRadius: 10,
                    background: "var(--surface)",
                    border: "1px solid var(--border)",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 24, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>
                    {value}
                  </div>
                  <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 4 }}>
                    {label}
                  </div>
                </div>
              ))}
            </div>

            {/* Component list */}
            <div
              style={{
                borderRadius: 10,
                border: "1px solid var(--border)",
                background: "var(--surface)",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "12px 18px",
                  borderBottom: "1px solid var(--border)",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "var(--text-muted)",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Componentes
              </div>

              {(data.components && data.components.length > 0
                ? data.components.map((comp) => ({
                    name: comp.name,
                    description: comp.description,
                    statusKey: comp.status as keyof typeof STATUS_CONFIG,
                  }))
                : [
                    { name: "Monitoramento", description: undefined, statusKey: monitoringStatus(data) },
                    { name: "Alertas", description: undefined, statusKey: alertsStatus(data) },
                    { name: "Plataforma", description: undefined, statusKey: "operational" as const },
                  ]
              ).map(({ name, description, statusKey }) => {
                const compCfg = STATUS_CONFIG[statusKey] ?? STATUS_CONFIG.unknown;
                return (
                  <div
                    key={name}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "13px 18px",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                      <span style={{ fontSize: 13, color: "var(--text)" }}>{name}</span>
                      {description && (
                        <span style={{ fontSize: 11, color: "var(--text-muted)" }}>{description}</span>
                      )}
                    </div>
                    <span
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        fontSize: 12,
                        color: compCfg.color,
                      }}
                    >
                      <Dot color={compCfg.color} />
                      {COMPONENT_LABEL[statusKey] ?? statusKey}
                    </span>
                  </div>
                );
              })}
            </div>

            {data.active_alerts === 0 && (
              <div style={{ marginTop: 24, textAlign: "center", fontSize: 13, color: "var(--text-muted)" }}>
                Nenhum incidente registrado nos últimos 90 dias.
              </div>
            )}

            <div style={{ marginTop: 16, textAlign: "center", fontSize: 12, color: "var(--text-muted)" }}>
              Atualização automática a cada 60 segundos
            </div>
          </>
        )}
      </main>

      {/* Footer */}
      <footer
        style={{
          textAlign: "center",
          padding: "16px 24px",
          borderTop: "1px solid var(--border)",
          fontSize: 11,
          color: "var(--text-muted)",
        }}
      >
        <div style={{ marginBottom: 4 }}>Atualizado em {now}</div>
        Monitorado por{" "}
        <span style={{ color: "var(--brand)", fontWeight: 500 }}>JLMirror</span>
      </footer>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
