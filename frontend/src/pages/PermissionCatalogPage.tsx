import { useState } from "react";
import { useTranslation } from "react-i18next";

type Role =
  | "platform_admin"
  | "msp_admin"
  | "msp_operator"
  | "tenant_admin"
  | "tenant_operator"
  | "tenant_viewer"
  | "tenant_auditor";

type Access = "full" | "read" | "none";

interface RouteEntry {
  name: string;
  path: string;
  access: Record<Role, Access>;
  notes?: string;
}

interface RouteGroup {
  label: string;
  routes: RouteEntry[];
}

const ALL_ROLES: Role[] = [
  "platform_admin",
  "msp_admin",
  "msp_operator",
  "tenant_admin",
  "tenant_operator",
  "tenant_viewer",
  "tenant_auditor",
];

const ROLE_LABELS: Record<Role, string> = {
  platform_admin: "Platform Admin",
  msp_admin: "MSP Admin",
  msp_operator: "MSP Operador",
  tenant_admin: "Admin",
  tenant_operator: "Operador",
  tenant_viewer: "Viewer",
  tenant_auditor: "Auditor",
};

const ROLE_COLORS: Record<Role, string> = {
  platform_admin: "var(--red)",
  msp_admin: "#8b5cf6",
  msp_operator: "#a78bfa",
  tenant_admin: "#f59e0b",
  tenant_operator: "#22c55e",
  tenant_viewer: "#60a5fa",
  tenant_auditor: "#e879f9",
};

const full = (roles: Role[]): Record<Role, Access> =>
  Object.fromEntries(ALL_ROLES.map((r) => [r, roles.includes(r) ? "full" : "none"])) as Record<Role, Access>;

const allFull = (): Record<Role, Access> =>
  Object.fromEntries(ALL_ROLES.map((r) => [r, "full"])) as Record<Role, Access>;

const withRead = (fullRoles: Role[], readRoles: Role[]): Record<Role, Access> =>
  Object.fromEntries(
    ALL_ROLES.map((r) => [r, fullRoles.includes(r) ? "full" : readRoles.includes(r) ? "read" : "none"])
  ) as Record<Role, Access>;

