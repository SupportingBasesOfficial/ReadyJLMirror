import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiFetch } from "@/api/client";
import { useTranslation } from "react-i18next";
import {
  ShoppingBag, Package, CheckCircle2, XCircle, AlertCircle,
  ExternalLink, Plus, Trash2, Settings, RefreshCw,
} from "lucide-react";

interface Integration {
  integration_id: string;
  name: string;
  description: string;
  category: string;
  icon_emoji: string;
  vendor: string;
  website_url: string | null;
  is_enabled: boolean;
  created_at: string;
}

interface TenantIntegration {
  id: number;
  integration_id: string;
  name: string;
  category: string;
  icon_emoji: string;
  vendor: string;
  config: Record<string, unknown>;
  state: "active" | "inactive" | "error";
  error_detail: string | null;
  installed_by: string;
  installed_at: string;
  updated_at: string;
}

interface Stats {
  catalog_total: number;
  installed: number;
  active: number;
  inactive: number;
  error: number;
}

type Tab = "catalog" | "installed";

const CATEGORY_LABELS: Record<string, string> = {
  monitoring: "Monitoramento",
  alerting: "Alertas",
  itsm: "ITSM",
  chatops: "ChatOps",
  security: "Segurança",
  automation: "Automação",
  storage: "Armazenamento",
  other: "Outros",
};

const CATEGORY_COLORS: Record<string, string> = {
  monitoring: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  alerting: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
  itsm: "bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300",
  chatops: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
  security: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  automation: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300",
  storage: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  other: "bg-gray-100 text-gray-800 dark:bg-gray-700 dark:text-gray-300",
};

function StatCard({ label, value, icon: Icon, color }: {
  label: string; value: number; icon: React.ElementType; color: string;
}) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700 flex items-center gap-3">
      <div className={`p-2 rounded-lg ${color}`}><Icon size={18} /></div>
      <div>
        <div className="text-2xl font-bold text-gray-900 dark:text-white">{value}</div>
        <div className="text-xs text-gray-500 dark:text-gray-400">{label}</div>
      </div>
    </div>
  );
}

