import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { Plus, X, RefreshCw, KeyRound, Trash2, Search, CheckSquare, Square, AlertCircle } from "lucide-react";

interface Source {
  monitoring_source_id: string;
  display_name: string;
  operational_evidence_state: string;
  provider_instance_ref?: string;
  provider_base_url?: string;
  configuration_revision?: number;
  scope_revision?: number;
  credential_binding_ref?: string;
  has_credential?: boolean;
}

interface AddSourceForm {
  display_name: string;
  provider_base_url: string;
  api_token: string;
  credential_binding_ref: string;
}

interface DiscoveredGroup {
  groupid: string;
  name: string | null;
}

function slugify(s: string) {
  return s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 40) || "cred-binding";
}

function stateVariant(state: string): "success" | "warning" | "danger" | "muted" {
  if (state === "current") return "success";
  if (state === "stale" || state === "incomplete" || state === "reconciliation_required") return "warning";
  if (state === "unavailable") return "danger";
  return "muted";
}

function AddSourceModal({ onClose, tenantId }: { onClose: () => void; tenantId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [form, setForm] = useState<AddSourceForm>({
    display_name: "",
    provider_base_url: "",
    api_token: "",
    credential_binding_ref: "",
  });

  const [discoveredGroups, setDiscoveredGroups] = useState<DiscoveredGroup[] | null>(null);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());

  const canDiscover = form.provider_base_url.trim().length > 0 && form.api_token.trim().length > 0;

  const discoverGroups = async () => {
    setDiscoverLoading(true);
    setDiscoverError(null);
    setDiscoveredGroups(null);
    setSelectedGroups(new Set());
    try {
      const groups = await api.post<DiscoveredGroup[]>("/api/v1/monitoring/sources/discover-groups", {
        provider_base_url: form.provider_base_url,
        api_token: form.api_token,
      });
      setDiscoveredGroups(groups);
    } catch (err: unknown) {
      const e = err as { detail?: string; message?: string };
      setDiscoverError(e?.detail ?? e?.message ?? "Não foi possível conectar ao Zabbix.");
    } finally {
      setDiscoverLoading(false);
    }
  };

  const toggleGroup = (groupid: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupid)) next.delete(groupid); else next.add(groupid);
      return next;
    });
  };

  const toggleAll = () => {
    if (!discoveredGroups) return;
    if (selectedGroups.size === discoveredGroups.length) {
      setSelectedGroups(new Set());
    } else {
      setSelectedGroups(new Set(discoveredGroups.map((g) => g.groupid)));
    }
  };

  const mutation = useMutation({
    mutationFn: (data: AddSourceForm) => {
      const groups = discoveredGroups
        ? [...selectedGroups].map((id) => discoveredGroups.find((g) => g.groupid === id)?.name ?? id).filter(Boolean)
        : [];
      return api.post("/api/v1/monitoring/sources", {
        display_name: data.display_name,
        provider_base_url: data.provider_base_url,
        api_token: data.api_token || undefined,
        credential_binding_ref: data.credential_binding_ref || slugify(data.display_name),
        host_group_refs: groups.length > 0 ? groups : undefined,
      });
    },
    onSuccess: () => {
      toast("Fonte adicionada com sucesso.", "success");
      qc.invalidateQueries({ queryKey: ["sources", tenantId] });
      onClose();
    },
    onError: (err: { detail?: string; message?: string }) => {
      toast(err?.detail ?? err?.message ?? "Erro ao adicionar fonte.", "error");
    },
  });

  const set = (field: keyof AddSourceForm) => (e: React.ChangeEvent<HTMLInputElement>) => {
    setForm((f) => ({ ...f, [field]: e.target.value }));
    if (field === "provider_base_url" || field === "api_token") {
      setDiscoveredGroups(null);
      setDiscoverError(null);
      setSelectedGroups(new Set());
    }
  };

  const credRef = form.credential_binding_ref || slugify(form.display_name) || "cred-binding";

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--surface, #1a1d27)",
          border: "1px solid var(--border, #262c3a)",
          borderRadius: 14,
          padding: 28,
          width: "100%",
          maxWidth: 480,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ fontWeight: 600, fontSize: 15, margin: 0 }}>{t("monitoring.addSourceTitle")}</h3>
          <button
            onClick={onClose}
            style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted, #8b93a5)", padding: 4 }}
          >
            <X size={18} />
          </button>
        </div>

        {/* Form */}
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          <Field label={t("monitoring.sourceName") + " *"}>
            <input
              type="text"
              placeholder="Ex: Produção - Cliente X"
              value={form.display_name}
              onChange={set("display_name")}
            />
          </Field>

          <Field label={t("monitoring.zabbixUrl") + " *"}>
            <input
              type="url"
              placeholder="https://zabbix.exemplo.com"
              value={form.provider_base_url}
              onChange={set("provider_base_url")}
            />
          </Field>

          <Field label={t("monitoring.apiToken") + " *"}>
            <input
              type="password"
              placeholder="Token gerado no Zabbix (User → API tokens)"
              value={form.api_token}
              onChange={set("api_token")}
            />
          </Field>

          <Field label={t("monitoring.credRef")} hint={t("monitoring.credRefAuto", { ref: credRef })}>
            <input
              type="text"
              placeholder={credRef}
              value={form.credential_binding_ref}
              onChange={set("credential_binding_ref")}
            />
          </Field>

          {/* Host groups — discover from Zabbix */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text, #e6e8ec)" }}>
                {t("monitoring.hostGroups")}
                <span style={{ fontWeight: 400, color: "var(--text-muted, #8b93a5)", marginLeft: 6 }}>
                  {discoveredGroups ? t("monitoring.hostGroupsSelected", { count: selectedGroups.size, total: discoveredGroups.length }) : t("monitoring.hostGroupsHint")}
                </span>
              </span>
              <button
                type="button"
                onClick={discoverGroups}
                disabled={!canDiscover || discoverLoading}
                style={{
                  display: "flex", alignItems: "center", gap: 5,
                  padding: "4px 10px", borderRadius: 6, fontSize: 11, fontWeight: 600,
                  background: canDiscover ? "var(--brand, #6366f1)" : "var(--surface, #1a1d27)",
                  color: canDiscover ? "#fff" : "var(--text-muted, #8b93a5)",
                  border: canDiscover ? "none" : "1px solid var(--border, #262c3a)",
                  cursor: canDiscover && !discoverLoading ? "pointer" : "default",
                  opacity: discoverLoading ? 0.7 : 1,
                  transition: "all 0.15s",
                }}
              >
                {discoverLoading ? <Spinner className="w-3 h-3" /> : <Search size={11} />}
                {discoverLoading ? t("monitoring.discovering") : t("monitoring.discover")}
              </button>
            </div>

            {discoverError && (
              <div style={{
                display: "flex", alignItems: "flex-start", gap: 7, padding: "8px 12px",
                borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
                fontSize: 12, color: "#f87171",
              }}>
                <AlertCircle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                {discoverError}
              </div>
            )}

            {discoveredGroups && discoveredGroups.length > 0 && (
              <div style={{
                border: "1px solid var(--border, #262c3a)",
                borderRadius: 8,
                maxHeight: 200,
                overflowY: "auto",
                background: "var(--bg, #0f1115)",
              }}>
                {/* Select all row */}
                <button
                  type="button"
                  onClick={toggleAll}
                  style={{
                    width: "100%", display: "flex", alignItems: "center", gap: 8,
                    padding: "7px 12px", background: "none", border: "none",
                    borderBottom: "1px solid var(--border, #262c3a)",
                    cursor: "pointer", fontSize: 11, fontWeight: 600,
                    color: "var(--text-muted, #8b93a5)", textAlign: "left",
                  }}
                >
                  {selectedGroups.size === discoveredGroups.length
                    ? <CheckSquare size={13} style={{ color: "var(--brand, #6366f1)" }} />
                    : <Square size={13} />}
                  {t("monitoring.allGroups", { count: discoveredGroups.length })}
                </button>
                {discoveredGroups.map((g) => {
                  const checked = selectedGroups.has(g.groupid);
                  return (
                    <button
                      key={g.groupid}
                      type="button"
                      onClick={() => toggleGroup(g.groupid)}
                      style={{
                        width: "100%", display: "flex", alignItems: "center", gap: 8,
                        padding: "6px 12px", background: checked ? "rgba(99,102,241,0.08)" : "none",
                        border: "none", borderBottom: "1px solid var(--border, #262c3a)",
                        cursor: "pointer", fontSize: 12, color: "var(--text, #e6e8ec)", textAlign: "left",
                      }}
                    >
                      {checked
                        ? <CheckSquare size={13} style={{ color: "var(--brand, #6366f1)", flexShrink: 0 }} />
                        : <Square size={13} style={{ flexShrink: 0, color: "var(--text-muted, #8b93a5)" }} />}
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {g.name ?? g.groupid}
                      </span>
                      <span style={{ fontSize: 10, color: "var(--text-muted, #8b93a5)", flexShrink: 0 }}>
                        #{g.groupid}
                      </span>
                    </button>
                  );
                })}
              </div>
            )}

            {discoveredGroups && discoveredGroups.length === 0 && (
              <p style={{ fontSize: 12, color: "var(--text-muted, #8b93a5)" }}>
                {t("monitoring.noGroups")}
              </p>
            )}
          </div>
        </div>

        {/* Actions */}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px", borderRadius: 8, fontSize: 13,
              background: "none", border: "1px solid var(--border, #262c3a)",
              color: "var(--text-muted, #8b93a5)", cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => mutation.mutate(form)}
            disabled={!form.display_name || !form.provider_base_url || !form.api_token || mutation.isPending}
            style={{
              padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: "var(--brand, #6366f1)", color: "#fff",
              border: "none", cursor: "pointer",
              opacity: (!form.display_name || !form.provider_base_url || !form.api_token) ? 0.5 : 1,
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            {mutation.isPending && <Spinner className="w-3 h-3" />}
            {t("monitoring.addSource")}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text, #e6e8ec)" }}>
        {label}
        {hint && <span style={{ fontWeight: 400, color: "var(--text-muted, #8b93a5)", marginLeft: 6 }}>{hint}</span>}
      </span>
      <style>{`
        .mon-field input {
          background: var(--bg, #0f1115);
          border: 1px solid var(--border, #262c3a);
          border-radius: 8px;
          padding: 8px 12px;
          font-size: 13px;
          color: var(--text, #e6e8ec);
          width: 100%;
          box-sizing: border-box;
          outline: none;
          font-family: inherit;
        }
        .mon-field input:focus {
          border-color: var(--brand, #6366f1);
        }
        .mon-field input::placeholder {
          color: var(--text-muted, #8b93a5);
        }
      `}</style>
      <div className="mon-field">{children}</div>
    </label>
  );
}

