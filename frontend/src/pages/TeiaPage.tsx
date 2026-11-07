import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Spinner } from "@/components/ui/spinner";
import { Users, Activity, Server, ChevronDown, ChevronRight, Building2 } from "lucide-react";

interface Member {
  membership_id: string;
  principal_id: string;
  role: string;
  state: string;
  display_name: string;
  email: string;
}

interface MonitoringSource {
  source_id: string;
  display_name: string;
  provider: string;
  state: string;
  host_count?: number;
}

interface Resource {
  resource_id: string;
  display_name: string;
  health_state: string;
  resource_type?: string;
}

interface SourceResources {
  [source_id: string]: Resource[];
}

const ROLE_COLOR: Record<string, string> = {
  admin: "bg-red-500/15 text-red-400 border-red-500/30",
  operator: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  viewer: "bg-blue-500/15 text-blue-400 border-blue-500/30",
  auditor: "bg-purple-500/15 text-purple-400 border-purple-500/30",
};

const HEALTH_COLOR: Record<string, string> = {
  healthy: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  degraded: "bg-amber-500/15 text-amber-400 border-amber-500/30",
  unhealthy: "bg-red-500/15 text-red-400 border-red-500/30",
  unknown: "bg-slate-500/15 text-slate-400 border-slate-500/30",
};

const SOURCE_STATE_COLOR: Record<string, string> = {
  active: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  error: "bg-red-500/15 text-red-400 border-red-500/30",
  inactive: "bg-slate-500/15 text-slate-400 border-slate-500/30",
  syncing: "bg-blue-500/15 text-blue-400 border-blue-500/30",
};

