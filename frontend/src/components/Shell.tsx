import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { useSession } from "@/hooks/useSession";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { FullPageSpinner } from "@/components/ui/spinner";
import {
  LayoutDashboard, Bell, Siren, Shield,
  GitMerge, Clock, Zap, BarChart2,
  Brain, DollarSign, Activity, Package,
  Webhook, Server, Wrench, Settings2,
  MessageSquare, PhoneCall, Users, UserPlus, KeyRound,
  ScrollText, BookOpen, ChevronLeft, ChevronRight,
  ChevronDown, LogOut, Building2, ShieldCheck, Network, Radio, CalendarClock,
  LayoutGrid, Globe, Bug, TrendingUp, GitCompare, ToggleLeft, Gauge, ShieldAlert, FileText, HardDrive, ArrowLeftRight,
} from "lucide-react";
import { api, logout } from "@/api/client";
import { AlertsPage } from "@/pages/AlertsPage";
import { MonitoringPage } from "@/pages/MonitoringPage";
import { InventoryPage } from "@/pages/InventoryPage";
import { NOCDashboard } from "@/pages/NOCDashboard";
import { AIOpsPage } from "@/pages/AIOpsPage";
import { FinOpsPage } from "@/pages/FinOpsPage";
import { ExecutiveDashboardPage } from "@/pages/ExecutiveDashboardPage";
import { PlatformPage } from "@/pages/PlatformPage";
import { AuditPage } from "@/pages/AuditPage";
import { AlertPoliciesPage } from "@/pages/AlertPoliciesPage";
import { TeamPage } from "@/pages/TeamPage";
import { MaintenancePage } from "@/pages/MaintenancePage";
import { NotificationChannelsPage } from "@/pages/NotificationChannelsPage";
import { EscalationPage } from "@/pages/EscalationPage";
import { SyntheticPage } from "@/pages/SyntheticPage";
import { OncallPage } from "@/pages/OncallPage";
import { CustomDashboardPage } from "@/pages/CustomDashboardPage";
import { OnboardingPage } from "@/pages/OnboardingPage";
import { ApiKeysPage } from "@/pages/ApiKeysPage";
import { ITSMPage } from "@/pages/ITSMPage";
import { IncidentResponsePage } from "@/pages/IncidentResponsePage";
import { SLAPage } from "@/pages/SLAPage";
import { AutomationPage } from "@/pages/AutomationPage";
import { ReportsPage } from "@/pages/ReportsPage";
import { AlertmanagerPage } from "@/pages/AlertmanagerPage";
import { InfraPage } from "@/pages/InfraPage";
import { KnowledgeBasePage } from "@/pages/KnowledgeBasePage";
import { IncidentsPage } from "@/pages/IncidentsPage";
import { MSPOverviewPage } from "@/pages/MSPOverviewPage";
import { UsersAdminPage } from "@/pages/UsersAdminPage";
import { PlatformAdminPage } from "@/pages/PlatformAdminPage";
import { TeiaPage } from "@/pages/TeiaPage";
import { PlatformTeiaPage } from "@/pages/PlatformTeiaPage";
import { StatusPageAdminPage } from "@/pages/StatusPageAdminPage";
import { BugReportsPage } from "@/pages/BugReportsPage";
import { ClientCompaniesPage } from "@/pages/ClientCompaniesPage";
import { PermissionCatalogPage } from "@/pages/PermissionCatalogPage";
import { AccountSecurityPage } from "@/pages/AccountSecurityPage";
import { ConfigDriftPage } from "@/pages/ConfigDriftPage";
import { FeatureFlagsPage } from "@/pages/FeatureFlagsPage";
import { TenantSettingsPage } from "@/pages/TenantSettingsPage";
import { APMPage } from "@/pages/APMPage";
import { SecurityAuditPage } from "@/pages/SecurityAuditPage";
import { LogsPage } from "@/pages/LogsPage";
import { WebhooksPage } from "@/pages/WebhooksPage";
import { ContractsPage } from "@/pages/ContractsPage";
import { CapacityPage } from "@/pages/CapacityPage";
import { BackupPage } from "@/pages/BackupPage";
import { FirewallPage } from "@/pages/FirewallPage";
import { K8sPage } from "@/pages/K8sPage";
import { CorrelationPage } from "@/pages/CorrelationPage";
import { DiscoveryPage } from "@/pages/DiscoveryPage";
import { DataTransferPage } from "@/pages/DataTransferPage";
import { ClientPortalPage } from "@/pages/ClientPortalPage";
import { HelpDeskPage } from "@/pages/HelpDeskPage";
import { BillingPage } from "@/pages/BillingPage";
import { useBranding } from "@/hooks/useBranding";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useRef } from "react";
import { BugReportButton } from "@/components/BugReportButton";
import { PageInfoButton } from "@/components/PageInfoButton";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useTranslation } from "react-i18next";

const VIEW_TO_PATH: Record<string, string> = {
  noc: "/",
  alerts: "/alerts",
  incidents: "/incidents",
  policies: "/policies",
  changes: "/changes",
  "incident-response": "/incident-response",
  sla: "/sla",
  automation: "/automation",
  reports: "/reports",
  aiops: "/aiops",
  finops: "/finops",
  executive: "/executive",
  monitoring: "/monitoring",
  inventory: "/inventory",
  alertmanager: "/alertmanager",
  infra: "/infra",
  maintenance: "/maintenance",
  platform: "/platform",
  channels: "/channels",
  escalation: "/escalation",
  team: "/team",
  apikeys: "/api-keys",
  audit: "/audit",
  msp: "/msp",
  kb: "/kb",
  teia: "/teia",
  bugs: "/admin/bugs",
  companies: "/companies",
  users: "/admin/users",
  "platform-admin": "/platform-admin",
  permissions: "/permissions",
  synthetic: "/synthetic",
  oncall: "/oncall",
  custom_dashboard: "/dashboard",
  status_page: "/status-page-admin",
  "account-security": "/account/security",
  "config-drift": "/config-drift",
  "feature-flags": "/feature-flags",
  "tenant-settings": "/settings/tenant",
  apm: "/apm",
  "security-audit": "/security-audit",
  "client-portal": "/portal",
  helpdesk: "/helpdesk",
  billing: "/billing",
  logs: "/logs",
  webhooks: "/webhooks",
  contracts: "/contracts",
  capacity: "/capacity",
  backup: "/backup",
  firewall: "/firewall",
  k8s: "/k8s",
  correlation: "/correlation",
  discovery: "/discovery",
  data_transfer: "/data-transfer",
};

const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEW_TO_PATH).map(([v, p]) => [p, v])
);

type View = keyof typeof VIEW_TO_PATH;

function currentViewFromPath(pathname: string): View {
  return (PATH_TO_VIEW[pathname] ?? "noc") as View;
}

