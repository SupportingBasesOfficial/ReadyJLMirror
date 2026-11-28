/**
 * PlatformAdminShell — workspace exclusivo para platform admins (JL Informática).
 *
 * Bifurcação em App.tsx: quando session.is_platform_admin === true, este shell
 * substitui completamente o Shell de tenant. Nenhum código de tenant é carregado.
 */

import { useState, useEffect } from "react";
import { useSession } from "@/hooks/useSession";
import { FullPageSpinner } from "@/components/ui/spinner";
import { api, logout } from "@/api/client";
import {
  Building2, Server, GitMerge, Users, Package, FileText,
  Activity, Tv2, Network, ClipboardList, BarChart3, CreditCard,
  ShoppingBag, LogOut, ChevronLeft, ChevronRight, Plus, ShieldAlert,
} from "lucide-react";
import { PlatformAdminPage, type PlatformAdminTab } from "@/pages/PlatformAdminPage";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

// ── Nav items ────────────────────────────────────────────────────────────────

interface NavItem {
  id: PlatformAdminTab;
  label: string;
  icon: React.ReactNode;
  group: string;
}

const NAV_ITEMS: NavItem[] = [
  { id: "orgs",          label: "Organizações",   icon: <Building2 size={15} />,    group: "Estrutura" },
  { id: "tenants",       label: "Tenants",        icon: <Server size={15} />,       group: "Estrutura" },
  { id: "relationships", label: "Relacionamentos",icon: <GitMerge size={15} />,     group: "Estrutura" },
  { id: "users",         label: "Usuários",       icon: <Users size={15} />,        group: "Estrutura" },
  { id: "plans",         label: "Planos",         icon: <Package size={15} />,      group: "Comercial" },
  { id: "contracts",     label: "Contratos",      icon: <FileText size={15} />,     group: "Comercial" },
  { id: "billing",       label: "Billing",        icon: <CreditCard size={15} />,   group: "Comercial" },
  { id: "marketplace",   label: "Marketplace",    icon: <ShoppingBag size={15} />,  group: "Plataforma" },
  { id: "health",        label: "Health",         icon: <Activity size={15} />,     group: "Plataforma" },
  { id: "quota-health",  label: "Quota Health",   icon: <BarChart3 size={15} />,    group: "Plataforma" },
  { id: "audit",         label: "Audit Log",      icon: <ClipboardList size={15} />,group: "Plataforma" },
  { id: "teia",          label: "Teia",           icon: <Network size={15} />,      group: "Visualização" },
  { id: "tv",            label: "TV Mode",        icon: <Tv2 size={15} />,          group: "Visualização" },
];

const GROUPS = ["Estrutura", "Comercial", "Plataforma", "Visualização"];

// ── Shell ────────────────────────────────────────────────────────────────────

const COLLAPSED_KEY = "jlm_admin_sidebar_collapsed";

