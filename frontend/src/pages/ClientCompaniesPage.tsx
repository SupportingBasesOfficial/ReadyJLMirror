import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { Building2, X, Plus, ChevronRight, Server, Pencil, Trash2, RefreshCw } from "lucide-react";

type Company = {
  company_id: string;
  tenant_id: string;
  name: string;
  slug: string;
  status: string;
  notes: string | null;
  created_at: string;
  scope_count: number;
};

type Source = {
  monitoring_source_id: string;
  display_name: string;
  provider_base_url: string;
};

type ScopeEntry = {
  scope_id: string;
  company_id: string;
  source_id: string;
  hostgroup_id: string;
  hostgroup_name: string;
};

type DiscoveredGroup = {
  groupid: string;
  name: string | null;
};

function statusColor(status: string): string {
  if (status === "active") return "var(--green, #22c55e)";
  if (status === "suspended") return "var(--red, #ef4444)";
  return "var(--text-muted)";
}

function statusLabel(status: string): string {
  if (status === "active") return "Ativa";
  if (status === "inactive") return "Inativa";
  if (status === "suspended") return "Suspensa";
  return status;
}

// ---------------------------------------------------------------------------
// Scope management modal
// ---------------------------------------------------------------------------

function ScopeModal({
  company,
  tenantId,
  onClose,
}: {
  company: Company;
  tenantId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [selectedSourceId, setSelectedSourceId] = useState<string>("");
  const [apiToken, setApiToken] = useState<string>("");
  const [discovering, setDiscovering] = useState(false);
  const [discoveredGroups, setDiscoveredGroups] = useState<DiscoveredGroup[]>([]);
  const [checkedIds, setCheckedIds] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const sourcesQ = useQuery<Source[]>({
    queryKey: ["monitoring-sources", tenantId],
    queryFn: () => api.get<Source[]>(`/api/v1/monitoring/sources?tenant_id=${tenantId}`),
  });

  const scopeQ = useQuery<ScopeEntry[]>({
    queryKey: ["company-scope", company.company_id],
    queryFn: () =>
      api.get<ScopeEntry[]>(`/api/v1/companies/${company.company_id}/scope?tenant_id=${tenantId}`),
  });

  // Pre-check groups already assigned for this source
  useEffect(() => {
    if (!selectedSourceId || !scopeQ.data) return;
    const existing = new Set(
      scopeQ.data
        .filter((e) => e.source_id === selectedSourceId)
        .map((e) => e.hostgroup_id)
    );
    setCheckedIds(existing);
    setDiscoveredGroups([]);
    setApiToken("");
  }, [selectedSourceId, scopeQ.data]);

  const selectedSource = sourcesQ.data?.find(
    (s) => s.monitoring_source_id === selectedSourceId
  );

  const discoverGroups = async () => {
    if (!selectedSource || !apiToken.trim()) return;
    setDiscovering(true);
    try {
      const groups = await api.post<DiscoveredGroup[]>(
        "/api/v1/monitoring/sources/discover-groups",
        { provider_base_url: selectedSource.provider_base_url, api_token: apiToken.trim() }
      );
      setDiscoveredGroups(groups);
      // Keep pre-existing checks; add new ones that were already in scope
      const existing = new Set(
        scopeQ.data
          ?.filter((e) => e.source_id === selectedSourceId)
          .map((e) => e.hostgroup_id) ?? []
      );
      setCheckedIds(existing);
    } catch {
      toast("Falha ao buscar grupos. Verifique o token e a URL.", "error");
    } finally {
      setDiscovering(false);
    }
  };

  const toggleGroup = (groupid: string) => {
    setCheckedIds((prev) => {
      const next = new Set(prev);
      if (next.has(groupid)) next.delete(groupid);
      else next.add(groupid);
      return next;
    });
  };

  const saveScope = async () => {
    if (!selectedSourceId) return;
    setSaving(true);
    try {
      const entries = [...checkedIds].map((id) => {
        const found = discoveredGroups.find((g) => g.groupid === id);
        const existingEntry = scopeQ.data?.find(
          (e) => e.source_id === selectedSourceId && e.hostgroup_id === id
        );
        return {
          hostgroup_id: id,
          hostgroup_name:
            found?.name ?? existingEntry?.hostgroup_name ?? `Grupo #${id}`,
        };
      });
      await api.put(`/api/v1/companies/${company.company_id}/scope`, {
        tenant_id: tenantId,
        source_id: selectedSourceId,
        entries,
      });
      await qc.invalidateQueries({ queryKey: ["company-scope", company.company_id] });
      await qc.invalidateQueries({ queryKey: ["companies", tenantId] });
      toast(
        `Escopo salvo: ${entries.length} grupo${entries.length !== 1 ? "s" : ""} atribuído${entries.length !== 1 ? "s" : ""}.`,
        "success"
      );
      onClose();
    } catch {
      toast("Erro ao salvar escopo.", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.55)",
        zIndex: 9000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="bg-[var(--surface)] border border-[var(--border)] rounded-xl shadow-2xl flex flex-col"
        style={{ width: 540, maxHeight: "85vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-[var(--border)]">
          <div>
            <h3 className="text-sm font-semibold" style={{ color: "var(--text)" }}>
              Gerenciar Escopo de Hostgroups
            </h3>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              {company.name}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg hover:bg-[var(--surface-2)] transition-colors"
            style={{ color: "var(--text-muted)" }}
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Source selector */}
          <div>
            <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
              Fonte de monitoramento
            </label>
            {sourcesQ.isLoading ? (
              <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
                <Spinner className="w-3 h-3" /> Carregando fontes…
              </div>
            ) : (
              <select
                value={selectedSourceId}
                onChange={(e) => setSelectedSourceId(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs"
                style={{ color: "var(--text)" }}
              >
                <option value="">Selecione uma fonte…</option>
                {sourcesQ.data?.map((s) => (
                  <option key={s.monitoring_source_id} value={s.monitoring_source_id}>
                    {s.display_name} — {s.provider_base_url}
                  </option>
                ))}
              </select>
            )}
          </div>

          {selectedSourceId && (
            <>
              {/* Token input */}
              <div>
                <label className="block text-xs font-medium mb-1" style={{ color: "var(--text-muted)" }}>
                  Token da API Zabbix
                  <span className="ml-1 font-normal opacity-60">(para buscar os grupos disponíveis)</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder="Cole o token aqui…"
                    className="flex-1 px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs"
                    style={{ color: "var(--text)" }}
                    onKeyDown={(e) => { if (e.key === "Enter") discoverGroups(); }}
                  />
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={discoverGroups}
                    disabled={!apiToken.trim() || discovering}
                  >
                    {discovering ? <Spinner className="w-3 h-3" /> : <RefreshCw size={12} />}
                    {discovering ? "Buscando…" : "Buscar"}
                  </Button>
                </div>
              </div>

              {/* Current scope (before discovery) */}
              {discoveredGroups.length === 0 && scopeQ.data && (
                <>
                  {scopeQ.data.filter((e) => e.source_id === selectedSourceId).length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-2" style={{ color: "var(--text-muted)" }}>
                        Grupos atualmente atribuídos nesta fonte
                      </p>
                      <div className="space-y-1">
                        {scopeQ.data
                          .filter((e) => e.source_id === selectedSourceId)
                          .map((e) => (
                            <div key={e.scope_id} className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-[var(--surface-2)]">
                              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: "var(--green, #22c55e)" }} />
                              <span style={{ color: "var(--text)" }}>{e.hostgroup_name}</span>
                              <span className="ml-auto font-mono opacity-50">#{e.hostgroup_id}</span>
                            </div>
                          ))}
                      </div>
                      <p className="text-xs mt-2 opacity-60" style={{ color: "var(--text-muted)" }}>
                        Busque grupos para alterar as seleções.
                      </p>
                    </div>
                  )}
                  {scopeQ.data.filter((e) => e.source_id === selectedSourceId).length === 0 && (
                    <p className="text-xs opacity-60" style={{ color: "var(--text-muted)" }}>
                      Nenhum grupo atribuído para esta fonte. Busque grupos para começar.
                    </p>
                  )}
                </>
              )}

              {/* Discovered groups checkboxes */}
              {discoveredGroups.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                      {discoveredGroups.length} grupos disponíveis
                    </p>
                    <div className="flex gap-2 text-xs">
                      <button
                        onClick={() => setCheckedIds(new Set(discoveredGroups.map((g) => g.groupid)))}
                        className="text-[var(--brand)] hover:underline"
                      >
                        Todos
                      </button>
                      <span style={{ color: "var(--text-dim)" }}>·</span>
                      <button
                        onClick={() => setCheckedIds(new Set())}
                        className="text-[var(--brand)] hover:underline"
                      >
                        Nenhum
                      </button>
                    </div>
                  </div>
                  <div className="space-y-1 max-h-52 overflow-y-auto">
                    {discoveredGroups.map((g) => (
                      <label
                        key={g.groupid}
                        className="flex items-center gap-2.5 px-2 py-1.5 rounded cursor-pointer hover:bg-[var(--surface-2)] transition-colors"
                      >
                        <input
                          type="checkbox"
                          checked={checkedIds.has(g.groupid)}
                          onChange={() => toggleGroup(g.groupid)}
                          className="w-3 h-3 rounded"
                        />
                        <span className="text-xs flex-1" style={{ color: "var(--text)" }}>
                          {g.name ?? `Grupo #${g.groupid}`}
                        </span>
                        <span className="text-xs font-mono opacity-40">#{g.groupid}</span>
                      </label>
                    ))}
                  </div>
                  <p className="text-xs mt-2 opacity-60" style={{ color: "var(--text-muted)" }}>
                    {checkedIds.size} selecionado{checkedIds.size !== 1 ? "s" : ""}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={saveScope}
            disabled={!selectedSourceId || saving || (discoveredGroups.length === 0 && (scopeQ.data?.filter((e) => e.source_id === selectedSourceId).length ?? 0) === 0)}
          >
            {saving ? <Spinner className="w-3 h-3" /> : null}
            {saving ? "Salvando…" : "Salvar escopo"}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Company detail panel
// ---------------------------------------------------------------------------

function CompanyDetail({
  company,
  tenantId,
  onClose,
  onDeleted,
}: {
  company: Company;
  tenantId: string;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(company.name);
  const [editNotes, setEditNotes] = useState(company.notes ?? "");
  const [editStatus, setEditStatus] = useState(company.status);
  const [showScopeModal, setShowScopeModal] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const scopeQ = useQuery<ScopeEntry[]>({
    queryKey: ["company-scope", company.company_id],
    queryFn: () =>
      api.get<ScopeEntry[]>(`/api/v1/companies/${company.company_id}/scope?tenant_id=${tenantId}`),
  });

  const patchMutation = useMutation({
    mutationFn: () =>
      api.patch(`/api/v1/companies/${company.company_id}?tenant_id=${tenantId}`, {
        name: editName.trim() || undefined,
        status: editStatus,
        notes: editNotes.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies", tenantId] });
      setEditing(false);
      toast("Empresa atualizada.", "success");
    },
    onError: () => toast("Erro ao atualizar empresa.", "error"),
  });

  const deleteMutation = useMutation({
    mutationFn: () =>
      api.delete(`/api/v1/companies/${company.company_id}?tenant_id=${tenantId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies", tenantId] });
      toast("Empresa removida.", "success");
      onDeleted();
    },
    onError: () => toast("Erro ao remover empresa.", "error"),
  });

  // Group scope by source
  const scopeBySource = (scopeQ.data ?? []).reduce<Record<string, ScopeEntry[]>>(
    (acc, e) => {
      (acc[e.source_id] ??= []).push(e);
      return acc;
    },
    {}
  );

  return (
    <div className="flex flex-col bg-[var(--surface)] border border-[var(--border)] rounded-xl overflow-hidden"
      style={{ width: 360, flexShrink: 0 }}>
      {/* Panel header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
        <div className="flex items-center gap-2">
          <Building2 size={14} style={{ color: "var(--brand)" }} />
          <span className="text-sm font-semibold truncate" style={{ color: "var(--text)", maxWidth: 240 }}>
            {company.name}
          </span>
        </div>
        <button
          onClick={onClose}
          className="p-1 rounded-lg hover:bg-[var(--surface-2)] transition-colors"
          style={{ color: "var(--text-muted)" }}
        >
          <X size={13} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto">
        {/* Company info */}
        <div className="px-4 py-3 border-b border-[var(--border)] space-y-2">
          {!editing ? (
            <>
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-1.5">
                    <span
                      className="w-1.5 h-1.5 rounded-full"
                      style={{ background: statusColor(company.status) }}
                    />
                    <span className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {statusLabel(company.status)}
                    </span>
                    <span className="text-xs opacity-40 mx-1">·</span>
                    <span className="text-xs font-mono" style={{ color: "var(--text-dim)" }}>
                      {company.slug}
                    </span>
                  </div>
                  {company.notes && (
                    <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                      {company.notes}
                    </p>
                  )}
                </div>
                <button
                  onClick={() => {
                    setEditName(company.name);
                    setEditNotes(company.notes ?? "");
                    setEditStatus(company.status);
                    setEditing(true);
                  }}
                  className="p-1 rounded hover:bg-[var(--surface-2)] transition-colors flex-shrink-0"
                  style={{ color: "var(--text-muted)" }}
                  title="Editar"
                >
                  <Pencil size={12} />
                </button>
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs"
                style={{ color: "var(--text)" }}
                placeholder="Nome"
              />
              <select
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs"
                style={{ color: "var(--text)" }}
              >
                <option value="active">Ativa</option>
                <option value="inactive">Inativa</option>
                <option value="suspended">Suspensa</option>
              </select>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs resize-none"
                style={{ color: "var(--text)" }}
                rows={2}
                placeholder="Observações (opcional)"
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => patchMutation.mutate()}
                  disabled={!editName.trim() || patchMutation.isPending}
                >
                  {patchMutation.isPending ? <Spinner className="w-3 h-3" /> : "Salvar"}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                  Cancelar
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Hostgroup scope */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>
              Escopo de Hostgroups
            </span>
            <Button size="sm" variant="secondary" onClick={() => setShowScopeModal(true)}>
              <Plus size={11} />
              Gerenciar
            </Button>
          </div>

          {scopeQ.isLoading && (
            <div className="flex items-center gap-2 text-xs py-2" style={{ color: "var(--text-muted)" }}>
              <Spinner className="w-3 h-3" /> Carregando…
            </div>
          )}

          {!scopeQ.isLoading && Object.keys(scopeBySource).length === 0 && (
            <p className="text-xs py-2" style={{ color: "var(--text-muted)" }}>
              Nenhum hostgroup atribuído. Clique em Gerenciar para começar.
            </p>
          )}

          {Object.entries(scopeBySource).map(([sourceId, entries]) => (
            <div key={sourceId} className="mb-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Server size={10} style={{ color: "var(--text-dim)" }} />
                <span className="text-[10px] font-mono truncate" style={{ color: "var(--text-dim)" }}>
                  {sourceId}
                </span>
              </div>
              <div className="space-y-0.5 ml-3.5">
                {entries.map((e) => (
                  <div
                    key={e.scope_id}
                    className="flex items-center gap-2 text-xs px-2 py-1 rounded bg-[var(--surface-2)]"
                  >
                    <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: "var(--brand)" }} />
                    <span className="flex-1 truncate" style={{ color: "var(--text)" }}>
                      {e.hostgroup_name}
                    </span>
                    <span className="font-mono opacity-40 text-[10px]">#{e.hostgroup_id}</span>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Delete section */}
      <div className="px-4 py-3 border-t border-[var(--border)]">
        {!confirmDelete ? (
          <button
            onClick={() => setConfirmDelete(true)}
            className="flex items-center gap-1.5 text-xs hover:opacity-80 transition-opacity"
            style={{ color: "var(--red, #ef4444)" }}
          >
            <Trash2 size={11} />
            Remover empresa
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              Isso remove a empresa e todo seu escopo. Confirmar?
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                style={{ background: "var(--red, #ef4444)", color: "#fff" }}
              >
                {deleteMutation.isPending ? <Spinner className="w-3 h-3" /> : "Remover"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}
      </div>

      {showScopeModal && (
        <ScopeModal
          company={company}
          tenantId={tenantId}
          onClose={() => setShowScopeModal(false)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

export function ClientCompaniesPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState("");
  const [createSlug, setCreateSlug] = useState("");
  const [createNotes, setCreateNotes] = useState("");

  const companiesQ = useQuery<Company[]>({
    queryKey: ["companies", tenantId],
    queryFn: () => api.get<Company[]>(`/api/v1/companies?tenant_id=${tenantId}`),
    refetchInterval: 60_000,
  });

  const selectedCompany = companiesQ.data?.find((c) => c.company_id === selectedId) ?? null;

  const createMutation = useMutation({
    mutationFn: () =>
      api.post("/api/v1/companies", {
        tenant_id: tenantId,
        name: createName.trim(),
        slug: createSlug.trim().toLowerCase(),
        notes: createNotes.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["companies", tenantId] });
      setShowCreate(false);
      setCreateName("");
      setCreateSlug("");
      setCreateNotes("");
      toast("Empresa criada.", "success");
    },
    onError: (err: { detail?: string }) => {
      toast(err?.detail ?? "Erro ao criar empresa.", "error");
    },
  });

  // Auto-generate slug from name
  const handleNameChange = (v: string) => {
    setCreateName(v);
    if (!createSlug || createSlug === createName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "")) {
      setCreateSlug(v.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, ""));
    }
  };

  return (
    <div className="flex gap-4 min-h-0" style={{ alignItems: "flex-start" }}>
      {/* Left: list */}
      <div className="flex flex-col gap-4 min-w-0" style={{ flex: selectedCompany ? "0 0 55%" : "1 1 100%" }}>
        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold" style={{ color: "var(--text)" }}>
              Empresas Clientes
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              Organize os hostgroups monitorados por empresa para escopo de alertas, SLA e usuários.
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setShowCreate((v) => !v)}
          >
            <Plus size={13} />
            Nova empresa
          </Button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="border border-[var(--border)] rounded-xl p-4 bg-[var(--surface)] space-y-3">
            <p className="text-xs font-semibold" style={{ color: "var(--text)" }}>Nova empresa</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--text-muted)" }}>Nome</label>
                <input
                  value={createName}
                  onChange={(e) => handleNameChange(e.target.value)}
                  className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs"
                  style={{ color: "var(--text)" }}
                  placeholder="Açopeças Ltda"
                  autoFocus
                />
              </div>
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--text-muted)" }}>Slug</label>
                <input
                  value={createSlug}
                  onChange={(e) => setCreateSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs font-mono"
                  style={{ color: "var(--text)" }}
                  placeholder="acopecas"
                />
              </div>
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: "var(--text-muted)" }}>Observações (opcional)</label>
              <input
                value={createNotes}
                onChange={(e) => setCreateNotes(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs"
                style={{ color: "var(--text)" }}
                placeholder="Ex: contrato até dez/2025, responsável: João"
              />
            </div>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => createMutation.mutate()}
                disabled={!createName.trim() || !createSlug.trim() || createMutation.isPending}
              >
                {createMutation.isPending ? <Spinner className="w-3 h-3" /> : "Criar empresa"}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setShowCreate(false)}>
                Cancelar
              </Button>
            </div>
          </div>
        )}

        {/* Companies table */}
        <div className="border border-[var(--border)] rounded-xl overflow-hidden bg-[var(--surface)]">
          {companiesQ.isLoading && (
            <div className="flex items-center justify-center py-12">
              <Spinner className="w-4 h-4" />
            </div>
          )}

          {!companiesQ.isLoading && (companiesQ.data?.length ?? 0) === 0 && (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Building2 size={28} style={{ color: "var(--text-dim)" }} />
              <p className="text-sm" style={{ color: "var(--text-muted)" }}>
                Nenhuma empresa cadastrada ainda.
              </p>
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus size={12} />
                Criar primeira empresa
              </Button>
            </div>
          )}

          {(companiesQ.data?.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[420px]">
                <thead>
                  <tr className="border-b border-[var(--border)]" style={{ color: "var(--text-muted)" }}>
                    <th className="text-left px-4 py-2.5 font-medium">Empresa</th>
                    <th className="text-left px-3 py-2.5 font-medium hidden sm:table-cell">Slug</th>
                    <th className="text-left px-3 py-2.5 font-medium">Status</th>
                    <th className="text-right px-4 py-2.5 font-medium">Hostgroups</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {companiesQ.data?.map((co) => {
                    const active = co.company_id === selectedId;
                    return (
                      <tr
                        key={co.company_id}
                        onClick={() => setSelectedId(active ? null : co.company_id)}
                        className="border-b border-[var(--border)] cursor-pointer transition-colors"
                        style={{
                          background: active
                            ? "color-mix(in srgb, var(--brand) 8%, transparent)"
                            : undefined,
                        }}
                        onMouseEnter={(e) => {
                          if (!active) (e.currentTarget as HTMLElement).style.background = "var(--surface-2)";
                        }}
                        onMouseLeave={(e) => {
                          if (!active) (e.currentTarget as HTMLElement).style.background = "";
                        }}
                      >
                        <td className="px-4 py-2.5">
                          <span className="font-medium" style={{ color: active ? "var(--brand)" : "var(--text)" }}>
                            {co.name}
                          </span>
                          {co.notes && (
                            <span className="ml-2 opacity-50 text-[10px]">{co.notes.slice(0, 40)}</span>
                          )}
                        </td>
                        <td className="px-3 py-2.5 hidden sm:table-cell">
                          <span className="font-mono" style={{ color: "var(--text-dim)" }}>
                            {co.slug}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <span className="flex items-center gap-1.5">
                            <span
                              className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                              style={{ background: statusColor(co.status) }}
                            />
                            <span style={{ color: "var(--text-muted)" }}>{statusLabel(co.status)}</span>
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-right">
                          <span
                            className="px-2 py-0.5 rounded-full text-[10px] font-medium"
                            style={{
                              background: co.scope_count > 0
                                ? "color-mix(in srgb, var(--brand) 12%, transparent)"
                                : "var(--surface-2)",
                              color: co.scope_count > 0 ? "var(--brand)" : "var(--text-dim)",
                            }}
                          >
                            {co.scope_count}
                          </span>
                        </td>
                        <td className="pr-3">
                          <ChevronRight
                            size={12}
                            style={{
                              color: active ? "var(--brand)" : "var(--text-dim)",
                              transform: active ? "rotate(90deg)" : undefined,
                              transition: "transform 0.15s",
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Right: detail panel */}
      {selectedCompany && (
        <CompanyDetail
          key={selectedCompany.company_id}
          company={selectedCompany}
          tenantId={tenantId}
          onClose={() => setSelectedId(null)}
          onDeleted={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}