export function Shell() {
  const { t } = useTranslation();
  const { data: session, isLoading } = useSession();
  const qc = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();

  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      const v = localStorage.getItem("jlm_sidebar_collapsed");
      return v === null ? true : v === "1";
    } catch { return true; }
  });

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const stored = localStorage.getItem("jlm_collapsed_groups");
      return stored ? new Set(JSON.parse(stored)) : new Set<string>();
    } catch { return new Set<string>(); }
  });

  const [sessionExpired, setSessionExpired] = useState<boolean>(false);
  const [tenantDropdownOpen, setTenantDropdownOpen] = useState(false);
  const tenantDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!tenantDropdownOpen) return;
    const closeOnOutside = (e: MouseEvent) => {
      if (tenantDropdownRef.current && !tenantDropdownRef.current.contains(e.target as Node))
        setTenantDropdownOpen(false);
    };
    document.addEventListener("mousedown", closeOnOutside);
    return () => document.removeEventListener("mousedown", closeOnOutside);
  }, [tenantDropdownOpen]);

  useEffect(() => {
    const handler = () => setSessionExpired(true);
    window.addEventListener("jlm:session-expired", handler);
    return () => window.removeEventListener("jlm:session-expired", handler);
  }, []);

  const selectTenant = useMutation({
    mutationFn: (tenant_id: string) =>
      api.post("/api/tenant/select", { tenant_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["session"] }),
  });

  const handleSelectTenant = (tenant_id: string) => {
    selectTenant.mutate(tenant_id);
    navigate("/");
  };

  const { data: mspData } = useQuery<{ clients: { tenant_id: string }[] }>({
    queryKey: ["msp-clients-check", session?.tenant_id],
    queryFn: () => api.get<{ clients: { tenant_id: string }[] }>("/api/v1/msp/clients"),
    enabled: session?.state === "ready",
    staleTime: 60_000,
  });
  const hasMSPClients = (mspData?.clients?.length ?? 0) > 0;

  const { data: activeAlertCount } = useQuery({
    queryKey: ["nav-badge-alerts", session?.tenant_id],
    queryFn: () => api.get<unknown[]>("/api/v1/alerting/alerts?lifecycle_state=active"),
    refetchInterval: 30_000,
    enabled: session?.state === "ready",
    select: (d) => (Array.isArray(d) ? d.length : 0),
  });

  const { data: openIncidentCount } = useQuery({
    queryKey: ["nav-badge-incidents", session?.tenant_id],
    queryFn: () => api.get<unknown[]>("/api/v1/alerting/incidents?state=open"),
    refetchInterval: 60_000,
    enabled: session?.state === "ready",
    select: (d) => (Array.isArray(d) ? d.length : 0),
  });

  const { data: openChangesCount } = useQuery({
    queryKey: ["nav-badge-changes", session?.tenant_id],
    queryFn: () => api.get<{ state?: string }[]>("/api/v1/itsm/changes"),
    refetchInterval: 60_000,
    enabled: session?.state === "ready",
    select: (d) => (Array.isArray(d) ? d.filter((c) => c.state && ["draft", "review", "approved"].includes(c.state)).length : 0),
  });

  const { data: slaBreachCount } = useQuery({
    queryKey: ["nav-badge-sla", session?.tenant_id],
    queryFn: () => api.get<unknown[]>("/api/v1/sla/breaches"),
    refetchInterval: 60_000,
    enabled: session?.state === "ready",
    select: (d) => (Array.isArray(d) ? d.length : 0),
  });

  const { data: unavailableSourceCount } = useQuery({
    queryKey: ["nav-badge-monitoring", session?.tenant_id],
    queryFn: () => api.get<{ operational_evidence_state?: string }[]>("/api/v1/monitoring/sources"),
    refetchInterval: 60_000,
    enabled: session?.state === "ready",
    select: (d) => (Array.isArray(d) ? d.filter((s) => s.operational_evidence_state && !["current"].includes(s.operational_evidence_state)).length : 0),
  });

  const { data: activeMaintenanceCount } = useQuery({
    queryKey: ["nav-badge-maintenance", session?.tenant_id],
    queryFn: () => api.get<{ starts_at: string; ends_at: string }[]>(`/api/v1/maintenance/windows?tenant_id=${session?.tenant_id}`),
    refetchInterval: 60_000,
    enabled: session?.state === "ready",
    select: (d) => {
      const now = Date.now();
      return Array.isArray(d) ? d.filter((w) => new Date(w.starts_at).getTime() <= now && new Date(w.ends_at).getTime() >= now).length : 0;
    },
  });

  const { data: failedNotificationCount } = useQuery({
    queryKey: ["nav-badge-channels", session?.tenant_id],
    queryFn: () => api.get<{ current_state?: string }[]>("/api/v1/alerting/notifications"),
    refetchInterval: 60_000,
    enabled: session?.state === "ready",
    select: (d) => (Array.isArray(d) ? d.filter((n) => n.current_state === "failed" || n.current_state === "permanently_failed").length : 0),
  });

  const { data: criticalAlertCount } = useQuery({
    queryKey: ["nav-badge-critical", session?.tenant_id],
    queryFn: () => api.get<unknown[]>("/api/v1/alerting/alerts?lifecycle_state=active&severity=critical"),
    refetchInterval: 30_000,
    enabled: session?.state === "ready",
    select: (d) => (Array.isArray(d) ? d.length : 0),
  });

  const { data: featureFlags } = useQuery<{ flag_key: string; enabled: boolean }[]>({
    queryKey: ["feature-flags", session?.tenant_id],
    queryFn: () => api.get<{ flag_key: string; enabled: boolean }[]>("/api/v1/feature-flags"),
    enabled: session?.state === "ready",
    staleTime: 300_000,
  });
  const flagEnabled = (key: string): boolean => {
    if (!featureFlags) return true; // optimistic: show while loading
    const flag = featureFlags.find((f) => f.flag_key === key);
    return flag === undefined ? true : flag.enabled; // missing flag = enabled
  };

  // Restore last visited path per tenant on first load
  useEffect(() => {
    if (session?.state !== "ready") return;
    const stored = (() => {
      try { return localStorage.getItem(`jlm_last_path_${session.tenant_id}`) ?? null; } catch { return null; }
    })();
    if (stored && location.pathname === "/" && stored !== "/") {
      navigate(stored, { replace: true });
    }
  }, [session?.state === "ready" ? session.tenant_id : null]); // eslint-disable-line

  const view = currentViewFromPath(location.pathname);
  const s = session;
  const branding = useBranding(s?.state === "ready" ? s.tenant_id : null);

  const goTo = (v: View) => {
    const path = VIEW_TO_PATH[v] ?? "/";
    navigate(path);
    try { localStorage.setItem(`jlm_last_path_${s?.tenant_id}`, path); } catch { /* */ }
  };

  if (isLoading) return <FullPageSpinner />;

  if (!s || s.state === "unavailable") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="text-[var(--text-muted)] text-sm">{t("common.serviceUnavailable")}</div>
      </div>
    );
  }

  if (s.state === "unauthenticated") {
    const healthDots = Array.from({ length: 60 }, (_, i) => {
      if (i === 15) return { color: "#F87171", opacity: 1 };
      if (i === 7 || i === 33 || i === 51) return { color: "#FBBF24", opacity: 0.95 };
      return { color: "#1BA898", opacity: 0.3 + (i % 7) * 0.1 };
    });
    return (
      <>
        <style>{`
          @keyframes argos-pulse {
            0%, 100% { box-shadow: 0 0 0 0 rgba(74,222,128,0.6); }
            60% { box-shadow: 0 0 0 5px rgba(74,222,128,0); }
          }
          @keyframes argos-scan {
            0% { top: 0; opacity: 0.5; }
            100% { top: 100%; opacity: 0; }
          }
          .argos-landing {
            min-height: 100vh;
            background: #060D0B;
            display: grid;
            grid-template-columns: 55fr 45fr;
            position: relative;
            overflow: hidden;
          }
          @media (max-width: 860px) {
            .argos-landing { grid-template-columns: 1fr; }
            .argos-right-col { display: none !important; }
            .argos-left-col {
              padding: 52px 32px !important;
              align-items: center !important;
            }
            .argos-headline { font-size: 36px !important; }
            .argos-desc { max-width: 100% !important; }
            .argos-cta-wrap { max-width: 100% !important; }
          }
        `}</style>

        <div className="argos-landing">
          <div style={{
            position: "absolute", inset: 0, pointerEvents: "none",
            background: "radial-gradient(ellipse 50% 70% at 10% 50%, rgba(27,168,152,0.07) 0%, transparent 65%)",
          }} />
          <div style={{
            position: "absolute", inset: 0, pointerEvents: "none", opacity: 0.025,
            backgroundImage: "linear-gradient(#1BA898 1px, transparent 1px), linear-gradient(90deg, #1BA898 1px, transparent 1px)",
            backgroundSize: "44px 44px",
          }} />

          {/* LEFT */}
          <div className="argos-left-col" style={{
            display: "flex", flexDirection: "column", justifyContent: "center",
            padding: "64px 56px 64px 72px", position: "relative", zIndex: 1,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 52 }}>
              <svg viewBox="0 0 100 100" width={40} height={40} style={{ borderRadius: 10, flexShrink: 0 }}>
                <rect width="100" height="100" rx="22" fill="#1b3f82"/>
                <line x1="16" y1="24" x2="44" y2="24" stroke="white" strokeWidth="8.5" strokeLinecap="round"/>
                <path d="M 35,24 L 35,66 Q 35,80 23,80 Q 11,80 11,67" stroke="white" strokeWidth="8.5" strokeLinecap="round" fill="none"/>
                <polyline points="55,24 55,78 83,78" stroke="white" strokeWidth="8.5" strokeLinecap="round" fill="none"/>
              </svg>
              <div>
                <div style={{ fontSize: 20, fontWeight: 700, color: "#1BA898", letterSpacing: "-0.3px", lineHeight: 1 }}>Argos</div>
                <div style={{ fontSize: 10, color: "#2D4D45", letterSpacing: "0.12em", marginTop: 3 }}>JL INFORMÁTICA</div>
              </div>
            </div>

            <h1 className="argos-headline" style={{
              fontSize: "clamp(36px, 3.6vw, 56px)",
              fontWeight: 700,
              color: "#E8EDEB",
              lineHeight: 1.07,
              letterSpacing: "-0.03em",
              margin: "0 0 20px",
            }}>
              Visibilidade total.<br/>
              <span style={{ color: "#1BA898" }}>Resposta imediata.</span>
            </h1>

            <p className="argos-desc" style={{
              fontSize: 15, color: "#4E6D66", lineHeight: 1.7,
              margin: "0 0 36px", maxWidth: 400,
            }}>
              Monitoramento unificado, alertas inteligentes e gestão
              de operações para MSPs e equipes de TI.
            </p>

            <div style={{ display: "flex", flexDirection: "column", gap: 14, marginBottom: 44 }}>
              {[
                "Monitoramento de infraestrutura e aplicações em tempo real",
                "Alertas inteligentes com roteamento e escalonamento automático",
                "ITSM integrado — incidentes, SLA e base de conhecimento",
              ].map((text, i) => (
                <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
                  <div style={{
                    width: 5, height: 5, borderRadius: "50%",
                    background: "#1BA898", flexShrink: 0, marginTop: 7,
                  }} />
                  <span style={{ fontSize: 13.5, color: "#5A7870", lineHeight: 1.5 }}>{text}</span>
                </div>
              ))}
            </div>

            <div className="argos-cta-wrap" style={{ maxWidth: 300 }}>
              <a href="/auth/login" style={{ textDecoration: "none", display: "block" }}>
                <Button style={{ width: "100%", height: 48, fontSize: 15 }}>
                  Entrar na plataforma
                </Button>
              </a>
              {s.environment === "development" && (
                <a href="/auth/dev-login" style={{ fontSize: 12, color: "#2D4D45", marginTop: 10, display: "block" }}>
                  {t("auth.devSignIn")}
                </a>
              )}
            </div>

            <p style={{ marginTop: 52, fontSize: 11, color: "#1E3330" }}>
              © 2026 JL Informática — Uso restrito a clientes e colaboradores
            </p>
          </div>

          {/* RIGHT */}
          <div className="argos-right-col" style={{
            display: "flex", alignItems: "center", justifyContent: "center",
            padding: "64px 72px 64px 24px", position: "relative", zIndex: 1,
          }}>
            <div style={{
              background: "#0A1714",
              border: "1px solid #162E28",
              borderRadius: 20,
              padding: "28px 28px 24px",
              width: "100%",
              maxWidth: 360,
              position: "relative",
              overflow: "hidden",
              boxShadow: "inset 0 1px 0 rgba(27,168,152,0.07), 0 40px 100px rgba(0,0,0,0.6)",
            }}>
              <div style={{
                position: "absolute",
                left: 0, right: 0, height: 1,
                background: "linear-gradient(90deg, transparent 0%, rgba(27,168,152,0.3) 50%, transparent 100%)",
                animation: "argos-scan 5s linear infinite",
                pointerEvents: "none",
              }} />

              <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 22 }}>
                <div style={{
                  width: 7, height: 7, borderRadius: "50%", background: "#4ADE80",
                  flexShrink: 0, animation: "argos-pulse 2.5s ease-in-out infinite",
                }} />
                <span style={{ fontSize: 11, color: "#4ADE80", letterSpacing: "0.1em", fontWeight: 500 }}>SISTEMA AO VIVO</span>
                <span style={{ marginLeft: "auto", fontSize: 10, color: "#1E3330" }}>nov 2026</span>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 22 }}>
                {[
                  { label: "Dispositivos", value: "2.847", sub: "online agora", color: "#1BA898" },
                  { label: "Alertas ativos", value: "3", sub: "requerem atenção", color: "#F87171" },
                  { label: "Resposta P95", value: "142ms", sub: "média global", color: "#E8EDEB" },
                  { label: "Uptime médio", value: "99,98%", sub: "últimos 30 dias", color: "#4ADE80" },
                ].map((m) => (
                  <div key={m.label} style={{
                    background: "#0C1A16",
                    border: "1px solid #162E28",
                    borderRadius: 10, padding: "12px 14px",
                  }}>
                    <div style={{ fontSize: 10, color: "#2D4D45", marginBottom: 5, letterSpacing: "0.04em" }}>{m.label}</div>
                    <div style={{
                      fontSize: 22, fontWeight: 700, color: m.color,
                      letterSpacing: "-0.02em", lineHeight: 1,
                    }}>{m.value}</div>
                    <div style={{ fontSize: 10, color: "#2D4D45", marginTop: 4 }}>{m.sub}</div>
                  </div>
                ))}
              </div>

              <div style={{ marginBottom: 12 }}>
                <div style={{ fontSize: 10, color: "#1E3330", marginBottom: 8, letterSpacing: "0.08em" }}>SAÚDE DA FROTA</div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: "3px" }}>
                  {healthDots.map((dot, i) => (
                    <div key={i} style={{
                      paddingBottom: "100%",
                      borderRadius: 2,
                      background: dot.color,
                      opacity: dot.opacity,
                    }} />
                  ))}
                </div>
              </div>

              <div style={{ display: "flex", gap: 14 }}>
                {[
                  { color: "#1BA898", label: "56 saudáveis" },
                  { color: "#FBBF24", label: "3 atenção" },
                  { color: "#F87171", label: "1 crítico" },
                ].map((l) => (
                  <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={{ width: 6, height: 6, borderRadius: 1, background: l.color, flexShrink: 0, display: "inline-block", opacity: 0.9 }} />
                    <span style={{ fontSize: 10, color: "#2D4D45" }}>{l.label}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }

  if (s.state === "forbidden") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-10 min-w-[320px] text-center">
          <p className="text-[var(--red)] mb-4">{t("auth.accessDenied")}</p>
          <Button variant="secondary" onClick={() => logout()}>{t("common.signOut")}</Button>
        </div>
      </div>
    );
  }

  if (s.state === "needs_tenant") {
    const memberships = s.memberships ?? [];
    if (memberships.length === 0) {
      return <OnboardingPage principalId={s.principal_id!} />;
    }

    const roleIcon = (role?: string) => {
      if (!role) return Building2;
      if (role === "platform") return ShieldCheck;
      if (role.includes("msp")) return Network;
      if (role.includes("admin")) return Shield;
      return Building2;
    };

    const roleLabel = (role?: string) => {
      if (!role) return "membro";
      const map: Record<string, string> = {
        platform: "Plataforma",
        msp_admin: "MSP Admin",
        msp_operator: "MSP Operador",
        tenant_admin: "Admin",
        operator: "Operador",
        viewer: "Visualizador",
      };
      return map[role] ?? role;
    };

    const envFromId = (id: string) => {
      if (id.includes("dev") || id.includes("test") || id.includes("ci")) return "dev";
      if (id.includes("staging") || id.includes("hml")) return "hml";
      return "prod";
    };

    const envColor: Record<string, string> = {
      dev:  "#FBBF24",
      hml:  "#60A5FA",
      prod: "#4ADE80",
    };

    const pendingId = selectTenant.isPending ? (selectTenant.variables as string | undefined) : undefined;

    return (
      <div style={{
        minHeight: "100vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "var(--bg)",
        padding: "24px 16px",
        position: "relative",
        overflow: "hidden",
      }}>
        {/* Grid */}
        <div style={{
          position: "fixed", inset: 0, opacity: 0.025, pointerEvents: "none",
          backgroundImage: "linear-gradient(#1BA898 1px, transparent 1px), linear-gradient(90deg, #1BA898 1px, transparent 1px)",
          backgroundSize: "44px 44px",
        }} />
        {/* Glow */}
        <div style={{
          position: "fixed", inset: 0, pointerEvents: "none",
          background: "radial-gradient(ellipse 60% 70% at 50% 40%, rgba(27,168,152,0.07) 0%, transparent 70%)",
        }} />

        <div style={{
          position: "relative", zIndex: 1,
          width: "100%", maxWidth: 440,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
          padding: "36px 32px",
          boxShadow: "0 8px 40px rgba(0,0,0,0.6)",
        }}>
          {/* Logo */}
          <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28, justifyContent: "center" }}>
            <svg viewBox="0 0 100 100" width="36" height="36" style={{ borderRadius: 9, flexShrink: 0 }}>
              <rect width="100" height="100" rx="22" fill="#1b3f82"/>
              <line x1="16" y1="24" x2="44" y2="24" stroke="white" strokeWidth="8.5" strokeLinecap="round"/>
              <path d="M 35,24 L 35,66 Q 35,80 23,80 Q 11,80 11,67" stroke="white" strokeWidth="8.5" strokeLinecap="round" fill="none"/>
              <polyline points="55,24 55,78 83,78" stroke="white" strokeWidth="8.5" strokeLinecap="round" fill="none"/>
            </svg>
            <div style={{ lineHeight: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 700, color: "var(--brand)", letterSpacing: "-0.3px" }}>Argos</div>
              <div style={{ fontSize: 9, color: "var(--text-dim)", letterSpacing: "0.12em", marginTop: 3, textTransform: "uppercase" }}>JL Informática</div>
            </div>
          </div>

          {/* Greeting */}
          {s.display_name && (
            <div style={{ textAlign: "center", marginBottom: 20 }}>
              <div style={{ fontSize: 15, fontWeight: 600, color: "var(--text)" }}>Olá, {s.display_name.split(" ")[0]}</div>
              {s.email && <div style={{ fontSize: 12, color: "var(--text-muted)", marginTop: 3 }}>{s.email}</div>}
            </div>
          )}

          <div style={{ textAlign: "center", marginBottom: 20 }}>
            <div style={{
              fontSize: 13, fontWeight: 600, color: "var(--text)",
              marginBottom: 4,
            }}>
              {memberships.length === 1 ? "1 workspace disponível" : `${memberships.length} workspaces disponíveis`}
            </div>
            <div style={{ fontSize: 12, color: "var(--text-muted)" }}>
              Selecione o ambiente que deseja acessar
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {memberships.map((m) => {
              const Icon = roleIcon(m.role);
              const env = envFromId(m.tenant_id);
              const isLoading = pendingId === m.tenant_id;
              const envLabel: Record<string, string> = { dev: "Desenvolvimento", hml: "Homologação", prod: "Produção" };
              return (
                <button
                  key={m.tenant_id}
                  onClick={() => selectTenant.mutate(m.tenant_id)}
                  disabled={selectTenant.isPending}
                  style={{
                    width: "100%",
                    display: "flex",
                    alignItems: "center",
                    gap: 12,
                    padding: "13px 14px",
                    borderRadius: 10,
                    background: "var(--surface-2)",
                    border: `1px solid ${isLoading ? "var(--brand)" : "var(--border)"}`,
                    cursor: selectTenant.isPending ? "wait" : "pointer",
                    textAlign: "left",
                    transition: "border-color 0.15s, background 0.15s",
                    opacity: selectTenant.isPending && !isLoading ? 0.5 : 1,
                  }}
                  onMouseEnter={(e) => {
                    if (!selectTenant.isPending) {
                      (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--brand)";
                      (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-hover, var(--surface-2))";
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isLoading) (e.currentTarget as HTMLButtonElement).style.borderColor = "var(--border)";
                    (e.currentTarget as HTMLButtonElement).style.background = "var(--surface-2)";
                  }}
                >
                  {/* Env color stripe */}
                  <div style={{
                    width: 3, height: 36, borderRadius: 2, flexShrink: 0,
                    background: envColor[env], opacity: 0.8,
                  }} />

                  {/* Icon */}
                  <div style={{
                    width: 34, height: 34, borderRadius: 8, flexShrink: 0,
                    background: "var(--border)", display: "flex", alignItems: "center", justifyContent: "center",
                  }}>
                    <Icon size={15} color="var(--brand)" />
                  </div>

                  {/* Text */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                      {m.display_name ?? m.tenant_id}
                    </div>
                    <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
                      {envLabel[env]} · {roleLabel(m.role)}
                    </div>
                  </div>

                  {/* Right side */}
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                    {isLoading ? (
                      <div style={{
                        width: 14, height: 14, border: "2px solid var(--border)",
                        borderTopColor: "var(--brand)", borderRadius: "50%",
                        animation: "spin 0.7s linear infinite",
                      }} />
                    ) : (
                      <span style={{
                        fontSize: 10, fontWeight: 700,
                        color: envColor[env],
                        background: `${envColor[env]}18`,
                        borderRadius: 4, padding: "3px 7px",
                        letterSpacing: "0.08em", textTransform: "uppercase",
                      }}>
                        {env}
                      </span>
                    )}
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                  </div>
                </button>
              );
            })}
          </div>

          <div style={{ marginTop: 24, textAlign: "center" }}>
            <button
              onClick={() => logout()}
              style={{ fontSize: 12, color: "var(--text-dim)", background: "none", border: "none", cursor: "pointer" }}
              onMouseEnter={(e) => ((e.target as HTMLButtonElement).style.color = "var(--text-muted)")}
              onMouseLeave={(e) => ((e.target as HTMLButtonElement).style.color = "var(--text-dim)")}
            >
              Sair da conta
            </button>
          </div>
        </div>

        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // state === "ready"
  const perms = s.permissions ?? [];
  const has = (p: string) => perms.includes(p);

  type NavItem = { id: View; label: string; icon: React.ElementType; description?: string };
  type NavGroup = { label: string; items: NavItem[] };

  const badgeCount: Partial<Record<View, number>> = {
    alerts: activeAlertCount ?? 0,
    incidents: openIncidentCount ?? 0,
    changes: openChangesCount ?? 0,
    sla: slaBreachCount ?? 0,
    monitoring: unavailableSourceCount ?? 0,
    maintenance: activeMaintenanceCount ?? 0,
    channels: failedNotificationCount ?? 0,
  };

  const navGroups: NavGroup[] = [
    {
      label: "Operações",
      items: [
        { id: "noc", label: t("nav.noc"), icon: LayoutDashboard, description: "Painel em tempo real" },
        { id: "custom_dashboard" as View, label: t("nav.custom_dashboard"), icon: LayoutGrid, description: "Dashboard personalizado com widgets" },
        { id: "alerts", label: t("nav.alerts"), icon: Bell, description: "Alertas ativos" },
        { id: "incidents", label: t("nav.incidents"), icon: Siren, description: "Gestão de incidentes" },
        { id: "policies", label: t("nav.policies"), icon: Shield, description: "Regras de alerta" },
        { id: "correlation" as View, label: t("nav.correlation", "Correlação"), icon: GitMerge, description: "Agrupamento e correlação de alertas" },
        ...((has("tenant:admin") || s.is_platform_admin) && flagEnabled("module_executive") ? [
          { id: "executive" as View, label: t("nav.executive"), icon: TrendingUp, description: "KPIs executivos da plataforma" },
        ] : []),
      ],
    },
    ...(has("monitoring:operate") ? [{
      label: "ITSM",
      items: [
        { id: "changes" as View, label: t("nav.changes"), icon: GitMerge, description: "Controle de mudanças" },
        { id: "helpdesk" as View, label: t("nav.helpdesk", "Helpdesk"), icon: Wrench, description: "Chamados de suporte com SLA" },
        { id: "incident-response" as View, label: t("nav.incident_response", "Resposta a Incidentes"), icon: ShieldCheck, description: "Políticas de resposta automática" },
        ...(flagEnabled("module_sla") ? [{ id: "sla" as View, label: t("nav.sla"), icon: Clock, description: "Níveis de serviço" }] : []),
        ...(flagEnabled("module_automation") ? [{ id: "automation" as View, label: t("nav.automation"), icon: Zap, description: "Scripts e tarefas" }] : []),
        ...(flagEnabled("module_reports") ? [{ id: "reports" as View, label: t("nav.reports"), icon: BarChart2, description: "Relatórios periódicos" }] : []),
      ],
    }] : []),
    {
      label: "Inteligência",
      items: [
        ...(flagEnabled("module_aiops") ? [{ id: "aiops" as View, label: t("nav.aiops"), icon: Brain, description: "Correlação por IA" }] : []),
        ...(flagEnabled("module_finops") ? [{ id: "finops" as View, label: t("nav.finops"), icon: DollarSign, description: "Custos de infra" }] : []),
        { id: "apm" as View, label: t("nav.apm"), icon: Gauge, description: "Latência e erros de API" },
        { id: "logs" as View, label: t("nav.logs", "Logs"), icon: FileText, description: "Ingestão e busca de logs" },
        { id: "security-audit" as View, label: t("nav.security_audit", "Auditoria de Segurança"), icon: ShieldAlert, description: "Regras e findings de segurança" },
      ],
    },
    {
      label: "Integrações",
      items: [
        { id: "monitoring" as View, label: t("nav.monitoring"), icon: Activity, description: "Fontes e integrações" },
        { id: "inventory" as View, label: t("nav.inventory"), icon: Package, description: "Hosts e ativos" },
        { id: "teia" as View, label: t("nav.teia"), icon: Network, description: "Mapa relacional do tenant" },
        ...(flagEnabled("module_synthetic") ? [{ id: "synthetic" as View, label: t("nav.synthetic"), icon: Radio, description: "Checks HTTP periódicos" }] : []),
        ...(has("monitoring:operate") ? [{ id: "alertmanager" as View, label: t("nav.alertmanager"), icon: Webhook, description: "Regras Prometheus" }] : []),
        ...(has("monitoring:operate") ? [{ id: "webhooks" as View, label: t("nav.webhooks", "Webhooks"), icon: Webhook, description: "Webhooks de saída HMAC-SHA256" }] : []),
      ],
    },
    {
      label: "Infraestrutura",
      items: [
        ...(has("monitoring:operate") ? [
          { id: "infra" as View, label: t("nav.infra"), icon: Server, description: "Servidores e redes" },
          ...(flagEnabled("module_maintenance") ? [{ id: "maintenance" as View, label: t("nav.maintenance"), icon: Wrench, description: "Janelas de manutenção" }] : []),
        ] : []),
        { id: "platform" as View, label: t("nav.platform"), icon: Settings2, description: "Configurações gerais" },
        ...(flagEnabled("module_drift") ? [{ id: "config-drift" as View, label: t("nav.config_drift"), icon: GitCompare, description: "Desvio de configuração" }] : []),
        { id: "capacity" as View, label: t("nav.capacity", "Capacidade"), icon: Gauge, description: "Utilização, thresholds e forecast" },
        ...(has("monitoring:operate") ? [{ id: "backup" as View, label: t("nav.backup", "Backup"), icon: HardDrive, description: "Jobs de backup e snapshots" }] : []),
        ...(has("monitoring:operate") ? [{ id: "firewall" as View, label: t("nav.firewall", "Firewall"), icon: ShieldCheck, description: "Regras, deploy SSH e versionamento" }] : []),
        ...(has("monitoring:operate") ? [{ id: "k8s" as View, label: t("nav.k8s", "Kubernetes"), icon: Network, description: "Clusters, recursos e sync" }] : []),
        ...(has("monitoring:operate") ? [{ id: "discovery" as View, label: t("nav.discovery", "Discovery"), icon: Radio, description: "Auto-discovery SNMP e ping" }] : []),
        { id: "data_transfer" as View, label: t("nav.data_transfer", "Transferência de Dados"), icon: ArrowLeftRight, description: "Export, import e templates CSV/XLSX/JSON" },
        { id: "status_page" as View, label: t("nav.status_page"), icon: Globe, description: "Status público do tenant" },
      ],
    },
    ...(has("monitoring:operate") ? [{
      label: "Notificações",
      items: [
        { id: "channels" as View, label: t("nav.channels"), icon: MessageSquare, description: "Canais de notificação" },
        { id: "escalation" as View, label: t("nav.escalation"), icon: PhoneCall, description: "Políticas de escalonamento" },
        ...(flagEnabled("module_oncall") ? [{ id: "oncall" as View, label: t("nav.oncall"), icon: CalendarClock, description: "Escalas de on-call" }] : []),
      ],
    }] : []),
    ...((has("tenant:admin") || has("audit:read")) ? [{
      label: "Equipe & Acesso",
      items: [
        ...(has("tenant:admin") ? [
          { id: "users" as View, label: t("nav.users"), icon: UserPlus, description: "Convidar e gerir usuários" },
          { id: "team" as View, label: t("nav.team"), icon: Users, description: "Membros e funções" },
          { id: "apikeys" as View, label: t("nav.apikeys"), icon: KeyRound, description: "Chaves de integração" },
          { id: "bugs" as View, label: t("nav.bugs"), icon: Bug, description: "Bugs reportados pelos usuários" },
          { id: "billing" as View, label: t("nav.billing", "Faturamento"), icon: DollarSign, description: "Faturas e uso do período atual" },
        ] : []),
        ...(has("audit:read") ? [{ id: "audit" as View, label: t("nav.audit"), icon: ScrollText, description: "Logs de auditoria" }] : []),
      ],
    }] : []),
    ...(hasMSPClients || has("tenant:admin") ? [{
      label: "MSP",
      items: [
        { id: "companies" as View, label: t("nav.companies"), icon: Building2, description: "Empresas e carteira de clientes" },
        ...(hasMSPClients ? [{ id: "msp" as View, label: t("nav.msp"), icon: Building2, description: "Clientes MSP" }] : []),
        ...(has("monitoring:operate") ? [{ id: "contracts" as View, label: t("nav.contracts", "Contratos"), icon: FileText, description: "Contratos, banco de horas e fechamento" }] : []),
        ...(flagEnabled("module_client_portal") ? [{ id: "client-portal" as View, label: t("nav.client_portal", "Portal do Cliente"), icon: Globe, description: "Visão simplificada para clientes finais" }] : []),
      ],
    }] : []),
    ...((has("platform_admin") || has("tenant:admin")) ? [{
      label: "Plataforma",
      items: [
        {
          id: "platform-admin" as View,
          label: t("nav.platform_admin"),
          icon: ShieldCheck,
          description: "Configurações globais da plataforma",
        },
        ...(has("platform_admin") || has("tenant:admin") ? [{
          id: "permissions" as View,
          label: t("nav.permissions", "Permissões"),
          icon: ScrollText,
          description: "Catálogo de acesso por papel",
        }] : []),
        ...(has("tenant:admin") ? [{
          id: "feature-flags" as View,
          label: t("nav.feature_flags"),
          icon: ToggleLeft,
          description: "Módulos ativos do tenant",
        }] : []),
        ...(has("tenant:admin") ? [{
          id: "tenant-settings" as View,
          label: t("nav.tenant_settings"),
          icon: Settings2,
          description: "SMTP, branding e configurações avançadas",
        }] : []),
      ],
    }] : []),
  ];

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      const next = !v;
      try { localStorage.setItem("jlm_sidebar_collapsed", next ? "1" : "0"); } catch { /* */ }
      return next;
    });
  };

  const toggleGroup = (label: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label); else next.add(label);
      try { localStorage.setItem("jlm_collapsed_groups", JSON.stringify([...next])); } catch {}
      return next;
    });
  };

  const displayName = s.display_name ?? s.principal_id ?? "";
  const initials = displayName.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase();
  const currentLabel = navGroups.flatMap((g) => g.items).find((i) => i.id === view)?.label ?? "";

  return (
    <div className="flex min-h-screen bg-[var(--bg)]">
      <style>{`@media (max-width: 767px) { .jlm-desktop-only { display: none !important; } }`}</style>
      {sessionExpired && (
        <div
          style={{
            position: "fixed", inset: 0, zIndex: 9999,
            background: "rgba(0,0,0,0.55)",
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-10 min-w-[320px] max-w-md text-center shadow-2xl">
            <p className="text-sm font-medium mb-5" style={{ color: "var(--text)" }}>
              {t("common.sessionExpired")}
            </p>
            <Button onClick={() => logout()}>{t("common.loginAgain")}</Button>
          </div>
        </div>
      )}
      {/* Sidebar */}
      <aside
        style={{ width: collapsed ? 52 : 220, transition: "width 0.22s cubic-bezier(0.4,0,0.2,1)" }}
        className="flex-shrink-0 flex flex-col bg-[var(--surface)] border-r border-[var(--border)] h-screen sticky top-0 overflow-hidden z-20"
      >
        {/* Logo + collapse toggle */}
        <div className={[
          "flex items-center border-b border-[var(--border)] flex-shrink-0",
          collapsed ? "h-[52px] justify-center px-0" : "h-[52px] px-3 gap-2",
        ].join(" ")}>
          {collapsed ? (
            <button
              onClick={toggleCollapsed}
              title={t("sidebar.expandMenu")}
              className="flex flex-col items-center justify-center gap-0.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors"
              style={{ background: "none", border: "none", cursor: "pointer", padding: "6px 4px", width: 44 }}
            >
              <svg viewBox="0 0 100 100" width={22} height={22} xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
                <ellipse cx="50" cy="50" rx="17" ry="36" fill="#9FE1CB" transform="rotate(0 50 50)"/>
                <ellipse cx="50" cy="50" rx="17" ry="36" fill="#1BA898" transform="rotate(45 50 50)"/>
                <ellipse cx="50" cy="50" rx="17" ry="36" fill="#0D6258" transform="rotate(90 50 50)"/>
                <ellipse cx="50" cy="50" rx="17" ry="36" fill="#075044" transform="rotate(135 50 50)"/>
                <circle cx="50" cy="50" r="11" fill="#052A24"/>
              </svg>
              <ChevronRight size={10} style={{ color: "var(--text-muted)", opacity: 0.6 }} />
            </button>
          ) : (
            <>
              <svg viewBox="0 0 100 100" width={24} height={24} xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style={{ flexShrink: 0 }}>
                <ellipse cx="50" cy="50" rx="17" ry="36" fill="#9FE1CB" transform="rotate(0 50 50)"/>
                <ellipse cx="50" cy="50" rx="17" ry="36" fill="#1BA898" transform="rotate(45 50 50)"/>
                <ellipse cx="50" cy="50" rx="17" ry="36" fill="#0D6258" transform="rotate(90 50 50)"/>
                <ellipse cx="50" cy="50" rx="17" ry="36" fill="#075044" transform="rotate(135 50 50)"/>
                <circle cx="50" cy="50" r="11" fill="#052A24"/>
              </svg>
              <span className="text-sm font-semibold tracking-tight flex-1 min-w-0 truncate" style={{ color: "var(--brand)" }}>
                {branding?.configured && branding.brand_name ? branding.brand_name : "argos"}
              </span>
              <button
                onClick={toggleCollapsed}
                title={t("sidebar.collapseMenu")}
                className="flex items-center justify-center rounded-lg hover:bg-[var(--surface-2)] transition-colors"
                style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 5, flexShrink: 0 }}
              >
                <ChevronLeft size={13} />
              </button>
            </>
          )}
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 [&::-webkit-scrollbar]:hidden [scrollbar-width:none]">
          {navGroups.map((group, gi) => {
            const isGroupCollapsed = !collapsed && collapsedGroups.has(group.label);
            return (
              <div key={group.label} className={gi > 0 ? "mt-1" : ""}>
                {!collapsed ? (
                  <button
                    onClick={() => toggleGroup(group.label)}
                    className="w-full flex items-center justify-between px-3 pt-3 pb-1 group/grp"
                  >
                    <span
                      className="text-[9px] font-bold uppercase tracking-[0.12em] select-none transition-colors group-hover/grp:text-[var(--text-muted)]"
                      style={{ color: "var(--text-dim)" }}
                    >
                      {group.label}
                    </span>
                    <ChevronDown
                      size={9}
                      style={{
                        color: "var(--text-dim)",
                        transform: isGroupCollapsed ? "rotate(-90deg)" : "rotate(0deg)",
                        transition: "transform 0.18s ease",
                        flexShrink: 0,
                        opacity: 0.6,
                      }}
                    />
                  </button>
                ) : (
                  gi > 0 && <div className="mx-3.5 my-2 border-t border-[var(--border)] opacity-50" />
                )}
                {!isGroupCollapsed && (
                  <div className="px-2 space-y-0.5">
                    {group.items.map((item) => {
                      const Icon = item.icon;
                      const active = view === item.id;
                      const badge = badgeCount[item.id];
                      return (
                        <button
                          key={item.id}
                          onClick={() => goTo(item.id)}
                          title={collapsed ? item.label : item.description}
                          className={[
                            "w-full flex items-center cursor-pointer outline-none transition-all duration-150",
                            collapsed ? "justify-center h-8 w-8 mx-auto rounded-lg" : "gap-2.5 px-2.5 py-[5px] rounded-lg",
                          ].join(" ")}
                          style={active ? {
                            background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                            color: "var(--brand)",
                            boxShadow: collapsed ? "0 0 0 1.5px var(--brand)" : "inset 2px 0 0 var(--brand)",
                          } : {
                            color: "var(--text-muted)",
                          }}
                          onMouseEnter={e => { if (!active) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"; (e.currentTarget as HTMLElement).style.color = "var(--text)"; }}
                          onMouseLeave={e => { if (!active) { (e.currentTarget as HTMLElement).style.background = ""; (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; } }}
                        >
                          <div className="relative flex-shrink-0">
                            <Icon size={14} strokeWidth={active ? 2.3 : 1.8} />
                            {!!badge && badge > 0 && (
                              <span style={{
                                position: "absolute", top: -5, right: -6,
                                background: "var(--red, #ef4444)", color: "#fff",
                                borderRadius: 999, fontSize: 9, fontWeight: 700,
                                minWidth: 14, height: 14,
                                display: "flex", alignItems: "center", justifyContent: "center",
                                padding: "0 3px", lineHeight: 1,
                              }}>
                                {badge > 99 ? "99+" : badge}
                              </span>
                            )}
                          </div>
                          {!collapsed && (
                            <span className="truncate text-[13px] leading-none flex-1 min-w-0 text-left"
                              style={{ fontWeight: active ? 600 : 400 }}>
                              {item.label}
                            </span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        {/* Knowledge base — fixed utility link */}
        <div className="flex-shrink-0 border-t border-[var(--border)] px-2 py-1.5"
          style={flagEnabled("module_kb") ? undefined : { display: "none" }}>
          <button
            onClick={() => goTo("kb")}
            title={collapsed ? t("nav.kb") : "Documentação e runbooks"}
            className={[
              "w-full flex items-center cursor-pointer outline-none transition-all duration-150",
              collapsed ? "justify-center h-8 w-8 mx-auto rounded-lg" : "gap-2.5 px-2.5 py-[5px] rounded-lg",
            ].join(" ")}
            style={view === "kb" ? {
              background: "color-mix(in srgb, var(--brand) 12%, transparent)",
              color: "var(--brand)",
              boxShadow: collapsed ? undefined : "inset 2px 0 0 var(--brand)",
            } : { color: "var(--text-muted)" }}
            onMouseEnter={e => { if (view !== "kb") { (e.currentTarget as HTMLElement).style.background = "var(--surface-2)"; (e.currentTarget as HTMLElement).style.color = "var(--text)"; } }}
            onMouseLeave={e => { if (view !== "kb") { (e.currentTarget as HTMLElement).style.background = ""; (e.currentTarget as HTMLElement).style.color = "var(--text-muted)"; } }}
          >
            <BookOpen size={14} strokeWidth={view === "kb" ? 2.3 : 1.8} className="flex-shrink-0" />
            {!collapsed && (
              <span className="truncate text-[13px] leading-none flex-1 min-w-0 text-left"
                style={{ fontWeight: view === "kb" ? 600 : 400 }}>
                {t("nav.kb")}
              </span>
            )}
          </button>
        </div>

        {/* Bottom: user + collapse */}
        <div className="flex-shrink-0 border-t border-[var(--border)] p-2 space-y-1">
          <div className={[
            "flex items-center rounded-lg px-2 py-1.5 gap-2 min-w-0",
            collapsed ? "justify-center" : "",
          ].join(" ")}>
            <div
              className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold relative"
              style={{ background: "color-mix(in srgb, var(--brand) 20%, var(--surface-2))", color: "var(--brand)" }}
              title={s.is_platform_admin ? "Platform Admin" : undefined}
            >
              {initials || "?"}
              {s.is_platform_admin && (
                <span style={{
                  position: "absolute", bottom: -2, right: -2,
                  width: 8, height: 8, borderRadius: "50%",
                  background: "var(--brand, #1BA898)",
                  border: "1.5px solid var(--surface)",
                }} />
              )}
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate leading-tight" style={{ color: "var(--text)" }}>
                  {s.display_name || displayName}
                </div>
                <div className="text-[10px] truncate leading-tight" style={{ color: "var(--text-dim)" }}>
                  {s.is_platform_admin ? "Platform Admin" : (s.email || s.tenant_id)}
                </div>
              </div>
            )}
            {!collapsed && (
              <button
                type="button"
                title={t("accountSecurity.title")}
                onClick={() => goTo("account-security")}
                className="p-1 rounded-md hover:bg-[var(--surface-2)] transition-colors"
                style={{ color: "var(--text-muted)" }}
              >
                <ShieldCheck size={13} />
              </button>
            )}
            <button
              type="button"
              title="Sair"
              onClick={() => logout()}
              className="p-1 rounded-md hover:bg-[var(--surface-2)] transition-colors flex-shrink-0"
              style={{ color: "var(--text-muted)" }}
            >
              <LogOut size={13} />
            </button>
          </div>

        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Topbar */}
        <header className="flex items-center justify-between px-5 py-2.5 sticky top-0 z-10 h-[52px]"
          style={{
            background: "linear-gradient(180deg, var(--surface) 0%, color-mix(in srgb, var(--surface) 95%, var(--bg)) 100%)",
            borderBottom: "1px solid var(--border)",
            boxShadow: "0 1px 0 color-mix(in srgb, var(--brand) 8%, transparent)",
          }}>
          <h1 className="text-sm font-semibold truncate flex-1 min-w-0 mr-2" style={{ color: "var(--text)", letterSpacing: "-0.01em" }}>
            {currentLabel}
          </h1>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            {s.is_platform_admin && (
              <span className="jlm-desktop-only text-[10px] px-2 py-0.5 rounded-full font-semibold"
                style={{ background: "color-mix(in srgb, var(--brand) 15%, transparent)", color: "var(--brand)", border: "1px solid color-mix(in srgb, var(--brand) 30%, transparent)" }}>
                {t("topbar.platformAdmin")}
              </span>
            )}
            <div className="jlm-desktop-only"><LanguageToggle /></div>
            <div className="jlm-desktop-only"><PageInfoButton screenId={view} /></div>
            <div className="jlm-desktop-only"><BugReportButton screenId={view} /></div>
            <button
              onClick={() => goTo("alerts")}
              title={t("topbar.criticalAlerts")}
              className="relative p-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors"
              style={{ color: "var(--text-muted)" }}
            >
              <Bell size={15} strokeWidth={1.8} />
              {!!criticalAlertCount && criticalAlertCount > 0 && (
                <span style={{
                  position: "absolute", top: 2, right: 2,
                  background: "var(--red, #ef4444)", color: "#fff",
                  borderRadius: 999, fontSize: 9, fontWeight: 700,
                  minWidth: 14, height: 14,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  padding: "0 3px", lineHeight: 1,
                }}>
                  {criticalAlertCount > 99 ? "99+" : criticalAlertCount}
                </span>
              )}
            </button>
            {(s.memberships ?? []).length > 1 ? (
              <div ref={tenantDropdownRef} className="relative">
                <button
                  onClick={() => setTenantDropdownOpen((v) => !v)}
                  title={s.tenant_id}
                  className="text-xs px-2 py-0.5 rounded-full border flex items-center gap-1 cursor-pointer transition-colors hover:border-[var(--brand)]"
                  style={{ color: "var(--text-muted)", borderColor: "var(--border)", background: "var(--surface-2)" }}
                >
                  <Building2 size={10} />
                  <span className="max-w-[120px] truncate">{s.tenant?.display_name ?? s.tenant_id}</span>
                  <ChevronDown size={10} style={{ opacity: 0.6 }} />
                </button>
                {tenantDropdownOpen && (
                  <div className="absolute right-0 top-full mt-1 w-60 bg-[var(--surface)] border border-[var(--border)] rounded-lg shadow-lg z-50 py-1 overflow-hidden">
                    <div className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider" style={{ color: "var(--text-dim)" }}>
                      {t("topbar.switchContext", "Mudar contexto")}
                    </div>
                    {(s.memberships ?? []).map((m) => (
                      <button
                        key={m.tenant_id}
                        onClick={() => { handleSelectTenant(m.tenant_id); setTenantDropdownOpen(false); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-[var(--surface-2)] transition-colors text-left"
                        style={{ color: m.tenant_id === s.tenant_id ? "var(--brand)" : "var(--text)" }}
                      >
                        <Building2 size={12} style={{ flexShrink: 0 }} />
                        <span className="flex-1 truncate text-[13px]">{m.display_name ?? m.tenant_id}</span>
                        {m.role && <span className="text-[10px] text-[var(--text-dim)] truncate">{m.role}</span>}
                        {m.tenant_id === s.tenant_id && (
                          <span className="text-[10px] font-bold flex-shrink-0" style={{ color: "var(--brand)" }}>✓</span>
                        )}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <span className="text-xs px-2 py-0.5 rounded-full border"
                title={s.tenant_id}
                style={{ color: "var(--text-muted)", borderColor: "var(--border)", background: "var(--surface-2)", cursor: "default" }}>
                {s.tenant?.display_name ?? s.tenant_id}
              </span>
            )}
          </div>
        </header>

        {/* MSP shortcut banner — shown on MSP's own tenant when not on the MSP overview */}
        {hasMSPClients && view !== "msp" && (
          <div className="flex items-center gap-2 px-4 py-1.5 bg-[var(--surface-2)] border-b border-[var(--border)] text-xs text-[var(--text-muted)]">
            <span>{t("msp.managedClient", { count: mspData?.clients?.length ?? 0 })}</span>
            <button
              onClick={() => goTo("msp")}
              className="text-[var(--brand)] hover:underline cursor-pointer font-medium"
            >
              {t("msp.viewPortfolio")}
            </button>
          </div>
        )}

        {/* Main content */}
        <main className="flex-1 p-5 overflow-auto min-w-0">
          <div className="max-w-[1440px] mx-auto w-full min-h-full">
          {/* key=tenant_id forces full remount on tenant switch — prevents stale data flash */}
          <div key={s.tenant_id} className="contents">
          {view === "noc" && <NOCDashboard tenantId={s.tenant_id!} />}
          {view === "alerts" && <AlertsPage tenantId={s.tenant_id!} />}
          {view === "monitoring" && <MonitoringPage tenantId={s.tenant_id!} />}
          {view === "inventory" && <InventoryPage tenantId={s.tenant_id!} />}
          {view === "aiops" && <AIOpsPage tenantId={s.tenant_id!} />}
          {view === "finops" && <FinOpsPage tenantId={s.tenant_id!} />}
          {view === "executive" && <ExecutiveDashboardPage tenantId={s.tenant_id!} />}
          {view === "platform" && <PlatformPage tenantId={s.tenant_id!} />}
          {view === "audit" && <AuditPage tenantId={s.tenant_id!} />}
          {view === "policies" && <AlertPoliciesPage tenantId={s.tenant_id!} />}
          {view === "team" && <TeamPage tenantId={s.tenant_id!} />}
          {view === "maintenance" && <MaintenancePage tenantId={s.tenant_id!} />}
          {view === "channels" && <NotificationChannelsPage tenantId={s.tenant_id!} />}
          {view === "escalation" && <EscalationPage tenantId={s.tenant_id!} />}
          {view === "synthetic" && <SyntheticPage tenantId={s.tenant_id!} />}
          {view === "oncall" && <OncallPage tenantId={s.tenant_id!} />}
          {view === "custom_dashboard" && <CustomDashboardPage tenantId={s.tenant_id!} />}
          {view === "apikeys" && <ApiKeysPage tenantId={s.tenant_id!} />}
          {view === "changes" && <ITSMPage tenantId={s.tenant_id!} />}
          {view === "helpdesk" && <HelpDeskPage tenantId={s.tenant_id!} permissions={s.permissions ?? []} />}
          {view === "billing" && <BillingPage tenantId={s.tenant_id!} permissions={s.permissions ?? []} />}
          {view === "incident-response" && <IncidentResponsePage tenantId={s.tenant_id!} />}
          {view === "sla" && <SLAPage tenantId={s.tenant_id!} />}
          {view === "automation" && <AutomationPage tenantId={s.tenant_id!} />}
          {view === "reports" && <ReportsPage tenantId={s.tenant_id!} />}
          {view === "alertmanager" && <AlertmanagerPage tenantId={s.tenant_id!} />}
          {view === "infra" && <InfraPage tenantId={s.tenant_id!} />}
          {view === "status_page" && <StatusPageAdminPage tenantId={s.tenant_id!} />}
          {view === "kb" && <KnowledgeBasePage tenantId={s.tenant_id!} />}
          {view === "incidents" && <IncidentsPage tenantId={s.tenant_id!} />}
          {view === "msp" && <MSPOverviewPage tenantId={s.tenant_id!} onSelectTenant={handleSelectTenant} />}
          {view === "users" && <UsersAdminPage tenantId={s.tenant_id!} />}
          {view === "bugs" && <BugReportsPage tenantId={s.tenant_id!} />}
          {view === "platform-admin" && <PlatformAdminPage tenantId={s.tenant_id!} />}
          {view === "teia" && (s.is_platform_admin
            ? <PlatformTeiaPage />
            : <TeiaPage tenantId={s.tenant_id!} />
          )}
          {view === "companies" && <ClientCompaniesPage tenantId={s.tenant_id!} />}
          {view === "permissions" && <PermissionCatalogPage tenantId={s.tenant_id!} />}
          {view === "account-security" && <AccountSecurityPage tenantId={s.tenant_id!} />}
          {view === "config-drift" && <ConfigDriftPage tenantId={s.tenant_id!} />}
          {view === "feature-flags" && <FeatureFlagsPage tenantId={s.tenant_id!} />}
          {view === "tenant-settings" && <TenantSettingsPage tenantId={s.tenant_id!} />}
          {view === "apm" && <APMPage tenantId={s.tenant_id!} />}
          {view === "security-audit" && <SecurityAuditPage tenantId={s.tenant_id!} />}
          {view === "logs" && <LogsPage tenantId={s.tenant_id!} />}
          {view === "webhooks" && <WebhooksPage tenantId={s.tenant_id!} />}
          {view === "contracts" && <ContractsPage tenantId={s.tenant_id!} />}
          {view === "capacity" && <CapacityPage tenantId={s.tenant_id!} />}
          {view === "backup" && <BackupPage tenantId={s.tenant_id!} />}
          {view === "firewall" && <FirewallPage tenantId={s.tenant_id!} />}
          {view === "k8s" && <K8sPage tenantId={s.tenant_id!} />}
          {view === "correlation" && <CorrelationPage tenantId={s.tenant_id!} />}
          {view === "discovery" && <DiscoveryPage tenantId={s.tenant_id!} />}
          {view === "data_transfer" && <DataTransferPage tenantId={s.tenant_id!} />}
          {view === "client-portal" && <ClientPortalPage />}
          </div>
          </div>
        </main>
      </div>
    </div>
  );
}