function RotateTokenModal({
  sourceId,
  tenantId,
  onClose,
}: {
  sourceId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [token, setToken] = useState("");

  const rotate = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/monitoring/sources/${sourceId}/credential`, { api_token: token }),
    onSuccess: () => {
      toast("Token atualizado com sucesso.", "success");
      qc.invalidateQueries({ queryKey: ["sources", tenantId] });
      onClose();
    },
    onError: (err: { detail?: string; message?: string }) => {
      toast(err?.detail ?? err?.message ?? "Erro ao atualizar token.", "error");
    },
  });

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 50,
        background: "rgba(0,0,0,0.6)",
        display: "flex", alignItems: "center", justifyContent: "center",
        padding: 16,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        style={{
          background: "var(--surface, #1a1d27)",
          border: "1px solid var(--border, #262c3a)",
          borderRadius: 14,
          padding: 28,
          width: "100%",
          maxWidth: 440,
          display: "flex",
          flexDirection: "column",
          gap: 20,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <h3 style={{ fontWeight: 600, fontSize: 15, margin: 0 }}>{t("monitoring.changeTokenTitle")}</h3>
          <button onClick={onClose} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted, #8b93a5)", padding: 4 }}>
            <X size={18} />
          </button>
        </div>

        <p style={{ fontSize: 12, color: "var(--text-muted, #8b93a5)", margin: 0, lineHeight: 1.5 }}>
          {t("monitoring.changeTokenHint")}
          <br />
          {t("monitoring.changeTokenManual")}
        </p>

        <Field label={t("monitoring.newToken") + " *"}>
          <input
            type="password"
            placeholder={t("monitoring.tokenPlaceholder")}
            value={token}
            onChange={(e) => setToken(e.target.value)}
            autoFocus
          />
        </Field>

        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
          <button
            onClick={onClose}
            style={{
              padding: "8px 16px", borderRadius: 8, fontSize: 13,
              background: "none", border: "1px solid var(--border, #262c3a)",
              color: "var(--text-muted, #8b93a5)", cursor: "pointer",
            }}
          >
            {t("common.cancel")}
          </button>
          <button
            onClick={() => rotate.mutate()}
            disabled={!token.trim() || rotate.isPending}
            style={{
              padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
              background: "var(--brand, #6366f1)", color: "#fff",
              border: "none", cursor: "pointer",
              opacity: !token.trim() ? 0.5 : 1,
              display: "flex", alignItems: "center", gap: 6,
            }}
          >
            {rotate.isPending && <Spinner className="w-3 h-3" />}
            {t("monitoring.saveToken")}
          </button>
        </div>
      </div>
    </div>
  );
}

function SourceCard({ s, tenantId }: { s: Source; tenantId: string }) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showRotate, setShowRotate] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Optimistic: track local revoke state so button disappears immediately
  const [credRevoked, setCredRevoked] = useState(false);
  const hasCred = !credRevoked && (s.has_credential ?? true);

  const recheck = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/monitoring/sources/${s.monitoring_source_id}/recheck`),
    onSuccess: () => {
      toast("Revalidação enfileirada. Aguarde alguns instantes.", "success");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["sources", tenantId] }), 5000);
    },
    onError: () => {
      toast("Erro ao solicitar revalidação.", "error");
    },
  });

  const revoke = useMutation({
    mutationFn: () =>
      api.delete(`/api/v1/monitoring/sources/${s.monitoring_source_id}/credential`),
    onSuccess: () => {
      toast("Credencial removida. A fonte perderá acesso ao provider.", "success");
      setConfirmRevoke(false);
      setCredRevoked(true);
      qc.invalidateQueries({ queryKey: ["sources", tenantId] });
    },
    onError: (err: { detail?: string; message?: string }) => {
      toast(err?.detail ?? err?.message ?? "Erro ao revogar credencial.", "error");
    },
  });

  const deleteSource = useMutation({
    mutationFn: () =>
      api.delete(`/api/v1/monitoring/sources/${s.monitoring_source_id}`),
    onSuccess: () => {
      toast("Fonte removida.", "success");
      qc.invalidateQueries({ queryKey: ["sources", tenantId] });
    },
    onError: (err: { detail?: string; message?: string }) => {
      toast(err?.detail ?? err?.message ?? "Erro ao excluir fonte.", "error");
    },
  });

  const canRecheck = s.operational_evidence_state !== "current";
  const btnBase: React.CSSProperties = {
    display: "flex", alignItems: "center", gap: 6,
    padding: "6px 12px", borderRadius: 8, fontSize: 12, fontWeight: 500,
    background: "none", border: "1px solid var(--border, #262c3a)",
    cursor: "pointer", width: "100%", justifyContent: "center",
  };

  return (
    <>
      {showRotate && (
        <RotateTokenModal
          sourceId={s.monitoring_source_id}
          tenantId={tenantId}
          onClose={() => setShowRotate(false)}
        />
      )}

      <Card className="flex flex-col gap-3">
        <CardHeader>
          <div className="min-w-0">
            <p className="text-sm font-medium truncate">{s.display_name}</p>
            <p className="text-[10px] text-[var(--text-muted)] font-mono truncate">
              {s.monitoring_source_id}
            </p>
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge variant={stateVariant(s.operational_evidence_state)}>
              {s.operational_evidence_state}
            </Badge>
            {!hasCred && (
              <Badge variant="danger">{t("monitoring.noCredential")}</Badge>
            )}
          </div>
        </CardHeader>

        <dl className="space-y-1">
          {s.provider_instance_ref && (
            <div className="flex justify-between text-xs">
              <dt className="text-[var(--text-muted)]">Provider</dt>
              <dd className="text-[var(--text)] font-mono text-[10px]">{s.provider_instance_ref}</dd>
            </div>
          )}
          {s.provider_base_url && (
            <div className="flex justify-between text-xs">
              <dt className="text-[var(--text-muted)]">URL</dt>
              <dd className="text-[var(--text)] font-mono text-[10px] truncate max-w-[160px]">{s.provider_base_url}</dd>
            </div>
          )}
          {s.configuration_revision !== undefined && (
            <div className="flex justify-between text-xs">
              <dt className="text-[var(--text-muted)]">{t("monitoring.configRev")}</dt>
              <dd className="text-[var(--text)]">{s.configuration_revision}</dd>
            </div>
          )}
          {s.scope_revision !== undefined && (
            <div className="flex justify-between text-xs">
              <dt className="text-[var(--text-muted)]">{t("monitoring.scopeRev")}</dt>
              <dd className="text-[var(--text)]">{s.scope_revision}</dd>
            </div>
          )}
        </dl>

        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "auto" }}>
          {canRecheck && hasCred && (
            <button
              onClick={() => recheck.mutate()}
              disabled={recheck.isPending}
              style={{ ...btnBase, color: "var(--text-muted, #8b93a5)", opacity: recheck.isPending ? 0.6 : 1 }}
            >
              {recheck.isPending ? <Spinner className="w-3 h-3" /> : <RefreshCw size={12} />}
              {t("monitoring.revalidate")}
            </button>
          )}

          {hasCred ? (
            <button onClick={() => setShowRotate(true)} style={{ ...btnBase, color: "var(--text-muted, #8b93a5)" }}>
              <KeyRound size={12} />
              {t("monitoring.changeToken")}
            </button>
          ) : (
            <button onClick={() => setShowRotate(true)} style={{ ...btnBase, color: "var(--brand, #6366f1)", borderColor: "var(--brand, #6366f1)" }}>
              <KeyRound size={12} />
              {t("monitoring.addToken")}
            </button>
          )}

          {hasCred && !confirmRevoke && (
            <button
              onClick={() => setConfirmRevoke(true)}
              style={{ ...btnBase, color: "var(--red, #f87171)" }}
            >
              <Trash2 size={12} />
              {t("monitoring.revokeCredential")}
            </button>
          )}

          {confirmRevoke && (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setConfirmRevoke(false)}
                style={{ flex: 1, padding: "6px 8px", borderRadius: 8, fontSize: 11, background: "none", border: "1px solid var(--border, #262c3a)", color: "var(--text-muted, #8b93a5)", cursor: "pointer" }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => revoke.mutate()}
                disabled={revoke.isPending}
                style={{ flex: 1, padding: "6px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--red, #ef4444)", color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}
              >
                {revoke.isPending ? <Spinner className="w-3 h-3" /> : null}
                {t("monitoring.revoke")}
              </button>
            </div>
          )}

          {!confirmDelete ? (
            <button
              onClick={() => setConfirmDelete(true)}
              style={{ ...btnBase, color: "var(--red, #f87171)", opacity: 0.7 }}
            >
              <Trash2 size={11} />
              {t("monitoring.deleteSource")}
            </button>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setConfirmDelete(false)}
                style={{ flex: 1, padding: "6px 8px", borderRadius: 8, fontSize: 11, background: "none", border: "1px solid var(--border, #262c3a)", color: "var(--text-muted, #8b93a5)", cursor: "pointer" }}
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={() => deleteSource.mutate()}
                disabled={deleteSource.isPending}
                style={{ flex: 1, padding: "6px 8px", borderRadius: 8, fontSize: 11, fontWeight: 600, background: "var(--red, #ef4444)", color: "#fff", border: "none", cursor: "pointer", display: "flex", alignItems: "center", gap: 4, justifyContent: "center" }}
              >
                {deleteSource.isPending ? <Spinner className="w-3 h-3" /> : null}
                {t("monitoring.deleteSourceConfirm")}
              </button>
            </div>
          )}
        </div>
      </Card>
    </>
  );
}

