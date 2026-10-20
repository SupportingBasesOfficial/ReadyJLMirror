import { useState, useEffect } from "react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation();
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
              {t("companies.scopeTitle")}
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
              {t("companies.scopeSource")}
            </label>
            {sourcesQ.isLoading ? (
              <div className="flex items-center gap-2 text-xs" style={{ color: "var(--text-muted)" }}>
                <Spinner className="w-3 h-3" /> {t("companies.scopeLoadingSources")}
              </div>
            ) : (
              <select
                value={selectedSourceId}
                onChange={(e) => setSelectedSourceId(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs"
                style={{ color: "var(--text)" }}
              >
                <option value="">{t("companies.scopeSelectSource")}</option>
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
                  {t("companies.scopeApiToken")}
                  <span className="ml-1 font-normal opacity-60">{t("companies.scopeApiTokenHint")}</span>
                </label>
                <div className="flex gap-2">
                  <input
                    type="password"
                    value={apiToken}
                    onChange={(e) => setApiToken(e.target.value)}
                    placeholder={t("companies.scopeTokenPlaceholder")}
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
                    {discovering ? t("companies.scopeDiscovering") : t("companies.scopeDiscover")}
                  </Button>
                </div>
              </div>

              {/* Current scope (before discovery) */}
              {discoveredGroups.length === 0 && scopeQ.data && (
                <>
                  {scopeQ.data.filter((e) => e.source_id === selectedSourceId).length > 0 && (
                    <div>
                      <p className="text-xs font-medium mb-2" style={{ color: "var(--text-muted)" }}>
                        {t("companies.scopeCurrentGroups")}
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
                        {t("companies.scopeEditHint")}
                      </p>
                    </div>
                  )}
                  {scopeQ.data.filter((e) => e.source_id === selectedSourceId).length === 0 && (
                    <p className="text-xs opacity-60" style={{ color: "var(--text-muted)" }}>
                      {t("companies.scopeEmptyHint")}
                    </p>
                  )}
                </>
              )}

              {/* Discovered groups checkboxes */}
              {discoveredGroups.length > 0 && (
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                      {t("companies.scopeAvailable", { count: discoveredGroups.length })}
                    </p>
                    <div className="flex gap-2 text-xs">
                      <button
                        onClick={() => setCheckedIds(new Set(discoveredGroups.map((g) => g.groupid)))}
                        className="text-[var(--brand)] hover:underline"
                      >
                        {t("companies.scopeSelectAll")}
                      </button>
                      <span style={{ color: "var(--text-dim)" }}>·</span>
                      <button
                        onClick={() => setCheckedIds(new Set())}
                        className="text-[var(--brand)] hover:underline"
                      >
                        {t("companies.scopeSelectNone")}
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
                    {t("companies.scopeSelected", { count: checkedIds.size })}
                  </p>
                </div>
              )}
            </>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-[var(--border)]">
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={saveScope}
            disabled={!selectedSourceId || saving || (discoveredGroups.length === 0 && (scopeQ.data?.filter((e) => e.source_id === selectedSourceId).length ?? 0) === 0)}
          >
            {saving ? <Spinner className="w-3 h-3" /> : null}
            {saving ? t("companies.scopeSaving") : t("companies.scopeSave")}
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
  const { t } = useTranslation();
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
                      {t(`companies.status${company.status.charAt(0).toUpperCase() + company.status.slice(1)}`)}
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
                placeholder={t("common.name")}
              />
              <select
                value={editStatus}
                onChange={(e) => setEditStatus(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs"
                style={{ color: "var(--text)" }}
              >
                <option value="active">{t("companies.statusActive")}</option>
                <option value="inactive">{t("companies.statusInactive")}</option>
                <option value="suspended">{t("companies.statusSuspended")}</option>
              </select>
              <textarea
                value={editNotes}
                onChange={(e) => setEditNotes(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-xs resize-none"
                style={{ color: "var(--text)" }}
                rows={2}
                placeholder={t("companies.notesLabel")}
              />
              <div className="flex gap-2">
                <Button
                  size="sm"
                  onClick={() => patchMutation.mutate()}
                  disabled={!editName.trim() || patchMutation.isPending}
                >
                  {patchMutation.isPending ? <Spinner className="w-3 h-3" /> : t("common.save")}
                </Button>
                <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
        </div>

        {/* Hostgroup scope */}
        <div className="px-4 py-3">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold" style={{ color: "var(--text)" }}>
              {t("companies.hostgroupsTitle")}
            </span>
            <Button size="sm" variant="secondary" onClick={() => setShowScopeModal(true)}>
              <Plus size={11} />
              {t("companies.scopeManage")}
            </Button>
          </div>

          {scopeQ.isLoading && (
            <div className="flex items-center gap-2 text-xs py-2" style={{ color: "var(--text-muted)" }}>
              <Spinner className="w-3 h-3" /> {t("common.loading")}
            </div>
          )}

          {!scopeQ.isLoading && Object.keys(scopeBySource).length === 0 && (
            <p className="text-xs py-2" style={{ color: "var(--text-muted)" }}>
              {t("companies.hostgroupsEmpty")}
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
            {t("companies.deleteCompany")}
          </button>
        ) : (
          <div className="space-y-2">
            <p className="text-xs" style={{ color: "var(--text-muted)" }}>
              {t("companies.deleteConfirmMsg")}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                onClick={() => deleteMutation.mutate()}
                disabled={deleteMutation.isPending}
                style={{ background: "var(--red, #ef4444)", color: "#fff" }}
              >
                {deleteMutation.isPending ? <Spinner className="w-3 h-3" /> : t("companies.deleteBtn")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setConfirmDelete(false)}>
                {t("common.cancel")}
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
  const { t } = useTranslation();
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
              {t("companies.title")}
            </h2>
            <p className="text-xs mt-0.5" style={{ color: "var(--text-muted)" }}>
              {t("companies.subtitle")}
            </p>
          </div>
          <Button
            size="sm"
            onClick={() => setShowCreate((v) => !v)}
          >
            <Plus size={13} />
            {t("companies.newCompany")}
          </Button>
        </div>

        {/* Create form */}
        {showCreate && (
          <div className="border border-[var(--border)] rounded-xl p-4 bg-[var(--surface)] space-y-3">
            <p className="text-xs font-semibold" style={{ color: "var(--text)" }}>{t("companies.createTitle")}</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1" style={{ color: "var(--text-muted)" }}>{t("common.name")}</label>
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
                <label className="block text-xs mb-1" style={{ color: "var(--text-muted)" }}>{t("companies.colSlug")}</label>
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
              <label className="block text-xs mb-1" style={{ color: "var(--text-muted)" }}>{t("companies.notesLabel")}</label>
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
                {createMutation.isPending ? <Spinner className="w-3 h-3" /> : t("companies.createBtn")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setShowCreate(false)}>
                {t("common.cancel")}
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
                {t("companies.emptyTitle")}
              </p>
              <Button size="sm" onClick={() => setShowCreate(true)}>
                <Plus size={12} />
                {t("companies.createFirst")}
              </Button>
            </div>
          )}

          {(companiesQ.data?.length ?? 0) > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs min-w-[420px]">
                <thead>
                  <tr className="border-b border-[var(--border)]" style={{ color: "var(--text-muted)" }}>
                    <th className="text-left px-4 py-2.5 font-medium">{t("companies.colName")}</th>
                    <th className="text-left px-3 py-2.5 font-medium hidden sm:table-cell">{t("companies.colSlug")}</th>
                    <th className="text-left px-3 py-2.5 font-medium">{t("companies.colStatus")}</th>
                    <th className="text-right px-4 py-2.5 font-medium">{t("companies.colHostgroups")}</th>
                    <th className="w-8" />
                  </tr>
                </thead>
                <tbody>
                  {companiesQ.data?.map((co) => {
                    const active = co.company_id === selectedId;
                    const statusKey = `companies.status${co.status.charAt(0).toUpperCase() + co.status.slice(1)}` as const;
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
                            <span style={{ color: "var(--text-muted)" }}>{t(statusKey)}</span>
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