function healthDot(state: string) {
  const colors: Record<string, string> = {
    healthy: "bg-emerald-400",
    degraded: "bg-amber-400",
    unhealthy: "bg-red-400",
    unknown: "bg-slate-400",
    active: "bg-emerald-400",
    error: "bg-red-400",
    inactive: "bg-slate-400",
    syncing: "bg-blue-400",
  };
  return <span className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${colors[state] ?? "bg-slate-400"}`} />;
}

interface SVGLine {
  x1: number; y1: number;
  x2: number; y2: number;
  key: string;
  dim?: boolean;
}

export function TeiaPage({ tenantId }: { tenantId: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const tenantNodeRef = useRef<HTMLDivElement>(null);
  const memberRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const sourceRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [lines, setLines] = useState<SVGLine[]>([]);
  const [expandedSources, setExpandedSources] = useState<Set<string>>(new Set());
  const [sourceResources, setSourceResources] = useState<SourceResources>({});
  const [loadingResources, setLoadingResources] = useState<Set<string>>(new Set());

  const { data: members, isLoading: membersLoading } = useQuery({
    queryKey: ["teia-members", tenantId],
    queryFn: () => api.get<Member[]>(`/api/v1/tenant/members`),
  });

  const { data: sources, isLoading: sourcesLoading } = useQuery({
    queryKey: ["teia-sources", tenantId],
    queryFn: () => api.get<MonitoringSource[]>(`/api/v1/monitoring/sources`),
  });

  const computeLines = useCallback(() => {
    const container = containerRef.current;
    const tenantNode = tenantNodeRef.current;
    if (!container || !tenantNode) return;

    const containerRect = container.getBoundingClientRect();
    const tenantRect = tenantNode.getBoundingClientRect();
    const cx = tenantRect.left - containerRect.left + tenantRect.width / 2;
    const cy = tenantRect.top - containerRect.top + tenantRect.height / 2;

    const newLines: SVGLine[] = [];

    Object.entries(memberRefs.current).forEach(([id, el]) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const ex = r.left - containerRect.left + r.width;
      const ey = r.top - containerRect.top + r.height / 2;
      newLines.push({ x1: ex, y1: ey, x2: cx, y2: cy, key: `m-${id}` });
    });

    Object.entries(sourceRefs.current).forEach(([id, el]) => {
      if (!el) return;
      const r = el.getBoundingClientRect();
      const ex = r.left - containerRect.left;
      const ey = r.top - containerRect.top + r.height / 2;
      newLines.push({ x1: cx, y1: cy, x2: ex, y2: ey, key: `s-${id}` });
    });

    setLines(newLines);
  }, []);

  useEffect(() => {
    const timer = setTimeout(computeLines, 100);
    return () => clearTimeout(timer);
  }, [members, sources, expandedSources, computeLines]);

  useEffect(() => {
    const observer = new ResizeObserver(() => computeLines());
    if (containerRef.current) observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [computeLines]);

  const toggleSource = async (source_id: string) => {
    const next = new Set(expandedSources);
    if (next.has(source_id)) {
      next.delete(source_id);
      setExpandedSources(next);
      return;
    }
    next.add(source_id);
    setExpandedSources(next);

    if (!sourceResources[source_id]) {
      setLoadingResources((prev) => new Set([...prev, source_id]));
      try {
        const res = await api.get<{ items: Resource[] }>(
          `/api/v1/monitoring/sources/${source_id}/resources?limit=10`
        );
        setSourceResources((prev) => ({ ...prev, [source_id]: res.items ?? [] }));
      } catch {
        setSourceResources((prev) => ({ ...prev, [source_id]: [] }));
      } finally {
        setLoadingResources((prev) => {
          const s = new Set(prev);
          s.delete(source_id);
          return s;
        });
      }
    }
  };

  const isLoading = membersLoading || sourcesLoading;

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-full">
        <Spinner />
      </div>
    );
  }

  const memberList = members ?? [];
  const sourceList = sources ?? [];

  return (
    <div className="h-full flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-[var(--brand)]/10">
          <Activity className="w-5 h-5 text-[var(--brand)]" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-[var(--text)]">Teia</h1>
          <p className="text-xs text-[var(--text-muted)]">
            Mapa relacional do tenant — usuários, fontes e dispositivos
          </p>
        </div>
        <div className="ml-auto flex items-center gap-4 text-xs text-[var(--text-muted)]">
          <span className="flex items-center gap-1.5">
            <Users className="w-3.5 h-3.5" /> {memberList.length} membros
          </span>
          <span className="flex items-center gap-1.5">
            <Activity className="w-3.5 h-3.5" /> {sourceList.length} fontes
          </span>
        </div>
      </div>

      <div
        ref={containerRef}
        className="relative flex-1 overflow-auto"
        style={{ minHeight: 400 }}
      >
        {/* SVG overlay for lines */}
        <svg
          className="absolute inset-0 pointer-events-none"
          style={{ width: "100%", height: "100%", overflow: "visible" }}
        >
          {lines.map((l) => (
            <path
              key={l.key}
              d={`M ${l.x1} ${l.y1} C ${(l.x1 + l.x2) / 2} ${l.y1}, ${(l.x1 + l.x2) / 2} ${l.y2}, ${l.x2} ${l.y2}`}
              stroke="var(--brand)"
              strokeWidth="1.5"
              strokeOpacity="0.25"
              fill="none"
              strokeDasharray="4 4"
            />
          ))}
        </svg>

        <div className="flex gap-0 items-start" style={{ minHeight: "100%" }}>
          {/* ── Members column ── */}
          <div className="flex flex-col gap-3 w-52 flex-shrink-0 pt-8 pb-8 pr-6">
            <div className="flex items-center gap-2 mb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              <Users className="w-3.5 h-3.5" /> Membros
            </div>
            {memberList.length === 0 && (
              <p className="text-xs text-[var(--text-muted)]">Nenhum membro</p>
            )}
            {memberList.map((m) => {
              const name = m.display_name || m.email || m.principal_id;
              const initials = m.display_name
                ? m.display_name.split(" ").map((w: string) => w[0]).join("").slice(0, 2).toUpperCase()
                : m.email
                  ? m.email[0].toUpperCase()
                  : "?";
              return (
                <div
                  key={m.membership_id}
                  ref={(el) => { memberRefs.current[m.membership_id] = el; }}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2.5 flex flex-col gap-1.5 shadow-sm"
                >
                  <div className="flex items-center gap-2">
                    <div className="w-7 h-7 rounded-full bg-[var(--brand)]/15 flex items-center justify-center text-xs font-semibold text-[var(--brand)] flex-shrink-0">
                      {initials}
                    </div>
                    <div className="min-w-0">
                      <p className="text-xs font-medium text-[var(--text)] truncate leading-tight">{name}</p>
                      {m.email && m.display_name && (
                        <p className="text-[10px] text-[var(--text-muted)] truncate">{m.email}</p>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${ROLE_COLOR[m.role] ?? "bg-slate-500/15 text-slate-400 border-slate-500/30"}`}
                    >
                      {m.role}
                    </span>
                    {m.state !== "active" && (
                      <span className="text-[10px] text-[var(--text-muted)]">{m.state}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* ── Center: Tenant node ── */}
          <div className="flex flex-col items-center justify-start flex-shrink-0 w-44 pt-8 pb-8 px-4">
            <div className="sticky top-8">
              <div
                ref={tenantNodeRef}
                className="rounded-xl border-2 border-[var(--brand)]/40 bg-[var(--surface)] shadow-lg px-5 py-4 flex flex-col items-center gap-2"
              >
                <div className="w-10 h-10 rounded-full bg-[var(--brand)]/15 flex items-center justify-center">
                  <Building2 className="w-5 h-5 text-[var(--brand)]" />
                </div>
                <span className="text-xs font-semibold text-[var(--text)] text-center leading-tight">
                  {tenantId}
                </span>
                <span className="text-[10px] text-[var(--text-muted)]">tenant</span>
              </div>
            </div>
          </div>

          {/* ── Sources + devices column ── */}
          <div className="flex flex-col gap-3 flex-1 min-w-0 pt-8 pb-8 pl-6">
            <div className="flex items-center gap-2 mb-1 text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">
              <Activity className="w-3.5 h-3.5" /> Fontes de Monitoramento
            </div>
            {sourceList.length === 0 && (
              <p className="text-xs text-[var(--text-muted)]">Nenhuma fonte cadastrada</p>
            )}
            {sourceList.map((src) => (
              <div key={src.source_id} className="flex gap-3 items-start">
                {/* Source node */}
                <div
                  ref={(el) => { sourceRefs.current[src.source_id] = el; }}
                  className="rounded-lg border border-[var(--border)] bg-[var(--surface)] shadow-sm flex-shrink-0 w-52"
                >
                  <button
                    onClick={() => toggleSource(src.source_id)}
                    className="w-full px-3 py-2.5 flex items-start gap-2 text-left hover:bg-[var(--surface-hover)] rounded-lg transition-colors"
                  >
                    <div className="mt-0.5 flex-shrink-0">
                      {expandedSources.has(src.source_id)
                        ? <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                        : <ChevronRight className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-1.5 mb-1">
                        {healthDot(src.state)}
                        <span className="text-xs font-medium text-[var(--text)] truncate">
                          {src.display_name}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="text-[10px] text-[var(--text-muted)]">{src.provider}</span>
                        <span
                          className={`inline-flex items-center px-1.5 py-0.5 rounded text-[10px] font-medium border ${SOURCE_STATE_COLOR[src.state] ?? "bg-slate-500/15 text-slate-400 border-slate-500/30"}`}
                        >
                          {src.state}
                        </span>
                        {src.host_count != null && (
                          <span className="text-[10px] text-[var(--text-muted)]">{src.host_count} hosts</span>
                        )}
                      </div>
                    </div>
                  </button>
                </div>

                {/* Devices */}
                {expandedSources.has(src.source_id) && (
                  <div className="flex flex-col gap-2 min-w-0">
                    <div className="flex items-center gap-2 text-[10px] font-semibold text-[var(--text-muted)] uppercase tracking-wider ml-1">
                      <Server className="w-3 h-3" /> Dispositivos
                    </div>
                    {loadingResources.has(src.source_id) && (
                      <div className="flex items-center gap-2 text-xs text-[var(--text-muted)] ml-1">
                        <Spinner className="w-3 h-3" /> Carregando...
                      </div>
                    )}
                    {!loadingResources.has(src.source_id) && (sourceResources[src.source_id] ?? []).length === 0 && (
                      <p className="text-xs text-[var(--text-muted)] ml-1">Nenhum dispositivo</p>
                    )}
                    {(sourceResources[src.source_id] ?? []).map((r) => (
                      <div
                        key={r.resource_id}
                        className="rounded-md border border-[var(--border)] bg-[var(--surface)] px-2.5 py-1.5 flex items-center gap-2 min-w-[160px]"
                      >
                        {healthDot(r.health_state)}
                        <div className="min-w-0">
                          <p className="text-xs font-medium text-[var(--text)] truncate leading-tight">
                            {r.display_name}
                          </p>
                          {r.resource_type && (
                            <p className="text-[10px] text-[var(--text-muted)]">{r.resource_type}</p>
                          )}
                        </div>
                        <span
                          className={`ml-auto inline-flex items-center px-1 py-0.5 rounded text-[10px] font-medium border ${HEALTH_COLOR[r.health_state] ?? "bg-slate-500/15 text-slate-400 border-slate-500/30"}`}
                        >
                          {r.health_state}
                        </span>
                      </div>
                    ))}
                    {(sourceResources[src.source_id] ?? []).length === 10 && (
                      <p className="text-[10px] text-[var(--text-muted)] ml-1">mostrando primeiros 10</p>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