export function PlatformAdminShell() {
  const { t } = useTranslation();
  const { data: session, isLoading } = useSession();
  const qc = useQueryClient();

  const [activeTab, setActiveTab] = useState<PlatformAdminTab>("orgs");
  const [mspWizardOpen, setMspWizardOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try { return localStorage.getItem(COLLAPSED_KEY) === "1"; }
    catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0"); }
    catch { /* ignore */ }
  }, [collapsed]);

  const mutLogout = useMutation({
    mutationFn: logout,
    onSuccess: () => { qc.clear(); window.location.href = "/auth/login"; },
  });

  if (isLoading) return <FullPageSpinner />;

  // Segurança: se não for platform admin, não renderiza nada (App.tsx já bifurca,
  // mas esta guarda é uma camada extra de defesa)
  if (!session?.is_platform_admin) return null;

  const currentItem = NAV_ITEMS.find((i) => i.id === activeTab);

  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg)]">
      {/* ── Sidebar ── */}
      <aside
        className="flex flex-col border-r border-[var(--border)] transition-all duration-200 flex-shrink-0"
        style={{
          width: collapsed ? 52 : 220,
          background: "var(--surface)",
        }}
      >
        {/* Logo / badge */}
        <div
          className="flex items-center gap-2.5 px-3 py-3.5 border-b border-[var(--border)]"
          style={{ minHeight: 52 }}
        >
          <div
            className="flex-shrink-0 w-7 h-7 rounded-md flex items-center justify-center text-white text-xs font-bold"
            style={{ background: "var(--brand, #0f766e)" }}
          >
            JL
          </div>
          {!collapsed && (
            <div className="overflow-hidden">
              <div className="text-[11px] font-semibold text-[var(--text)] truncate leading-tight">
                Argos
              </div>
              <div
                className="text-[9px] font-bold uppercase tracking-widest px-1 rounded"
                style={{ color: "#ef4444", background: "#fef2f2" }}
              >
                Platform Admin
              </div>
            </div>
          )}
        </div>

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-2">
          {GROUPS.map((group) => {
            const items = NAV_ITEMS.filter((i) => i.group === group);
            return (
              <div key={group} className="mb-1">
                {!collapsed && (
                  <div
                    className="px-3 py-1 text-[9px] font-bold uppercase tracking-widest"
                    style={{ color: "var(--text-dim)" }}
                  >
                    {group}
                  </div>
                )}
                {items.map((item) => {
                  const active = item.id === activeTab;
                  return (
                    <button
                      key={item.id}
                      onClick={() => setActiveTab(item.id)}
                      title={collapsed ? item.label : undefined}
                      className={[
                        "w-full flex items-center gap-2.5 px-3 py-2 text-xs transition-colors cursor-pointer rounded-none",
                        active
                          ? "bg-[color-mix(in_srgb,var(--brand)_12%,transparent)] text-[var(--brand)] font-medium"
                          : "text-[var(--text-muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)]",
                      ].join(" ")}
                    >
                      <span className="flex-shrink-0">{item.icon}</span>
                      {!collapsed && <span className="truncate">{item.label}</span>}
                    </button>
                  );
                })}
              </div>
            );
          })}
        </nav>

        {/* Footer: collapse toggle + logout */}
        <div className="border-t border-[var(--border)] p-2 space-y-1">
          <button
            onClick={() => mutLogout.mutate()}
            title="Sair"
            className="w-full flex items-center gap-2.5 px-2 py-1.5 text-xs text-[var(--text-muted)] hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/20 rounded transition-colors cursor-pointer"
          >
            <LogOut size={14} />
            {!collapsed && <span>Sair</span>}
          </button>
          <button
            onClick={() => setCollapsed((c) => !c)}
            className="w-full flex items-center justify-center py-1.5 text-[var(--text-muted)] hover:text-[var(--text)] transition-colors cursor-pointer rounded"
          >
            {collapsed ? <ChevronRight size={14} /> : <ChevronLeft size={14} />}
          </button>
        </div>
      </aside>

      {/* ── Main area ── */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Top bar */}
        <header
          className="flex items-center justify-between gap-4 px-6 border-b border-[var(--border)] flex-shrink-0"
          style={{ height: 52, background: "var(--surface)" }}
        >
          <div className="flex items-center gap-2">
            <span className="flex-shrink-0 text-[var(--text-muted)]">{currentItem?.icon}</span>
            <h1 className="text-sm font-semibold text-[var(--text)]">
              {currentItem?.label ?? "Platform Admin"}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <span
              className="flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider px-2 py-0.5 rounded"
              style={{ color: "#ef4444", background: "#fef2f2", border: "1px solid #fecaca" }}
            >
              <ShieldAlert size={11} /> Platform Admin
            </span>
            {activeTab === "orgs" && (
              <button
                onClick={() => setMspWizardOpen(true)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-white rounded-md transition-colors"
                style={{ background: "var(--brand, #0f766e)" }}
              >
                <Plus size={12} /> {t("platformAdmin.newMspClient", "Novo MSP / Cliente")}
              </button>
            )}
          </div>
        </header>

        {/* Content */}
        <main className="flex-1 overflow-y-auto">
          <PlatformAdminPage
            tenantId={session.tenant_id ?? ""}
            activeTab={activeTab}
            mspWizardOpen={mspWizardOpen}
            onOpenMSPWizard={setMspWizardOpen}
          />
        </main>
      </div>
    </div>
  );
}
