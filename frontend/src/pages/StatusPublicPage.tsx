import { useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CheckCircle, AlertTriangle, AlertOctagon, HelpCircle, RefreshCw } from "lucide-react";

// BFF JSON format from /api/public/status/{slug}
interface StatusData {
  public_name: string;
  status: "operational" | "degraded" | "outage" | "unknown";
  active_alerts: number;
  critical_alerts: number;
  source_count: number;
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
  unknown: {
    label: "Status desconhecido",
    color: "#8b93a5",
    bg: "rgba(139,147,165,0.08)",
    border: "rgba(139,147,165,0.2)",
    Icon: HelpCircle,
  },
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
        background: "#0f1115",
        color: "#e6e8ec",
        fontFamily: "system-ui, -apple-system, 'Segoe UI', sans-serif",
        fontSize: 14,
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header */}
      <header
        style={{
          background: "#161a22",
          borderBottom: "1px solid #262c3a",
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
            color: "#8b93a5",
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
          <div style={{ textAlign: "center", paddingTop: 80, color: "#8b93a5" }}>
            Carregando status…
          </div>
        )}

        {isError && (error as Error)?.message === "not_found" && (
          <div
            style={{
              textAlign: "center",
              paddingTop: 80,
              color: "#8b93a5",
            }}
          >
            <HelpCircle size={40} style={{ margin: "0 auto 16px", opacity: 0.3 }} />
            <p style={{ fontSize: 16, marginBottom: 8, color: "#e6e8ec" }}>
              Página de status não encontrada
            </p>
            <p style={{ fontSize: 13 }}>
              Verifique o endereço ou contate o responsável pelo serviço.
            </p>
          </div>
        )}

        {isError && (error as Error)?.message !== "not_found" && (
          <div style={{ textAlign: "center", paddingTop: 80, color: "#ff6b6b" }}>
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
                <div style={{ fontSize: 12, color: "#8b93a5", marginTop: 2 }}>
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
                { label: "Alertas ativos", value: data.active_alerts, color: "#e6e8ec" },
                { label: "Críticos", value: data.critical_alerts, color: data.critical_alerts > 0 ? "#ff6b6b" : "#8b93a5" },
                { label: "Fontes monitoradas", value: data.source_count, color: "#6ea8fe" },
              ].map(({ label, value, color }) => (
                <div
                  key={label}
                  style={{
                    padding: "16px 18px",
                    borderRadius: 10,
                    background: "#161a22",
                    border: "1px solid #262c3a",
                    textAlign: "center",
                  }}
                >
                  <div style={{ fontSize: 24, fontWeight: 700, color, fontVariantNumeric: "tabular-nums" }}>
                    {value}
                  </div>
                  <div style={{ fontSize: 11, color: "#8b93a5", marginTop: 4 }}>
                    {label}
                  </div>
                </div>
              ))}
            </div>

            {/* Component list */}
            <div
              style={{
                borderRadius: 10,
                border: "1px solid #262c3a",
                background: "#161a22",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  padding: "12px 18px",
                  borderBottom: "1px solid #262c3a",
                  fontSize: 12,
                  fontWeight: 600,
                  color: "#8b93a5",
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                }}
              >
                Componentes
              </div>

              {[
                {
                  name: "Monitoramento",
                  ok: data.critical_alerts === 0,
                  status: data.critical_alerts > 0 ? "Incidente ativo" : data.active_alerts > 0 ? "Degradado" : "Operacional",
                  statusColor: data.critical_alerts > 0 ? "#ff6b6b" : data.active_alerts > 0 ? "#e6b450" : "#6fdc8c",
                },
                {
                  name: "Coleta de dados",
                  ok: data.source_count > 0,
                  status: data.source_count > 0 ? `${data.source_count} fonte${data.source_count !== 1 ? "s" : ""} ativa${data.source_count !== 1 ? "s" : ""}` : "Nenhuma fonte configurada",
                  statusColor: data.source_count > 0 ? "#6fdc8c" : "#e6b450",
                },
                {
                  name: "Sistema geral",
                  ok: data.status === "operational",
                  status: STATUS_CONFIG[data.status]?.label ?? "Desconhecido",
                  statusColor: cfg.color,
                },
              ].map(({ name, status, statusColor }) => (
                <div
                  key={name}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    padding: "13px 18px",
                    borderBottom: "1px solid #1c2130",
                  }}
                >
                  <span style={{ fontSize: 13, color: "#e6e8ec" }}>{name}</span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 12,
                      color: statusColor,
                    }}
                  >
                    <Dot color={statusColor} />
                    {status}
                  </span>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 40, textAlign: "center", fontSize: 12, color: "#5a6274" }}>
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
          borderTop: "1px solid #1c2130",
          fontSize: 11,
          color: "#5a6274",
        }}
      >
        Monitorado por{" "}
        <span style={{ color: "#6ea8fe", fontWeight: 500 }}>JLMirror</span>
      </footer>

      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