type CredFilter = "all" | "active" | "no_cred";

export function MonitoringPage({ tenantId }: { tenantId: string }) {
  const { t } = useTranslation();
  const [showAdd, setShowAdd] = useState(false);
  const [credFilter, setCredFilter] = useState<CredFilter>("all");
  const q = useQuery({
    queryKey: ["sources", tenantId],
    queryFn: () => api.get<Source[]>(`/api/v1/monitoring/sources`),
    refetchInterval: 30_000,
  });

  const allSources = q.data ?? [];
  const sources = allSources.filter((s) => {
    if (credFilter === "active") return s.has_credential ?? true;
    if (credFilter === "no_cred") return !(s.has_credential ?? true);
    return true;
  });
  const noCredCount = allSources.filter((s) => !(s.has_credential ?? true)).length;

  const tabStyle = (active: boolean): React.CSSProperties => ({
    padding: "4px 12px", borderRadius: 6, fontSize: 12, fontWeight: active ? 600 : 400,
    background: active ? "color-mix(in srgb, var(--brand) 15%, transparent)" : "none",
    color: active ? "var(--brand)" : "var(--text-muted)",
    border: active ? "1px solid color-mix(in srgb, var(--brand) 30%, transparent)" : "1px solid transparent",
    cursor: "pointer",
  });

  return (
    <div className="space-y-4">
      {showAdd && <AddSourceModal onClose={() => setShowAdd(false)} tenantId={tenantId} />}

      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold">{t("monitoring.title")}</h2>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {q.isFetching && <Spinner className="w-3 h-3" />}
          <button
            onClick={() => setShowAdd(true)}
            style={{
              display: "flex", alignItems: "center", gap: 6,
              padding: "6px 14px", borderRadius: 8, fontSize: 13, fontWeight: 500,
              background: "var(--brand, #6366f1)", color: "#fff",
              border: "none", cursor: "pointer",
            }}
          >
            <Plus size={14} />
            {t("monitoring.addSource")}
          </button>
        </div>
      </div>

      {/* Filter tabs */}
      {allSources.length > 0 && (
        <div style={{ display: "flex", gap: 4 }}>
          <button style={tabStyle(credFilter === "all")} onClick={() => setCredFilter("all")}>
            {t("monitoring.filterAll", { count: allSources.length })}
          </button>
          <button style={tabStyle(credFilter === "active")} onClick={() => setCredFilter("active")}>
            {t("monitoring.filterActive", { count: allSources.length - noCredCount })}
          </button>
          {noCredCount > 0 && (
            <button style={tabStyle(credFilter === "no_cred")} onClick={() => setCredFilter("no_cred")}>
              {t("monitoring.filterNoCred", { count: noCredCount })}
            </button>
          )}
        </div>
      )}

      {q.isLoading ? (
        <div className="flex justify-center py-10"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">{t("monitoring.loadError")}</p>
      ) : sources.length === 0 ? (
        <Card>
          <p className="text-xs text-[var(--text-muted)] py-2">
            {credFilter === "no_cred"
              ? t("monitoring.emptyNoCred")
              : t("monitoring.emptyAll")}
          </p>
        </Card>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {sources.map((s) => (
            <SourceCard key={s.monitoring_source_id} s={s} tenantId={tenantId} />
          ))}
        </div>
      )}
    </div>
  );
}
