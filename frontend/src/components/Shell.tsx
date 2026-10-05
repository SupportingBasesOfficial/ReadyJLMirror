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
  ChevronDown, LogOut, Building2,
} from "lucide-react";
import { api, logout } from "@/api/client";
import { AlertsPage } from "@/pages/AlertsPage";
import { MonitoringPage } from "@/pages/MonitoringPage";
import { InventoryPage } from "@/pages/InventoryPage";
import { NOCDashboard } from "@/pages/NOCDashboard";
import { AIOpsPage } from "@/pages/AIOpsPage";
import { FinOpsPage } from "@/pages/FinOpsPage";
import { PlatformPage } from "@/pages/PlatformPage";
import { AuditPage } from "@/pages/AuditPage";
import { AlertPoliciesPage } from "@/pages/AlertPoliciesPage";
import { TeamPage } from "@/pages/TeamPage";
import { MaintenancePage } from "@/pages/MaintenancePage";
import { NotificationChannelsPage } from "@/pages/NotificationChannelsPage";
import { EscalationPage } from "@/pages/EscalationPage";
import { OnboardingPage } from "@/pages/OnboardingPage";
import { ApiKeysPage } from "@/pages/ApiKeysPage";
import { ITSMPage } from "@/pages/ITSMPage";
import { SLAPage } from "@/pages/SLAPage";
import { AutomationPage } from "@/pages/AutomationPage";
import { ReportsPage } from "@/pages/ReportsPage";
import { AlertmanagerPage } from "@/pages/AlertmanagerPage";
import { InfraPage } from "@/pages/InfraPage";
import { KnowledgeBasePage } from "@/pages/KnowledgeBasePage";
import { IncidentResponsePage } from "@/pages/IncidentResponsePage";
import { MSPOverviewPage } from "@/pages/MSPOverviewPage";
import { UsersAdminPage } from "@/pages/UsersAdminPage";
import { useBranding } from "@/hooks/useBranding";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

const VIEW_TO_PATH: Record<string, string> = {
  noc: "/",
  alerts: "/alerts",
  incidents: "/incidents",
  policies: "/policies",
  changes: "/changes",
  sla: "/sla",
  automation: "/automation",
  reports: "/reports",
  aiops: "/aiops",
  finops: "/finops",
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
  users: "/admin/users",
};

const PATH_TO_VIEW = Object.fromEntries(
  Object.entries(VIEW_TO_PATH).map(([v, p]) => [p, v])
);

type View = keyof typeof VIEW_TO_PATH;

function currentViewFromPath(pathname: string): View {
  return (PATH_TO_VIEW[pathname] ?? "noc") as View;
}