const CATALOG: RouteGroup[] = [
  {
    label: "Operações",
    routes: [
      { name: "NOC Dashboard", path: "/", access: allFull() },
      { name: "Meu Dashboard", path: "/dashboard", access: allFull() },
      { name: "Alertas", path: "/alerts", access: allFull() },
      {
        name: "Incidentes",
        path: "/incidents",
        access: withRead(
          ["platform_admin", "msp_admin", "msp_operator", "tenant_admin", "tenant_operator", "tenant_auditor"],
          ["tenant_viewer"]
        ),
        notes: "Viewer: apenas leitura",
      },
      {
        name: "Políticas de Alerta",
        path: "/policies",
        access: withRead(
          ["platform_admin", "msp_admin", "tenant_admin"],
          ["msp_operator", "tenant_operator", "tenant_viewer", "tenant_auditor"]
        ),
        notes: "Edição restrita a admins",
      },
    ],
  },
  {
    label: "ITSM",
    routes: [
      {
        name: "Mudanças (ITSM)",
        path: "/changes",
        access: full(["platform_admin", "msp_admin", "msp_operator", "tenant_admin", "tenant_operator"]),
        notes: "Requer permissão monitoring:operate",
      },
      {
        name: "SLA",
        path: "/sla",
        access: full(["platform_admin", "msp_admin", "msp_operator", "tenant_admin", "tenant_operator"]),
      },
      {
        name: "Automação",
        path: "/automation",
        access: full(["platform_admin", "msp_admin", "tenant_admin", "tenant_operator"]),
        notes: "Criação restrita a admins",
      },
      {
        name: "Relatórios",
        path: "/reports",
        access: full(["platform_admin", "msp_admin", "tenant_admin"]),
      },
      {
        name: "Resposta a Incidentes",
        path: "/incident-response",
        access: full(["platform_admin", "msp_admin", "tenant_admin", "tenant_operator"]),
      },
    ],
  },
  {
    label: "Inteligência",
    routes: [
      { name: "AIOps", path: "/aiops", access: allFull() },
      {
        name: "FinOps",
        path: "/finops",
        access: full(["platform_admin", "msp_admin", "tenant_admin"]),
      },
    ],
  },
  {
    label: "Integrações",
    routes: [
      { name: "Monitoramento", path: "/monitoring", access: allFull() },
      { name: "Inventário", path: "/inventory", access: allFull() },
      { name: "Teia", path: "/teia", access: allFull() },
      { name: "Sintético", path: "/synthetic", access: full(["platform_admin", "msp_admin", "msp_operator", "tenant_admin", "tenant_operator"]) },
      {
        name: "Alertmanager",
        path: "/alertmanager",
        access: full(["platform_admin", "msp_admin", "tenant_admin", "tenant_operator"]),
        notes: "Requer monitoring:operate",
      },
    ],
  },
  {
    label: "Infraestrutura",
    routes: [
      {
        name: "Infraestrutura",
        path: "/infra",
        access: full(["platform_admin", "msp_admin", "msp_operator", "tenant_admin", "tenant_operator"]),
        notes: "Requer monitoring:operate",
      },
      {
        name: "Manutenção",
        path: "/maintenance",
        access: full(["platform_admin", "msp_admin", "msp_operator", "tenant_admin", "tenant_operator"]),
        notes: "Requer monitoring:operate",
      },
      { name: "Configurações (Tenant)", path: "/platform", access: allFull() },
      { name: "Página de Status", path: "/status-page-admin", access: full(["platform_admin", "msp_admin", "tenant_admin"]) },
    ],
  },
  {
    label: "Notificações",
    routes: [
      {
        name: "Canais de Notificação",
        path: "/channels",
        access: full(["platform_admin", "msp_admin", "msp_operator", "tenant_admin", "tenant_operator"]),
      },
      {
        name: "Escalonamento",
        path: "/escalation",
        access: full(["platform_admin", "msp_admin", "tenant_admin"]),
      },
      {
        name: "Plantão (On-call)",
        path: "/oncall",
        access: full(["platform_admin", "msp_admin", "msp_operator", "tenant_admin", "tenant_operator"]),
      },
    ],
  },
  {
    label: "Base de Conhecimento",
    routes: [
      { name: "Base de Conhecimento", path: "/kb", access: allFull() },
    ],
  },
  {
    label: "Equipe & Acesso",
    routes: [
      { name: "Usuários", path: "/admin/users", access: full(["platform_admin", "msp_admin", "tenant_admin"]) },
      { name: "Equipe", path: "/team", access: full(["platform_admin", "msp_admin", "tenant_admin"]) },
      { name: "API Keys", path: "/api-keys", access: full(["platform_admin", "msp_admin", "tenant_admin"]) },
      {
        name: "Auditoria",
        path: "/audit",
        access: withRead(
          ["platform_admin", "msp_admin", "tenant_admin", "tenant_auditor"],
          []
        ),
      },
      { name: "Bugs Reportados", path: "/admin/bugs", access: full(["platform_admin", "tenant_admin"]) },
    ],
  },
  {
    label: "MSP",
    routes: [
      { name: "Empresas / Clientes", path: "/companies", access: full(["platform_admin", "msp_admin", "msp_operator", "tenant_admin"]) },
      { name: "MSP Overview", path: "/msp", access: full(["platform_admin", "msp_admin", "msp_operator"]) },
      { name: "Onboarding", path: "/onboarding", access: full(["platform_admin"]) },
    ],
  },
  {
    label: "Plataforma",
    routes: [
      { name: "Administração da Plataforma", path: "/platform-admin", access: full(["platform_admin"]) },
      { name: "Catálogo de Permissões", path: "/permissions", access: full(["platform_admin", "tenant_admin"]) },
      { name: "TV / NOC Display", path: "/tv", access: allFull() },
      {
        name: "Status Público",
        path: "/status/:slug",
        access: allFull(),
        notes: "Página pública, sem autenticação",
      },
    ],
  },
];

function AccessCell({ access }: { access: Access }) {
  if (access === "full")
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          borderRadius: 4,
          background: "var(--green, #22c55e)",
          color: "#fff",
          fontSize: 11,
          fontWeight: 700,
        }}
      >
        ✓
      </span>
    );
  if (access === "read")
    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          width: 20,
          height: 20,
          borderRadius: 4,
          background: "#60a5fa22",
          color: "#3b82f6",
          fontSize: 10,
          fontWeight: 700,
          border: "1px solid #60a5fa55",
        }}
        title="Apenas leitura"
      >
        R
      </span>
    );
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 20,
        height: 20,
        borderRadius: 4,
        background: "var(--surface-2)",
        color: "var(--text-muted)",
        fontSize: 11,
      }}
    >
      –
    </span>
  );
}