export function MarketplacePage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("catalog");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [installingId, setInstallingId] = useState<string | null>(null);

  const qStats = useQuery<Stats>({
    queryKey: ["marketplace-stats", tenantId],
    queryFn: () => apiFetch("/api/v1/marketplace/stats"),
    refetchInterval: 30_000,
  });

  const qCatalog = useQuery<Integration[]>({
    queryKey: ["marketplace-catalog", tenantId],
    queryFn: () => apiFetch("/api/v1/marketplace"),
  });

  const qInstalled = useQuery<TenantIntegration[]>({
    queryKey: ["marketplace-installed", tenantId],
    queryFn: () => apiFetch("/api/v1/marketplace/installed"),
  });

  const installedIds = new Set((qInstalled.data ?? []).map((i) => i.integration_id));

  const mutInstall = useMutation({
    mutationFn: (integrationId: string) =>
      apiFetch(`/api/v1/marketplace/${integrationId}/install`, { method: "POST", body: { config: {} } }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketplace-installed", tenantId] });
      qc.invalidateQueries({ queryKey: ["marketplace-stats", tenantId] });
      setInstallingId(null);
    },
    onError: () => setInstallingId(null),
  });

  const mutUninstall = useMutation({
    mutationFn: (integrationId: string) =>
      apiFetch(`/api/v1/marketplace/${integrationId}/install`, { method: "DELETE" }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketplace-installed", tenantId] });
      qc.invalidateQueries({ queryKey: ["marketplace-stats", tenantId] });
    },
  });

  const mutToggle = useMutation({
    mutationFn: ({ integrationId, state }: { integrationId: string; state: string }) =>
      apiFetch(`/api/v1/marketplace/${integrationId}/install`, {
        method: "PATCH",
        body: { state },
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["marketplace-installed", tenantId] });
      qc.invalidateQueries({ queryKey: ["marketplace-stats", tenantId] });
    },
  });

  const stats = qStats.data;
  const catalog = (qCatalog.data ?? []).filter(
    (i) => categoryFilter === "all" || i.category === categoryFilter,
  );
  const categories = ["all", ...Array.from(new Set((qCatalog.data ?? []).map((i) => i.category))).sort()];

  const stateIcon = (state: string) => {
    if (state === "active") return <CheckCircle2 size={14} className="text-green-500" />;
    if (state === "error") return <AlertCircle size={14} className="text-red-500" />;
    return <XCircle size={14} className="text-gray-400" />;
  };

  return (
    <div className="p-4 md:p-6 space-y-4">
      {/* Header */}
      <div className="flex items-center gap-2">
        <ShoppingBag size={22} className="text-teal-600 dark:text-teal-400" />
        <h1 className="text-xl font-semibold text-gray-900 dark:text-white">
          {t("nav.marketplace", "Marketplace de Integrações")}
        </h1>
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard label="No catálogo" value={stats.catalog_total} icon={Package}
            color="bg-teal-100 text-teal-700 dark:bg-teal-900/40 dark:text-teal-300" />
          <StatCard label="Instaladas" value={stats.installed} icon={CheckCircle2}
            color="bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300" />
          <StatCard label="Ativas" value={stats.active} icon={CheckCircle2}
            color="bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-300" />
          <StatCard label="Inativas" value={stats.inactive} icon={XCircle}
            color="bg-gray-100 text-gray-700 dark:bg-gray-700 dark:text-gray-300" />
          <StatCard label="Com erro" value={stats.error} icon={AlertCircle}
            color="bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-300" />
        </div>
      )}

      {/* Tabs */}
      <div className="flex gap-1 border-b border-gray-200 dark:border-gray-700">
        {(["catalog", "installed"] as Tab[]).map((t_) => (
          <button
            key={t_}
            onClick={() => setTab(t_)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              tab === t_
                ? "border-teal-600 text-teal-700 dark:text-teal-400"
                : "border-transparent text-gray-500 hover:text-gray-700 dark:text-gray-400"
            }`}
          >
            {t_ === "catalog" ? "Catálogo" : `Instaladas (${stats?.installed ?? 0})`}
          </button>
        ))}
      </div>

      {/* Catalog tab */}
      {tab === "catalog" && (
        <div className="space-y-4">
          {/* Category filter */}
          <div className="flex flex-wrap gap-2">
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => setCategoryFilter(cat)}
                className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                  categoryFilter === cat
                    ? "bg-teal-600 text-white"
                    : "bg-gray-100 text-gray-600 hover:bg-gray-200 dark:bg-gray-700 dark:text-gray-300"
                }`}
              >
                {cat === "all" ? "Todas" : (CATEGORY_LABELS[cat] ?? cat)}
              </button>
            ))}
          </div>

          {qCatalog.isLoading && (
            <div className="text-sm text-gray-500 dark:text-gray-400">Carregando catálogo…</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {catalog.map((integration) => {
              const isInstalled = installedIds.has(integration.integration_id);
              const isLoading = installingId === integration.integration_id && mutInstall.isPending;
              return (
                <div
                  key={integration.integration_id}
                  className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4 flex flex-col gap-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-2xl">{integration.icon_emoji}</span>
                      <div>
                        <div className="font-medium text-gray-900 dark:text-white text-sm">
                          {integration.name}
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400">
                          {integration.vendor}
                        </div>
                      </div>
                    </div>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${CATEGORY_COLORS[integration.category] ?? CATEGORY_COLORS.other}`}>
                      {CATEGORY_LABELS[integration.category] ?? integration.category}
                    </span>
                  </div>

                  <p className="text-xs text-gray-600 dark:text-gray-400 leading-relaxed flex-1">
                    {integration.description}
                  </p>

                  <div className="flex items-center gap-2">
                    {integration.website_url && (
                      <a
                        href={integration.website_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-xs text-teal-600 dark:text-teal-400 flex items-center gap-1 hover:underline"
                      >
                        <ExternalLink size={11} /> Site
                      </a>
                    )}
                    <div className="flex-1" />
                    {isInstalled ? (
                      <span className="flex items-center gap-1 text-xs text-green-600 dark:text-green-400">
                        <CheckCircle2 size={13} /> Instalada
                      </span>
                    ) : (
                      <button
                        onClick={() => {
                          setInstallingId(integration.integration_id);
                          mutInstall.mutate(integration.integration_id);
                        }}
                        disabled={isLoading}
                        className="flex items-center gap-1 px-3 py-1 text-xs bg-teal-600 hover:bg-teal-700 text-white rounded-md disabled:opacity-50"
                      >
                        {isLoading ? <RefreshCw size={12} className="animate-spin" /> : <Plus size={12} />}
                        Instalar
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Installed tab */}
      {tab === "installed" && (
        <div className="space-y-3">
          {qInstalled.isLoading && (
            <div className="text-sm text-gray-500 dark:text-gray-400">Carregando instalações…</div>
          )}

          {(qInstalled.data ?? []).length === 0 && !qInstalled.isLoading && (
            <div className="text-center py-12 text-gray-500 dark:text-gray-400">
              <ShoppingBag size={40} className="mx-auto mb-3 opacity-30" />
              <p className="text-sm">Nenhuma integração instalada.</p>
              <p className="text-xs mt-1">Acesse o catálogo para instalar.</p>
            </div>
          )}

          {(qInstalled.data ?? []).map((inst) => (
            <div
              key={inst.id}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4"
            >
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3">
                  <span className="text-xl">{inst.icon_emoji}</span>
                  <div>
                    <div className="font-medium text-gray-900 dark:text-white text-sm flex items-center gap-1.5">
                      {inst.name}
                      {stateIcon(inst.state)}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400">
                      {CATEGORY_LABELS[inst.category] ?? inst.category} · Instalada {new Date(inst.installed_at).toLocaleDateString("pt-BR")}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    onClick={() =>
                      mutToggle.mutate({
                        integrationId: inst.integration_id,
                        state: inst.state === "active" ? "inactive" : "active",
                      })
                    }
                    className={`flex items-center gap-1 px-2.5 py-1 text-xs rounded-md border transition-colors ${
                      inst.state === "active"
                        ? "border-gray-300 text-gray-600 hover:border-red-300 hover:text-red-600 dark:border-gray-600 dark:text-gray-400"
                        : "border-green-300 text-green-600 hover:bg-green-50 dark:border-green-700 dark:text-green-400"
                    }`}
                  >
                    <Settings size={11} />
                    {inst.state === "active" ? "Desativar" : "Ativar"}
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Desinstalar ${inst.name}?`)) {
                        mutUninstall.mutate(inst.integration_id);
                      }
                    }}
                    className="flex items-center gap-1 px-2.5 py-1 text-xs text-red-600 border border-red-200 rounded-md hover:bg-red-50 dark:border-red-800 dark:text-red-400"
                  >
                    <Trash2 size={11} /> Remover
                  </button>
                </div>
              </div>
              {inst.error_detail && (
                <div className="mt-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-900/20 rounded p-2">
                  Erro: {inst.error_detail}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
