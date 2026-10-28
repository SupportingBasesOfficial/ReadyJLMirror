import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { useTranslation } from "react-i18next";
import { ToggleLeft, ToggleRight, RefreshCw, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";

interface FeatureFlag {
  flag_id: string;
  flag_key: string;
  enabled: boolean;
  description: string | null;
  updated_at: string;
  updated_by: string | null;
}

interface FeatureFlagsPageProps {
  tenantId: string;
}

export function FeatureFlagsPage({ tenantId }: FeatureFlagsPageProps) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data: flags, isLoading, isError } = useQuery<FeatureFlag[]>({
    queryKey: ["feature-flags", tenantId],
    queryFn: () => api.get<FeatureFlag[]>("/api/v1/feature-flags"),
  });

  const toggleMutation = useMutation({
    mutationFn: ({ flag_key, enabled }: { flag_key: string; enabled: boolean }) =>
      api.put<FeatureFlag>(`/api/v1/feature-flags/${flag_key}`, { enabled }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["feature-flags", tenantId] });
      toast({ title: t("featureFlags.updated") });
    },
    onError: () => {
      toast({ title: t("featureFlags.updateError"), variant: "destructive" });
    },
  });

  const resetMutation = useMutation({
    mutationFn: () => api.post<{ inserted: number; tenant_id: string }>("/api/v1/feature-flags/reset"),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["feature-flags", tenantId] });
      toast({ title: t("featureFlags.resetDone", { count: res.inserted }) });
    },
    onError: () => {
      toast({ title: t("featureFlags.resetError"), variant: "destructive" });
    },
  });

  const betaFlags = ["module_chatops", "module_push", "module_client_portal"];

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48 text-muted-foreground">
        {t("common.loading")}
      </div>
    );
  }

  if (isError) {
    return (
      <div className="flex items-center gap-2 text-destructive p-4">
        <AlertCircle className="h-4 w-4" />
        {t("featureFlags.loadError")}
      </div>
    );
  }

  const stableFlags = flags?.filter((f) => !betaFlags.includes(f.flag_key)) ?? [];
  const betaList = flags?.filter((f) => betaFlags.includes(f.flag_key)) ?? [];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t("featureFlags.title")}</h1>
          <p className="text-muted-foreground text-sm mt-1">{t("featureFlags.subtitle")}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => resetMutation.mutate()}
          disabled={resetMutation.isPending}
        >
          <RefreshCw className="h-4 w-4 mr-2" />
          {t("featureFlags.reset")}
        </Button>
      </div>

      <FlagSection
        title={t("featureFlags.modules")}
        flags={stableFlags}
        onToggle={(flag_key, enabled) => toggleMutation.mutate({ flag_key, enabled })}
        pending={toggleMutation.isPending}
      />

      <FlagSection
        title={t("featureFlags.beta")}
        flags={betaList}
        onToggle={(flag_key, enabled) => toggleMutation.mutate({ flag_key, enabled })}
        pending={toggleMutation.isPending}
        isBeta
      />
    </div>
  );
}

function FlagSection({
  title,
  flags,
  onToggle,
  pending,
  isBeta,
}: {
  title: string;
  flags: FeatureFlag[];
  onToggle: (key: string, enabled: boolean) => void;
  pending: boolean;
  isBeta?: boolean;
}) {
  const { t } = useTranslation();

  if (flags.length === 0) return null;

  return (
    <div className="rounded-lg border">
      <div className="px-4 py-3 border-b bg-muted/30">
        <h2 className="font-semibold text-sm">
          {title}
          {isBeta && (
            <span className="ml-2 text-xs bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400 rounded px-1.5 py-0.5">
              beta
            </span>
          )}
        </h2>
      </div>
      <div className="divide-y">
        {flags.map((flag) => (
          <div
            key={flag.flag_id}
            className="flex items-center justify-between px-4 py-3 hover:bg-muted/20 transition-colors"
          >
            <div className="flex-1 min-w-0">
              <p className="font-medium text-sm">{t(`featureFlags.keys.${flag.flag_key}`, flag.flag_key)}</p>
              {flag.description && (
                <p className="text-xs text-muted-foreground mt-0.5">{flag.description}</p>
              )}
            </div>
            <button
              onClick={() => onToggle(flag.flag_key, !flag.enabled)}
              disabled={pending}
              className="ml-4 flex-shrink-0 focus:outline-none disabled:opacity-50"
              title={flag.enabled ? t("featureFlags.disable") : t("featureFlags.enable")}
            >
              {flag.enabled ? (
                <ToggleRight className="h-8 w-8 text-green-500" />
              ) : (
                <ToggleLeft className="h-8 w-8 text-muted-foreground" />
              )}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