export function PermissionCatalogPage({ tenantId: _tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const [filterRole, setFilterRole] = useState<Role | "all">("all");
  const [search, setSearch] = useState("");

  const filteredCatalog = CATALOG.map((group) => ({
    ...group,
    routes: group.routes.filter((r) => {
      const matchesSearch =
        !search ||
        r.name.toLowerCase().includes(search.toLowerCase()) ||
        r.path.toLowerCase().includes(search.toLowerCase());
      const matchesRole =
        filterRole === "all" || r.access[filterRole] !== "none";
      return matchesSearch && matchesRole;
    }),
  })).filter((g) => g.routes.length > 0);

  const visibleRoles = filterRole === "all" ? ALL_ROLES : [filterRole];

  return (
    <div style={{ padding: "24px 28px", maxWidth: 1100 }}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
          {t("permissions.title", "Catálogo de Permissões")}
        </h1>
        <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
          {t("permissions.subtitle", "Quais telas e rotas cada tipo de usuário pode acessar no JLMirror.")}
        </p>
      </div>

      {/* Legend */}
      <div style={{ display: "flex", gap: 16, marginBottom: 16, flexWrap: "wrap", alignItems: "center" }}>
        <span style={{ fontSize: 12, color: "var(--text-muted)" }}>Legenda:</span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
          <AccessCell access="full" /> {t("permissions.legendFull", "Acesso completo")}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
          <AccessCell access="read" /> {t("permissions.legendRead", "Apenas leitura")}
        </span>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12 }}>
          <AccessCell access="none" /> {t("permissions.legendNone", "Sem acesso")}
        </span>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        <input
          placeholder={t("permissions.searchPlaceholder", "Buscar tela ou rota...")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          style={{
            padding: "5px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            color: "var(--text)",
            fontSize: 13,
            minWidth: 200,
          }}
        />
        <select
          value={filterRole}
          onChange={(e) => setFilterRole(e.target.value as Role | "all")}
          style={{
            padding: "5px 10px",
            borderRadius: 6,
            border: "1px solid var(--border)",
            background: "var(--surface-2)",
            color: "var(--text)",
            fontSize: 13,
          }}
        >
          <option value="all">{t("permissions.allRoles", "Todos os papéis")}</option>
          {ALL_ROLES.map((r) => (
            <option key={r} value={r}>
              {ROLE_LABELS[r]}
            </option>
          ))}
        </select>
      </div>

      {/* Table */}
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            fontSize: 13,
          }}
        >
          <thead>
            <tr>
              <th
                style={{
                  textAlign: "left",
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  whiteSpace: "nowrap",
                  minWidth: 180,
                }}
              >
                {t("permissions.colPage", "Tela")}
              </th>
              <th
                style={{
                  textAlign: "left",
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                  whiteSpace: "nowrap",
                }}
              >
                {t("permissions.colPath", "Rota")}
              </th>
              {visibleRoles.map((role) => (
                <th
                  key={role}
                  style={{
                    textAlign: "center",
                    padding: "8px 10px",
                    borderBottom: "1px solid var(--border)",
                    color: ROLE_COLORS[role],
                    fontWeight: 600,
                    fontSize: 11,
                    whiteSpace: "nowrap",
                  }}
                >
                  {ROLE_LABELS[role]}
                </th>
              ))}
              <th
                style={{
                  textAlign: "left",
                  padding: "8px 12px",
                  borderBottom: "1px solid var(--border)",
                  color: "var(--text-muted)",
                  fontWeight: 500,
                  fontSize: 11,
                  textTransform: "uppercase",
                  letterSpacing: "0.05em",
                }}
              >
                {t("permissions.colNotes", "Observações")}
              </th>
            </tr>
          </thead>
          <tbody>
            {filteredCatalog.map((group) => (
              <>
                <tr key={`group-${group.label}`}>
                  <td
                    colSpan={visibleRoles.length + 3}
                    style={{
                      padding: "12px 12px 4px",
                      fontSize: 10,
                      fontWeight: 700,
                      textTransform: "uppercase",
                      letterSpacing: "0.1em",
                      color: "var(--text-muted)",
                      background: "var(--surface-1)",
                      borderBottom: "1px solid var(--border)",
                    }}
                  >
                    {group.label}
                  </td>
                </tr>
                {group.routes.map((route, ri) => (
                  <tr
                    key={route.path + ri}
                    style={{
                      background: ri % 2 === 0 ? "transparent" : "var(--surface-1)",
                    }}
                  >
                    <td
                      style={{
                        padding: "7px 12px",
                        borderBottom: "1px solid var(--border)",
                        color: "var(--text)",
                        fontWeight: 450,
                        whiteSpace: "nowrap",
                      }}
                    >
                      {route.name}
                    </td>
                    <td
                      style={{
                        padding: "7px 12px",
                        borderBottom: "1px solid var(--border)",
                        fontFamily: "monospace",
                        fontSize: 12,
                        color: "var(--text-muted)",
                        whiteSpace: "nowrap",
                      }}
                    >
                      {route.path}
                    </td>
                    {visibleRoles.map((role) => (
                      <td
                        key={role}
                        style={{
                          padding: "7px 10px",
                          borderBottom: "1px solid var(--border)",
                          textAlign: "center",
                        }}
                      >
                        <AccessCell access={route.access[role]} />
                      </td>
                    ))}
                    <td
                      style={{
                        padding: "7px 12px",
                        borderBottom: "1px solid var(--border)",
                        fontSize: 12,
                        color: "var(--text-muted)",
                      }}
                    >
                      {route.notes ?? ""}
                    </td>
                  </tr>
                ))}
              </>
            ))}
          </tbody>
        </table>
        {filteredCatalog.length === 0 && (
          <div style={{ padding: "32px", textAlign: "center", color: "var(--text-muted)", fontSize: 13 }}>
            {t("permissions.noResults", "Nenhuma tela encontrada para este filtro.")}
          </div>
        )}
      </div>

      <p style={{ marginTop: 20, fontSize: 11, color: "var(--text-muted)" }}>
        {t("permissions.footnote", "As permissões são gerenciadas pelo Keycloak e validadas no backend. Este catálogo é uma referência de navegação.")}
      </p>
    </div>
  );
}