export function Shell() {
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

  const selectTenant = useMutation({
    mutationFn: (tenant_id: string) =>
      api.post("/api/tenant/select", { tenant_id }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["session"] }),
  });

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
    queryFn: () => api.get<unknown[]>(`/api/v1/alerting/tenants/${session?.tenant_id}/application-error-events`),
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
        <div className="text-[var(--text-muted)] text-sm">Serviço indisponível.</div>
      </div>
    );
  }

  if (s.state === "unauthenticated") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-10 min-w-[320px] max-w-md text-center shadow-xl">
          <h1 className="text-xl font-semibold mb-1">
            <span className="text-[var(--brand)]">JL</span>Mirror
          </h1>
          <p className="text-[var(--text-muted)] text-sm mb-6">
            Plataforma de operações para MSPs e equipes de TI
          </p>
          <a href="/auth/login" className="no-underline">
            <Button className="w-full">Entrar</Button>
          </a>
          {s.environment === "development" && (
            <div className="mt-3">
              <a href="/auth/dev-login" className="text-xs text-[var(--text-muted)] hover:text-[var(--brand)]">
                dev sign-in
              </a>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (s.state === "forbidden") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-10 min-w-[320px] text-center">
          <p className="text-[var(--red)] mb-4">Acesso negado — sem associação a um workspace ativo.</p>
          <Button variant="secondary" onClick={() => logout()}>Sair</Button>
        </div>
      </div>
    );
  }

  if (s.state === "needs_tenant") {
    const memberships = s.memberships ?? [];
    if (memberships.length === 0) {
      return <OnboardingPage principalId={s.principal_id!} />;
    }
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-8 min-w-[320px] max-w-md">
          <h2 className="text-base font-semibold mb-4">Selecionar workspace</h2>
          <div className="space-y-2">
            {memberships.map((t) => (
              <button
                key={t.tenant_id}
                onClick={() => selectTenant.mutate(t.tenant_id)}
                className="w-full flex items-center justify-between px-3 py-2.5 rounded-lg
                  bg-[var(--surface-2)] border border-[var(--border)]
                  hover:border-[var(--brand)] text-left cursor-pointer transition-colors"
              >
                <span className="text-sm font-medium">{t.display_name ?? t.tenant_id}</span>
                <span className="text-xs text-[var(--text-muted)]">{t.role ?? ""}</span>
              </button>
            ))}
          </div>
        </div>
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
        { id: "noc", label: "NOC", icon: LayoutDashboard, description: "Painel em tempo real" },
        { id: "alerts", label: "Alertas", icon: Bell, description: "Alertas ativos" },
        { id: "incidents", label: "Incidentes", icon: Siren, description: "Gestão de incidentes" },
        { id: "policies", label: "Políticas", icon: Shield, description: "Regras de alerta" },
      ],
    },
    ...(has("monitoring:operate") ? [{
      label: "ITSM",
      items: [
        { id: "changes" as View, label: "Mudanças", icon: GitMerge, description: "Controle de mudanças" },
        { id: "sla" as View, label: "SLA", icon: Clock, description: "Níveis de serviço" },
        { id: "automation" as View, label: "Automação", icon: Zap, description: "Scripts e tarefas" },
        { id: "reports" as View, label: "Relatórios", icon: BarChart2, description: "Relatórios periódicos" },
      ],
    }] : []),
    {
      label: "Inteligência",
      items: [
        { id: "aiops" as View, label: "AIOps", icon: Brain, description: "Correlação por IA" },
        { id: "finops" as View, label: "FinOps", icon: DollarSign, description: "Custos de infra" },
      ],
    },
    {
      label: "Integrações",
      items: [
        { id: "monitoring" as View, label: "Monitoramento", icon: Activity, description: "Fontes e integrações" },
        { id: "inventory" as View, label: "Inventário", icon: Package, description: "Hosts e ativos" },
        ...(has("monitoring:operate") ? [{ id: "alertmanager" as View, label: "Alertmanager", icon: Webhook, description: "Regras Prometheus" }] : []),
      ],
    },
    {
      label: "Infraestrutura",
      items: [
        ...(has("monitoring:operate") ? [
          { id: "infra" as View, label: "Infra", icon: Server, description: "Servidores e redes" },
          { id: "maintenance" as View, label: "Manutenção", icon: Wrench, description: "Janelas de manutenção" },
        ] : []),
        { id: "platform" as View, label: "Plataforma", icon: Settings2, description: "Configurações gerais" },
      ],
    },
    ...(has("monitoring:operate") ? [{
      label: "Notificações",
      items: [
        { id: "channels" as View, label: "Canais", icon: MessageSquare, description: "Canais de notificação" },
        { id: "escalation" as View, label: "Escalonamento", icon: PhoneCall, description: "Políticas de escalonamento" },
      ],
    }] : []),
    ...((has("tenant:admin") || has("audit:read")) ? [{
      label: "Equipe & Acesso",
      items: [
        ...(has("tenant:admin") ? [
          { id: "users" as View, label: "Usuários", icon: UserPlus, description: "Convidar e gerir usuários" },
          { id: "team" as View, label: "Equipe", icon: Users, description: "Membros e funções" },
          { id: "apikeys" as View, label: "API Keys", icon: KeyRound, description: "Chaves de integração" },
        ] : []),
        ...(has("audit:read") ? [{ id: "audit" as View, label: "Auditoria", icon: ScrollText, description: "Logs de auditoria" }] : []),
      ],
    }] : []),
    ...(hasMSPClients ? [{
      label: "MSP",
      items: [
        { id: "msp" as View, label: "Portfólio de Clientes", icon: Building2, description: "Clientes MSP" },
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
      {/* Sidebar */}
      <aside
        style={{ width: collapsed ? 52 : 220, transition: "width 0.22s cubic-bezier(0.4,0,0.2,1)" }}
        className="flex-shrink-0 flex flex-col bg-[var(--surface)] border-r border-[var(--border)] h-screen sticky top-0 overflow-hidden z-20"
      >
        {/* Logo */}
        <div className={[
          "flex items-center border-b border-[var(--border)] flex-shrink-0",
          collapsed ? "h-[52px] justify-center px-0" : "h-[52px] px-4 gap-2",
        ].join(" ")}>
          {branding?.configured && branding.logo_url && !collapsed ? (
            <img src={branding.logo_url} alt="logo" className="h-5 w-auto max-w-[100px] object-contain" />
          ) : null}
          {!collapsed && (
            <span className="text-sm font-semibold tracking-tight">
              {branding?.configured && branding.brand_name
                ? <span style={{ color: "var(--brand)" }}>{branding.brand_name}</span>
                : <><span style={{ color: "var(--brand)" }}>JL</span>Mirror</>}
            </span>
          )}
          {collapsed && (
            <span className="text-sm font-bold" style={{ color: "var(--brand)" }}>JL</span>
          )}
        </div>

        {/* Nav groups */}
        <nav className="flex-1 overflow-y-auto overflow-x-hidden py-2 scrollbar-thin">
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
                            boxShadow: collapsed ? undefined : "inset 2px 0 0 var(--brand)",
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
        <div className="flex-shrink-0 border-t border-[var(--border)] px-2 py-1.5">
          <button
            onClick={() => goTo("kb")}
            title={collapsed ? "Base de Conhecimento" : "Documentação e runbooks"}
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
                Base de Conhecimento
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
              className="w-6 h-6 rounded-full flex items-center justify-center flex-shrink-0 text-[10px] font-bold"
              style={{ background: "color-mix(in srgb, var(--brand) 20%, var(--surface-2))", color: "var(--brand)" }}
            >
              {initials || "?"}
            </div>
            {!collapsed && (
              <div className="flex-1 min-w-0">
                <div className="text-xs font-medium truncate leading-tight" style={{ color: "var(--text)" }}>
                  {displayName}
                </div>
                <div className="text-[10px] truncate leading-tight" style={{ color: "var(--text-dim)" }}>
                  {s.tenant_id}
                </div>
              </div>
            )}
            {!collapsed && (
              <button
                type="button"
                title="Sair"
                onClick={() => logout()}
                className="p-1 rounded-md hover:bg-[var(--surface-2)] transition-colors"
                style={{ color: "var(--text-muted)" }}
              >
                <LogOut size={13} />
              </button>
            )}
          </div>

          <button
            onClick={toggleCollapsed}
            className={[
              "w-full flex items-center rounded-lg py-1.5 text-xs transition-colors hover:bg-[var(--surface-2)]",
              collapsed ? "justify-center" : "gap-2 px-2.5",
            ].join(" ")}
            style={{ color: "var(--text-muted)" }}
            title={collapsed ? "Expandir menu" : "Recolher menu"}
          >
            {collapsed ? <ChevronRight size={13} /> : (
              <>
                <ChevronLeft size={13} />
                <span>Recolher</span>
              </>
            )}
          </button>
        </div>
      </aside>

      {/* Main area */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Topbar */}
        <header className="flex items-center justify-between px-5 py-2.5 bg-[var(--surface)] border-b border-[var(--border)] sticky top-0 z-10 h-[52px]">
          <h1 className="text-sm font-medium" style={{ color: "var(--text)" }}>
            {currentLabel}
          </h1>
          <div className="flex items-center gap-2">
            <span className="text-xs px-2 py-0.5 rounded-full border"
              style={{ color: "var(--text-muted)", borderColor: "var(--border)", background: "var(--surface-2)" }}>
              {s.tenant_id}
            </span>
          </div>
        </header>

        {/* Main content */}
        <main className="flex-1 p-5 overflow-auto min-w-0">
          {view === "noc" && <NOCDashboard tenantId={s.tenant_id!} />}
          {view === "alerts" && <AlertsPage tenantId={s.tenant_id!} />}
          {view === "monitoring" && <MonitoringPage tenantId={s.tenant_id!} />}
          {view === "inventory" && <InventoryPage tenantId={s.tenant_id!} />}
          {view === "aiops" && <AIOpsPage tenantId={s.tenant_id!} />}
          {view === "finops" && <FinOpsPage tenantId={s.tenant_id!} />}
          {view === "platform" && <PlatformPage tenantId={s.tenant_id!} />}
          {view === "audit" && <AuditPage tenantId={s.tenant_id!} />}
          {view === "policies" && <AlertPoliciesPage tenantId={s.tenant_id!} />}
          {view === "team" && <TeamPage tenantId={s.tenant_id!} />}
          {view === "maintenance" && <MaintenancePage tenantId={s.tenant_id!} />}
          {view === "channels" && <NotificationChannelsPage tenantId={s.tenant_id!} />}
          {view === "escalation" && <EscalationPage tenantId={s.tenant_id!} />}
          {view === "apikeys" && <ApiKeysPage tenantId={s.tenant_id!} />}
          {view === "changes" && <ITSMPage tenantId={s.tenant_id!} />}
          {view === "sla" && <SLAPage tenantId={s.tenant_id!} />}
          {view === "automation" && <AutomationPage tenantId={s.tenant_id!} />}
          {view === "reports" && <ReportsPage tenantId={s.tenant_id!} />}
          {view === "alertmanager" && <AlertmanagerPage tenantId={s.tenant_id!} />}
          {view === "infra" && <InfraPage tenantId={s.tenant_id!} />}
          {view === "kb" && <KnowledgeBasePage tenantId={s.tenant_id!} />}
          {view === "incidents" && <IncidentResponsePage tenantId={s.tenant_id!} />}
          {view === "msp" && <MSPOverviewPage tenantId={s.tenant_id!} />}
          {view === "users" && <UsersAdminPage tenantId={s.tenant_id!} />}
        </main>
      </div>
    </div>
  );
}
