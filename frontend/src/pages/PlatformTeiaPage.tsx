import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Spinner } from "@/components/ui/spinner";
import {
  Users,
  Server,
  ChevronDown,
  ChevronRight,
  Building2,
  Shield,
} from "lucide-react";

interface TeiaM {
  principal_id: string;
  role: string;
  display_name: string;
  email: string;
}

interface TeiaTenant {
  tenant_id: string;
  display_name: string;
  state: string;
  organization_id: string | null;
  member_count: number;
  source_count: number;
  members: TeiaM[];
}

const ROLE_COLOR: Record<string, string> = {
  admin: "bg-red-500/15 text-red-400 border-red-500/30",
  operator: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  viewer: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  auditor: "bg-purple-500/15 text-purple-400 border-purple-500/30",
};

function stateDot(state: string) {
  return state === "active" ? "bg-emerald-400" : "bg-amber-400";
}

export function PlatformTeiaPage() {
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const { data, isLoading, isError } = useQuery<TeiaTenant[]>({
    queryKey: ["platform", "teia"],
    queryFn: () =>
      api.get<TeiaTenant[]>("/api/v1/platform/teia"),
    staleTime: 30_000,
  });

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Spinner />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="p-6 text-sm text-red-400">
        Erro ao carregar mapa relacional.
      </div>
    );
  }

  const total = data.length;
  const totalMembers = data.reduce((s, t) => s + t.member_count, 0);
  const totalSources = data.reduce((s, t) => s + t.source_count, 0);

  return (
    <div className="p-4 md:p-6 space-y-4 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-2">
        <Shield className="w-5 h-5 text-purple-400 flex-shrink-0" />
        <h2 className="text-base font-semibold" style={{ color: "var(--fg)" }}>
          Teia — Visão Global
        </h2>
        <span className="text-xs px-2 py-0.5 rounded-full border"
          style={{ color: "var(--fg-muted)", borderColor: "var(--border)" }}>
          Platform Admin
        </span>
      </div>

      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: "Tenants", value: total, icon: Building2, color: "text-indigo-400" },
          { label: "Membros", value: totalMembers, icon: Users, color: "text-emerald-400" },
          { label: "Fontes", value: totalSources, icon: Server, color: "text-sky-400" },
        ].map(({ label, value, icon: Icon, color }) => (
          <div
            key={label}
            className="rounded-lg p-3 flex flex-col gap-1"
            style={{ background: "var(--surface-2)", border: "1px solid var(--border)" }}
          >
            <div className={`flex items-center gap-1.5 text-xs ${color}`}>
              <Icon className="w-3.5 h-3.5" />
              {label}
            </div>
            <span className="text-xl font-semibold tabular-nums" style={{ color: "var(--fg)" }}>
              {value}
            </span>
          </div>
        ))}
      </div>

      {/* Tenant list */}
      <div className="space-y-2">
        {data.map((tenant) => {
          const open = expanded.has(tenant.tenant_id);
          return (
            <div
              key={tenant.tenant_id}
              className="rounded-lg overflow-hidden"
              style={{ border: "1px solid var(--border)", background: "var(--surface-1)" }}
            >
              {/* Tenant header row */}
              <button
                className="w-full flex items-center gap-3 px-4 py-3 text-left hover:brightness-110 transition-all"
                onClick={() => toggle(tenant.tenant_id)}
                style={{ background: "transparent" }}
              >
                {open ? (
                  <ChevronDown className="w-4 h-4 flex-shrink-0" style={{ color: "var(--fg-muted)" }} />
                ) : (
                  <ChevronRight className="w-4 h-4 flex-shrink-0" style={{ color: "var(--fg-muted)" }} />
                )}
                <span
                  className={`w-2 h-2 rounded-full flex-shrink-0 ${stateDot(tenant.state)}`}
                />
                <span className="font-medium text-sm flex-1 text-left truncate" style={{ color: "var(--fg)" }}>
                  {tenant.display_name}
                </span>
                <span className="text-xs" style={{ color: "var(--fg-muted)" }}>
                  {tenant.tenant_id}
                </span>
                <span className="flex items-center gap-1 text-xs ml-3" style={{ color: "var(--fg-muted)" }}>
                  <Users className="w-3 h-3" />
                  {tenant.member_count}
                </span>
                <span className="flex items-center gap-1 text-xs ml-2" style={{ color: "var(--fg-muted)" }}>
                  <Server className="w-3 h-3" />
                  {tenant.source_count}
                </span>
              </button>

              {/* Expanded detail */}
              {open && (
                <div
                  className="px-4 pb-4 pt-1 grid grid-cols-1 md:grid-cols-2 gap-4"
                  style={{ borderTop: "1px solid var(--border)" }}
                >
                  {/* Members */}
                  <div>
                    <p className="text-xs font-medium mb-2" style={{ color: "var(--fg-muted)" }}>
                      Membros ({tenant.members.length})
                    </p>
                    {tenant.members.length === 0 ? (
                      <p className="text-xs" style={{ color: "var(--fg-muted)" }}>Sem membros ativos</p>
                    ) : (
                      <div className="space-y-1.5">
                        {tenant.members.map((m) => (
                          <div key={m.principal_id} className="flex items-center gap-2">
                            <span className="text-xs truncate flex-1" style={{ color: "var(--fg)" }}>
                              {m.display_name || m.email || m.principal_id}
                            </span>
                            <span
                              className={`text-[10px] px-1.5 py-0.5 rounded border ${ROLE_COLOR[m.role] ?? "bg-slate-500/15 text-slate-400 border-slate-500/30"}`}
                            >
                              {m.role}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Metadata */}
                  <div>
                    <p className="text-xs font-medium mb-2" style={{ color: "var(--fg-muted)" }}>
                      Detalhes
                    </p>
                    <div className="space-y-1">
                      {[
                        { label: "Estado", value: tenant.state },
                        { label: "Organização", value: tenant.organization_id ?? "—" },
                        { label: "Fontes de monitoramento", value: String(tenant.source_count) },
                      ].map(({ label, value }) => (
                        <div key={label} className="flex gap-2 text-xs">
                          <span style={{ color: "var(--fg-muted)", minWidth: "7rem" }}>{label}</span>
                          <span style={{ color: "var(--fg)" }}>{value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          );
        })}

        {data.length === 0 && (
          <p className="text-sm text-center py-8" style={{ color: "var(--fg-muted)" }}>
            Nenhum tenant encontrado.
          </p>
        )}
      </div>
    </div>
  );
}
