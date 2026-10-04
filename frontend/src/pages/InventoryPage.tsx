import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { DeviceDetail } from "./DeviceDetail";

interface Source {
  monitoring_source_id: string;
  display_name: string;
  operational_evidence_state: string;
}

interface Resource {
  monitoring_resource_id: string;
  display_name?: string;
  resource_kind?: string;
  scope_evidence_state?: string;
  presence_evidence_state?: string;
  presence_state?: string;
  last_observed_at?: string;
}

function healthVariant(r: Resource): "success" | "warning" | "danger" | "muted" {
  if (r.presence_state === "removed") return "muted";
  const ok = r.scope_evidence_state === "current" && r.presence_evidence_state === "current";
  if (ok) return "success";
  if (r.scope_evidence_state || r.presence_evidence_state) return "warning";
  return "muted";
}

function healthLabel(r: Resource): string {
  if (r.presence_state === "removed") return "removed";
  if (r.scope_evidence_state === "current" && r.presence_evidence_state === "current") return "healthy";
  return r.scope_evidence_state ?? r.presence_evidence_state ?? "unknown";
}

function fmtTs(iso?: string) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

export function InventoryPage({ tenantId }: { tenantId: string }) {
  const [search, setSearch] = useState("");
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [selectedResource, setSelectedResource] = useState<{ sourceId: string; resourceId: string } | null>(null);

  const sourcesQ = useQuery({
    queryKey: ["sources", tenantId],
    queryFn: () => api.get<Source[]>(`/api/v1/monitoring/sources`),
  });

  const sources = sourcesQ.data ?? [];
  const activeSource = selectedSource ?? sources[0]?.monitoring_source_id ?? null;

  const resourcesQ = useQuery({
    queryKey: ["resources", tenantId, activeSource],
    queryFn: () =>
      api.get<{ items: Resource[]; generation_state?: string; next_cursor?: string }>(
        `/api/v1/monitoring/sources/${activeSource}/resources?limit=200`,
      ),
    enabled: activeSource !== null,
    refetchInterval: 60_000,
  });

  const resources = (resourcesQ.data?.items ?? []).filter(
    (r) =>
      !search ||
      (r.display_name ?? "").toLowerCase().includes(search.toLowerCase()) ||
      (r.resource_kind ?? "").toLowerCase().includes(search.toLowerCase()),
  );

  const counts = {
    healthy: resources.filter((r) => healthVariant(r) === "success").length,
    degraded: resources.filter((r) => healthVariant(r) === "warning").length,
    unhealthy: resources.filter((r) => healthVariant(r) === "danger").length,
  };

  if (selectedResource) {
    return (
      <DeviceDetail
        tenantId={tenantId}
        sourceId={selectedResource.sourceId}
        resourceId={selectedResource.resourceId}
        onBack={() => setSelectedResource(null)}
      />
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h2 className="text-base font-semibold">Resource Inventory</h2>
        <div className="flex items-center gap-3">
          <div className="flex gap-2 text-xs">
            <span className="text-[var(--green)]">{counts.healthy} healthy</span>
            <span className="text-[var(--yellow)]">{counts.degraded} degraded</span>
            <span className="text-[var(--red)]">{counts.unhealthy} unhealthy</span>
          </div>
          {resourcesQ.isFetching && <Spinner className="w-3 h-3" />}
        </div>
      </div>

      <div className="flex flex-wrap gap-2 items-center">
        {sourcesQ.isLoading ? (
          <Spinner className="w-3 h-3" />
        ) : (
          sources.map((s) => (
            <button
              key={s.monitoring_source_id}
              onClick={() => setSelectedSource(s.monitoring_source_id)}
              className={[
                "px-3 py-1 rounded-full text-xs cursor-pointer border transition-colors",
                activeSource === s.monitoring_source_id
                  ? "border-[var(--brand)] text-[var(--brand)] bg-[var(--surface-2)]"
                  : "border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--text-muted)]",
              ].join(" ")}
            >
              {s.display_name}
            </button>
          ))
        )}

        <input
          type="search"
          placeholder="Filter by name or kind…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="ml-auto px-3 py-1.5 text-xs rounded-md w-48
            bg-[var(--surface-2)] border border-[var(--border)]
            text-[var(--text)] placeholder:text-[var(--text-muted)]
            focus:outline-none focus:border-[var(--brand)]"
        />
      </div>

      {!activeSource ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] py-2">No monitoring sources configured.</p>
        </Card>
      ) : resourcesQ.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : resourcesQ.isError ? (
        <p className="text-xs text-[var(--red)]">Failed to load inventory.</p>
      ) : resources.length === 0 ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] py-2">
            {search ? "No resources match your filter." : "No resources found."}
          </p>
        </Card>
      ) : (
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-2)]">
              <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                <th className="px-4 py-2.5 font-medium">Name</th>
                <th className="px-4 py-2.5 font-medium">Kind</th>
                <th className="px-4 py-2.5 font-medium">Health</th>
                <th className="px-4 py-2.5 font-medium">Last seen</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {resources.map((r) => (
                <tr
                  key={r.monitoring_resource_id}
                  className="hover:bg-[var(--surface-2)] transition-colors cursor-pointer"
                  onClick={() => activeSource && setSelectedResource({ sourceId: activeSource, resourceId: r.monitoring_resource_id })}
                >
                  <td className="px-4 py-2.5 text-[var(--brand)] font-medium max-w-xs truncate underline-offset-2 hover:underline">
                    {r.display_name ?? r.monitoring_resource_id}
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)]">
                    {r.resource_kind ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <Badge variant={healthVariant(r)}>
                      {healthLabel(r)}
                    </Badge>
                  </td>
                  <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                    {fmtTs(r.last_observed_at)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}
