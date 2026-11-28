import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { i18n } from "@/i18n";
import { useSession } from "@/hooks/useSession";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { X, Plus, Building2, Server, FileText, Activity, Tv2, Network, Copy, Trash2, Users, GitMerge, KeyRound, ShieldOff, ShieldCheck, Search, Package, Eye, EyeOff, Archive, RotateCcw, Tag, Gauge, ClipboardList, BarChart3, CreditCard, PauseCircle, PlayCircle, ShoppingBag, ToggleLeft, ToggleRight, Edit2 } from "lucide-react";
import { InfoIcon } from "@/components/ui/tooltip";

// ── Types ──────────────────────────────────────────────────────────────────────

interface OrgTenant {
  tenant_id: string;
  display_name: string | null;
}

interface Organization {
  organization_id: string;
  display_name: string | null;
  state: string;
  created_at: string | null;
  org_kind: "platform_operator" | "msp" | "client";
  tenants: OrgTenant[];
}

interface Tenant {
  tenant_id: string;
  display_name: string;
  organization_id: string | null;
  state: string;
  created_at: string | null;
}

interface Contract {
  contract_id: string;
  commercial_account_id: string;
  plan_ref: string | null;
  state: string;
  effective_from: string | null;
  effective_until: string | null;
}

interface Entitlement {
  entitlement_id: string;
  contract_id: string;
  capability: string;
  state: string;
}

interface CommercialAccount {
  commercial_account_id: string;
  name: string;
  org_id: string;
  contracts?: Contract[];
  entitlements?: Entitlement[];
}

interface PlatformHealth {
  status: string;
  services?: Record<string, string>;
}

interface UsageMeter {
  usage_id: string;
  tenant_id: string;
  meter: string;
  quantity: number;
  window_start: string;
  window_end: string;
  contract_id: string | null;
}

interface Principal {
  principal_id: string;
  kind: string;
  active: boolean;
  created_at: string | null;
  tenant_id: string | null;
  role: string | null;
  membership_id: string | null;
  display_name: string | null;
  email: string | null;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString(i18n.language, { dateStyle: "short" });
}

function truncate(id: string, len = 8): string {
  return id.length > len ? id.slice(0, len) + "…" : id;
}

function stateVariant(state: string): "success" | "warning" | "danger" | "muted" {
  if (state === "active") return "success";
  if (state === "suspended") return "warning";
  if (state === "cancelled" || state === "expired") return "danger";
  return "muted";
}

function orgKindBadge(kind: Organization["org_kind"], t: (key: string) => string): { label: string; variant: "success" | "warning" | "danger" | "muted" } {
  if (kind === "platform_operator") return { label: t("platformAdmin.orgKind.platform_operator"), variant: "warning" };
  if (kind === "msp") return { label: t("platformAdmin.orgKind.msp"), variant: "success" };
  return { label: t("platformAdmin.orgKind.client"), variant: "muted" };
}

function familyLabel(family: string, t: (key: string) => string): string {
  const m: Record<string, string> = {
    provides_monitoring_service_for: t("platformAdmin.relationships.typeMsp"),
    delegated_administration_for: t("platformAdmin.relationships.typePartner"),
    billing_responsible_for: t("platformAdmin.relationships.typeReseller"),
    contracts_platform: t("platformAdmin.orgKind.platform_operator"),
    msp: t("platformAdmin.relationships.typeMsp"),
    reseller: t("platformAdmin.relationships.typeReseller"),
    partner: t("platformAdmin.relationships.typePartner"),
  };
  return m[family] ?? family;
}

// ── Org 360 types ──────────────────────────────────────────────────────────────

interface Org360 {
  organization_id: string;
  display_name: string | null;
  state: string;
  created_at: string;
  tenants: { tenant_id: string; display_name: string; state: string }[];
  relationships: {
    relationship_id: string;
    family: string;
    direction: "incoming" | "outgoing";
    other_organization_id: string;
    state: string;
  }[];
  delegated_grants: {
    grant_id: string;
    target_tenant_id: string;
    principal_id: string;
    permissions: string[];
    state: string;
  }[];
  members: { principal_id: string; tenant_id: string; role: string; state: string }[];
}

function OrgDetailPanel({ orgId, orgKind, onClose }: {
  orgId: string;
  orgKind: Organization["org_kind"];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ["org-360", orgId],
    queryFn: () => api.get<Org360>(`/api/v1/platform/organizations/${orgId}`),
  });
  const { label, variant } = orgKindBadge(orgKind, t);
  const data = q.data;
  const activeGrants = data?.delegated_grants.filter(g => g.state === "active") ?? [];

  return (
    <div className="mt-1 mb-2 border border-[var(--border)] rounded-xl bg-[var(--surface)] overflow-hidden">
      <div className="flex items-center justify-between px-4 py-2.5 border-b border-[var(--border)] bg-[var(--surface-2)]">
        <div className="flex items-center gap-2">
          <Building2 size={13} style={{ color: "var(--brand)" }} />
          <span className="text-xs font-semibold">{data?.display_name || orgId}</span>
          <Badge variant={variant}>{label}</Badge>
          {data && <Badge variant={stateVariant(data.state)}>{data.state}</Badge>}
        </div>
        <button onClick={onClose} className="p-1 rounded hover:bg-[var(--surface)] text-[var(--text-muted)]">
          <X size={12} />
        </button>
      </div>

      {q.isLoading && <div className="flex justify-center py-6"><Spinner /></div>}
      {q.isError && <p className="text-xs text-[var(--red)] px-4 py-3">{t("platformAdmin.org360.loadError")}</p>}

      {data && (
        <div className="grid grid-cols-2 gap-px bg-[var(--border)]">
          {/* Workspaces */}
          <div className="bg-[var(--surface)] p-3 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center gap-1">
              {t("platformAdmin.org360.workspacesSection", { count: data.tenants.length })}
              <InfoIcon text={t("platformAdmin.org360.workspacesTooltip")} position="bottom" align="left" />
            </p>
            {data.tenants.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">{t("platformAdmin.org360.noWorkspaces")}</p>
            ) : data.tenants.map(t => (
              <div key={t.tenant_id} className="flex items-center gap-2 text-xs">
                <span className="w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: t.state === "active" ? "var(--green,#22c55e)" : "var(--text-muted)" }} />
                <span className="font-medium flex-1 truncate">{t.display_name || t.tenant_id}</span>
                <span className="font-mono text-[var(--text-muted)] text-[10px] shrink-0">{truncate(t.tenant_id, 14)}</span>
                <Badge variant={stateVariant(t.state)}>{t.state}</Badge>
              </div>
            ))}
          </div>

          {/* Relationships */}
          <div className="bg-[var(--surface)] p-3 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center gap-1">
              {t("platformAdmin.org360.relationshipsSection", { count: data.relationships.length })}
              <InfoIcon text={t("platformAdmin.org360.relationshipsTooltip")} position="bottom" align="right" />
            </p>
            {data.relationships.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">{t("platformAdmin.org360.noRelationships")}</p>
            ) : data.relationships.map(r => (
              <div key={r.relationship_id} className="flex items-center gap-1.5 text-xs flex-wrap">
                <Badge variant="muted">{familyLabel(r.family, t)}</Badge>
                <span className="text-[var(--text-muted)] text-[10px]">
                  {r.direction === "outgoing" ? t("platformAdmin.org360.outgoing") : t("platformAdmin.org360.incoming")}
                </span>
                <span className="font-mono text-[10px] text-[var(--text)] flex-1 truncate">{r.other_organization_id}</span>
                <Badge variant={stateVariant(r.state)}>{r.state}</Badge>
              </div>
            ))}
          </div>

          {/* Delegated Grants */}
          <div className="bg-[var(--surface)] p-3 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center gap-1">
              {t("platformAdmin.org360.grantsSection", { count: activeGrants.length })}
              <InfoIcon text={t("platformAdmin.org360.grantsTip")} position="bottom" align="left" />
            </p>
            {activeGrants.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">{t("platformAdmin.org360.noGrants")}</p>
            ) : activeGrants.map(g => (
              <div key={g.grant_id} className="text-xs border border-[var(--border)] rounded px-2 py-1.5 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono text-[10px] flex-1 truncate">{g.target_tenant_id}</span>
                  <Badge variant="success">{t("platformAdmin.org360.grantActive")}</Badge>
                </div>
                <p className="text-[10px] text-[var(--text-muted)] font-mono truncate">{truncate(g.principal_id, 16)}</p>
                <div className="flex flex-wrap gap-0.5">
                  {g.permissions.slice(0, 3).map(p => (
                    <code key={p} className="text-[9px] bg-[var(--surface-2)] border border-[var(--border)] px-1 rounded">{p}</code>
                  ))}
                  {g.permissions.length > 3 && <span className="text-[9px] text-[var(--text-muted)]">+{g.permissions.length - 3}</span>}
                </div>
              </div>
            ))}
          </div>

          {/* Members */}
          <div className="bg-[var(--surface)] p-3 space-y-1.5">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] mb-2 flex items-center gap-1">
              {t("platformAdmin.org360.membersSection", { count: data.members.length })}
              <InfoIcon text={t("platformAdmin.org360.membersTip")} position="bottom" align="right" />
            </p>
            {data.members.length === 0 ? (
              <p className="text-[11px] text-[var(--text-muted)]">{t("platformAdmin.org360.noMembers")}</p>
            ) : data.members.map((m, i) => (
              <div key={m.principal_id + i} className="flex items-center gap-1.5 text-xs">
                <span className="font-mono text-[10px] text-[var(--text-muted)] flex-1 truncate">{truncate(m.principal_id, 14)}</span>
                <Badge variant="muted">{m.role}</Badge>
                <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[80px]">{truncate(m.tenant_id, 10)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function capLabel(cap: string): string {
  return (
    { monitoring: "Monitoring", alerting: "Alerting", itsm: "ITSM", aiops: "AIOps" }[cap] ?? cap
  );
}

const inputCls =
  "w-full px-2.5 py-1.5 rounded border border-[var(--border)] " +
  "bg-[var(--surface-2)] text-[var(--text)] text-sm focus:outline-none " +
  "focus:ring-1 focus:ring-[var(--brand)]";

const CAPABILITIES = ["monitoring", "alerting", "itsm", "aiops"] as const;
const ENTITLEMENT_STATES = ["active", "suspended", "expired"] as const;

// ── Local modal overlay ────────────────────────────────────────────────────────

function Modal({ onClose, children }: { onClose: () => void; children: React.ReactNode }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className="relative w-full max-w-md rounded-xl border border-[var(--border)]
          bg-[var(--surface)] shadow-2xl p-6"
      >
        <button
          onClick={onClose}
          className="absolute top-3 right-3 text-[var(--text-muted)]
            hover:text-[var(--text)] cursor-pointer"
        >
          <X size={16} />
        </button>
        {children}
      </div>
    </div>
  );
}

// ── Aba 1: Organizações ────────────────────────────────────────────────────────

function CreateOrgModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [orgKind, setOrgKind] = useState<Organization["org_kind"]>("client");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: () =>
      api.post<Organization>("/api/v1/platform/organizations", {
        organization_id: slug.trim(),
        display_name: displayName.trim() || name.trim() || undefined,
        org_kind: orgKind,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-organizations"] });
      toast(t("platformAdmin.createOrg.createdToast"), "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">{t("platformAdmin.createOrg.title")}</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createOrg.nameLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Corp"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createOrg.slugLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <input
            className={inputCls}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            placeholder="acme-corp"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.createOrg.displayNameLabel")}</label>
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Acme Corporation"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createOrg.typeLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <select
            className={inputCls}
            value={orgKind}
            onChange={(e) => setOrgKind(e.target.value as Organization["org_kind"])}
          >
            <option value="client">{t("platformAdmin.createOrg.typeClient")}</option>
            <option value="msp">{t("platformAdmin.createOrg.typeMsp")}</option>
            <option value="platform_operator">{t("platformAdmin.createOrg.typePlatform")}</option>
          </select>
        </div>
        {error && <p className="text-xs text-[var(--red)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || !slug.trim() || create.isPending}
            className="flex-1"
          >
            {create.isPending ? <Spinner className="w-3 h-3" /> : t("platformAdmin.createOrg.createBtn")}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            {t("platformAdmin.createOrg.cancelBtn")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function OrgsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState<Organization | null>(null);
  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["platform-organizations"],
    queryFn: () => api.get<Organization[]>("/api/v1/platform/organizations"),
    retry: 1,
  });

  const patchState = useMutation({
    mutationFn: ({ orgId, state }: { orgId: string; state: string }) =>
      api.patch(`/api/v1/platform/organizations/${orgId}/state`, { state }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["platform-organizations"] });
      setConfirmSuspend(null);
      toast(vars.state === "suspended" ? t("platformAdmin.orgs.suspendedToast") : t("platformAdmin.orgs.activatedToast"), "success");
    },
    onError: (e: Error) => {
      setConfirmSuspend(null);
      toast(e.message || "Erro ao alterar estado", "error");
    },
  });

  const orgs = q.data ?? [];

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <CardHeader>
          <span className="text-sm font-semibold">{t("platformAdmin.orgs.header")}</span>
          <span className="text-xs text-[var(--text-muted)]">
            {t("platformAdmin.orgs.count", { count: orgs.length })}
          </span>
        </CardHeader>
        <div className="flex items-center gap-2">
          {q.isFetching && <Spinner className="w-3 h-3" />}
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={13} /> {t("platformAdmin.orgs.createBtn")}
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">
          {t("platformAdmin.orgs.loadError")}
        </p>
      ) : orgs.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.orgs.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[520px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th className="text-left px-2 py-1.5 font-medium">
                  <span className="inline-flex items-center">
                    {t("platformAdmin.orgs.colName")}
                    <InfoIcon text={t("platformAdmin.orgs.colNameTip")} position="bottom" align="left" />
                  </span>
                </th>
                <th className="text-left px-2 py-1.5 font-medium">
                  <span className="inline-flex items-center">
                    {t("platformAdmin.orgs.colType")}
                    <InfoIcon text={t("platformAdmin.orgs.colTypeTip")} position="bottom" />
                  </span>
                </th>
                <th className="text-left px-2 py-1.5 font-medium">
                  <span className="inline-flex items-center">
                    {t("platformAdmin.orgs.colId")}
                    <InfoIcon text={t("platformAdmin.orgs.colIdTip")} position="bottom" />
                  </span>
                </th>
                <th className="text-left px-2 py-1.5 font-medium">
                  <span className="inline-flex items-center">
                    {t("platformAdmin.orgs.colState")}
                    <InfoIcon text={t("platformAdmin.orgs.colStateTip")} position="bottom" align="right" />
                  </span>
                </th>
                <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.orgs.colCreated")}</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr
                  key={org.organization_id}
                  className="border-b border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer"
                  onClick={() => setSelectedOrgId(prev => prev === org.organization_id ? null : org.organization_id)}
                >
                  <td className="px-2 py-2">
                    <div className="font-medium flex items-center gap-1.5" style={{ color: selectedOrgId === org.organization_id ? "var(--brand)" : "var(--text)" }}>
                      <span>{org.display_name || org.organization_id}</span>
                      <span className="text-[10px] text-[var(--text-muted)]">{selectedOrgId === org.organization_id ? "▲" : "▼"}</span>
                    </div>
                    {org.tenants.length > 0 && (
                      <div className="flex flex-wrap items-center gap-1 mt-1">
                        {org.tenants.map(t => (
                          <span key={t.tenant_id} className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--surface-2)] text-[var(--text-muted)] font-mono">
                            {t.display_name || t.tenant_id}
                          </span>
                        ))}
                        <InfoIcon text={t("platformAdmin.orgs.workspacesTip")} />
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2">
                    {(() => { const k = orgKindBadge(org.org_kind, t); return <Badge variant={k.variant}>{k.label}</Badge>; })()}
                  </td>
                  <td className="px-2 py-2 font-mono text-[var(--text-muted)]">{org.organization_id}</td>
                  <td className="px-2 py-2">
                    <Badge variant={stateVariant(org.state)}>{org.state}</Badge>
                  </td>
                  <td className="px-2 py-2 text-[var(--text-muted)]">{fmt(org.created_at)}</td>
                  <td className="px-2 py-2">
                    <div className="flex items-center gap-1 justify-end">
                      {org.state === "suspended" ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={patchState.isPending}
                          onClick={() => patchState.mutate({ orgId: org.organization_id, state: "active" })}
                        >
                          {t("platformAdmin.orgs.activate")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmSuspend(org)}
                        >
                          {t("platformAdmin.orgs.suspend")}
                        </Button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedOrgId && (() => {
        const org = orgs.find(o => o.organization_id === selectedOrgId);
        return org ? (
          <OrgDetailPanel
            orgId={selectedOrgId}
            orgKind={org.org_kind}
            onClose={() => setSelectedOrgId(null)}
          />
        ) : null;
      })()}

      {showCreate && <CreateOrgModal onClose={() => setShowCreate(false)} />}

      {confirmSuspend && (
        <ConfirmModal
          title={t("platformAdmin.orgs.suspendTitle")}
          description={t("platformAdmin.orgs.suspendDesc", { name: confirmSuspend.display_name || confirmSuspend.organization_id })}
          confirmLabel={t("platformAdmin.orgs.suspendConfirm")}
          destructive
          isPending={patchState.isPending}
          onConfirm={() =>
            patchState.mutate({ orgId: confirmSuspend.organization_id, state: "suspended" })
          }
          onCancel={() => setConfirmSuspend(null)}
        />
      )}
    </Card>
  );
}

// ── Aba 2: Tenants ─────────────────────────────────────────────────────────────

function CreateTenantModal({
  orgs,
  onClose,
}: {
  orgs: Organization[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [orgId, setOrgId] = useState(orgs[0]?.organization_id ?? "");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: () =>
      api.post<Tenant>("/api/v1/platform/tenants", {
        tenant_id: slug.trim(),
        display_name: name.trim(),
        organization_id: orgId,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-tenants"] });
      toast(t("platformAdmin.createTenant.createdToast"), "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">{t("platformAdmin.createTenant.title")}</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createTenant.orgLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <select
            className={inputCls + " cursor-pointer"}
            value={orgId}
            onChange={(e) => setOrgId(e.target.value)}
          >
            {orgs.map((o) => (
              <option key={o.organization_id} value={o.organization_id}>
                {o.display_name || o.organization_id}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createTenant.nameLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <input
            className={inputCls}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Production"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createTenant.slugLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <input
            className={inputCls}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            placeholder="production"
          />
        </div>
        {error && <p className="text-xs text-[var(--red)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => create.mutate()}
            disabled={!orgId || !name.trim() || !slug.trim() || create.isPending}
            className="flex-1"
          >
            {create.isPending ? <Spinner className="w-3 h-3" /> : t("platformAdmin.createTenant.createBtn")}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            {t("platformAdmin.createTenant.cancelBtn")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TenantsTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTenantId, setSelectedTenantId] = useState<string | null>(null);
  const [confirmState, setConfirmState] = useState<{ tenantId: string; newState: "active" | "suspended" } | null>(null);

  const tenantsQ = useQuery({
    queryKey: ["platform-tenants"],
    queryFn: () => api.get<Tenant[]>("/api/v1/platform/tenants"),
    retry: 1,
  });

  const orgsQ = useQuery({
    queryKey: ["platform-organizations"],
    queryFn: () => api.get<Organization[]>("/api/v1/platform/organizations"),
    retry: 1,
  });

  const tenantUsersQ = useQuery({
    queryKey: ["platform-principals", selectedTenantId],
    queryFn: () =>
      api.get<Principal[]>(
        `/api/v1/platform/principals?tenant_id=${selectedTenantId}`
      ),
    enabled: !!selectedTenantId,
  });

  const stateMutation = useMutation({
    mutationFn: ({ tenantId, newState }: { tenantId: string; newState: "active" | "suspended" }) =>
      api.patch(`/api/v1/platform/tenants/${tenantId}/state`, { state: newState }),
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["platform-tenants"] });
      toast(vars.newState === "suspended" ? "Tenant suspenso" : "Tenant reativado", "success");
      setConfirmState(null);
    },
    onError: () => {
      toast("Erro ao alterar estado do tenant", "error");
      setConfirmState(null);
    },
  });

  const tenants = tenantsQ.data ?? [];
  const orgs = orgsQ.data ?? [];
  const selectedTenant = tenants.find((tenant) => tenant.tenant_id === selectedTenantId);

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <CardHeader>
          <span className="text-sm font-semibold">{t("platformAdmin.tenants.header")}</span>
          <span className="text-xs text-[var(--text-muted)]">
            {t("platformAdmin.tenants.count", { count: tenants.length })}
          </span>
        </CardHeader>
        <div className="flex items-center gap-2">
          {tenantsQ.isFetching && <Spinner className="w-3 h-3" />}
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={13} /> {t("platformAdmin.tenants.createBtn")}
          </Button>
        </div>
      </div>

      {tenantsQ.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : tenantsQ.isError ? (
        <p className="text-xs text-[var(--red)]">
          {t("platformAdmin.tenants.loadError")}
        </p>
      ) : tenants.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.tenants.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[580px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.tenants.colId")}</th>
                <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.tenants.colName")}</th>
                <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.tenants.colOrg")}</th>
                <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.tenants.colState")}</th>
                <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.tenants.colCreated")}</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((tenant) => (
                <tr
                  key={tenant.tenant_id}
                  className="border-b border-[var(--border)] hover:bg-[var(--surface-2)] cursor-pointer"
                  onClick={() =>
                    setSelectedTenantId((prev) =>
                      prev === tenant.tenant_id ? null : tenant.tenant_id
                    )
                  }
                >
                  <td
                    className="px-2 py-2 font-mono text-[var(--text-muted)]"
                    title={tenant.tenant_id}
                  >
                    {truncate(tenant.tenant_id, 8)}
                  </td>
                  <td className="px-2 py-2 font-medium" style={{ color: "var(--text)" }}>
                    {tenant.display_name}
                  </td>
                  <td className="px-2 py-2 text-[var(--text-muted)]">
                    {orgs.find((o) => o.organization_id === tenant.organization_id)?.display_name ||
                      (tenant.organization_id ? truncate(tenant.organization_id) : "—")}
                  </td>
                  <td className="px-2 py-2">
                    <Badge variant={stateVariant(tenant.state)}>{tenant.state}</Badge>
                  </td>
                  <td className="px-2 py-2 text-[var(--text-muted)]">{fmt(tenant.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selectedTenant && (
        <div className="border border-[var(--border)] rounded-xl p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold">{selectedTenant.display_name}</span>
              <span className="text-xs font-mono text-[var(--text-muted)]">
                {selectedTenant.tenant_id}
              </span>
              <Badge variant={stateVariant(selectedTenant.state)}>{selectedTenant.state}</Badge>
            </div>
            <div className="flex items-center gap-2">
              {selectedTenant.state === "active" ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmState({ tenantId: selectedTenant.tenant_id, newState: "suspended" })}
                >
                  <PauseCircle size={12} /> Suspender
                </Button>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => setConfirmState({ tenantId: selectedTenant.tenant_id, newState: "active" })}
                >
                  <PlayCircle size={12} /> Reativar
                </Button>
              )}
              <button
                onClick={() => setSelectedTenantId(null)}
                className="text-[var(--text-muted)] hover:text-[var(--text)]"
              >
                <X size={14} />
              </button>
            </div>
          </div>
          {tenantUsersQ.isLoading ? (
            <Spinner className="w-4 h-4" />
          ) : tenantUsersQ.isError ? (
            <p className="text-xs text-[var(--red)]">{t("platformAdmin.tenants.usersLoadError")}</p>
          ) : (tenantUsersQ.data ?? []).length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.tenants.noUsers")}</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="text-left py-1 font-medium">{t("platformAdmin.tenants.colUser")}</th>
                  <th className="text-left py-1 font-medium">{t("platformAdmin.tenants.colEmail")}</th>
                  <th className="text-left py-1 font-medium">{t("platformAdmin.tenants.colRole")}</th>
                  <th className="text-left py-1 font-medium">{t("platformAdmin.tenants.colKind")}</th>
                </tr>
              </thead>
              <tbody>
                {(tenantUsersQ.data ?? []).map((u) => (
                  <tr key={u.principal_id + (u.membership_id ?? "")} className="border-b border-[var(--border)]">
                    <td className="py-1.5 pr-3">
                      {u.display_name || (
                        <span className="font-mono text-[var(--text-muted)]">
                          {truncate(u.principal_id, 8)}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3 text-[var(--text-muted)]">{u.email || "—"}</td>
                    <td className="py-1.5 pr-3">{u.role || "—"}</td>
                    <td className="py-1.5">
                      <Badge variant={u.kind === "platform_admin_principal" ? "success" : "muted"}>
                        {u.kind.replace("_principal", "")}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showCreate && orgs.length > 0 && (
        <CreateTenantModal orgs={orgs} onClose={() => setShowCreate(false)} />
      )}
      {showCreate && orgs.length === 0 && (
        <Modal onClose={() => setShowCreate(false)}>
          <p className="text-sm text-[var(--text-muted)] text-center py-4">
            {t("platformAdmin.tenants.noOrgWarning")}
          </p>
        </Modal>
      )}

      {confirmState && (
        <ConfirmModal
          title={confirmState.newState === "suspended" ? "Suspender tenant?" : "Reativar tenant?"}
          description={
            confirmState.newState === "suspended"
              ? "O tenant ficará inacessível para seus usuários até ser reativado."
              : "O tenant voltará a funcionar normalmente."
          }
          confirmLabel={confirmState.newState === "suspended" ? "Suspender" : "Reativar"}
          onConfirm={() => stateMutation.mutate(confirmState)}
          onCancel={() => setConfirmState(null)}
          isPending={stateMutation.isPending}
        />
      )}
    </Card>
  );
}

// ── Aba Planos (G13) ──────────────────────────────────────────────────────────

interface Plan {
  plan_id: string;
  display_name: string;
  description: string | null;
  visible: boolean;
  sort_order: number;
  price_monthly: number | null;
  price_currency: string;
  state: "active" | "archived";
  created_at: string;
  updated_at: string;
  capabilities: string[];
  quotas: { quota_key: string; quota_value: number }[];
  active_contracts: number;
}

function PlanModal({
  plan,
  onClose,
}: {
  plan: Plan | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const isEdit = !!plan;

  const [planId, setPlanId] = useState(plan?.plan_id ?? "");
  const [displayName, setDisplayName] = useState(plan?.display_name ?? "");
  const [description, setDescription] = useState(plan?.description ?? "");
  const [visible, setVisible] = useState(plan?.visible ?? true);
  const [sortOrder, setSortOrder] = useState(String(plan?.sort_order ?? 0));
  const [priceMonthly, setPriceMonthly] = useState(
    plan?.price_monthly != null ? String(plan.price_monthly) : ""
  );
  const [priceCurrency, setPriceCurrency] = useState(plan?.price_currency ?? "BRL");
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: () => {
      const body = {
        display_name: displayName.trim(),
        description: description.trim() || null,
        visible,
        sort_order: parseInt(sortOrder) || 0,
        price_monthly: priceMonthly ? parseFloat(priceMonthly) : null,
        price_currency: priceCurrency.trim() || "BRL",
      };
      if (isEdit) {
        return api.patch(`/api/v1/platform/plans/${plan!.plan_id}`, body);
      }
      return api.post("/api/v1/platform/plans", {
        ...body,
        plan_id: planId.trim(),
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-plans"] });
      toast(isEdit ? t("plans.updatedToast") : t("plans.createdToast"), "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 w-full max-w-lg space-y-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold">
            {isEdit ? t("plans.editTitle") : t("plans.createTitle")}
          </span>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)]">
            <X size={15} />
          </button>
        </div>

        <div className="space-y-3">
          {!isEdit && (
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                {t("plans.fieldId")}
              </label>
              <input
                value={planId}
                onChange={(e) => setPlanId(e.target.value)}
                placeholder="ex: starter, pro, enterprise"
                className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--brand)]"
              />
              <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
                {t("plans.fieldIdHint")}
              </p>
            </div>
          )}

          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              {t("plans.fieldName")}
            </label>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder={t("plans.fieldNamePlaceholder")}
              className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--brand)]"
            />
          </div>

          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              {t("plans.fieldDesc")}
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder={t("plans.fieldDescPlaceholder")}
              className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--brand)] resize-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                {t("plans.fieldPrice")}
              </label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={priceMonthly}
                onChange={(e) => setPriceMonthly(e.target.value)}
                placeholder="0.00"
                className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--brand)]"
              />
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                {t("plans.fieldCurrency")}
              </label>
              <input
                value={priceCurrency}
                onChange={(e) => setPriceCurrency(e.target.value)}
                maxLength={3}
                placeholder="BRL"
                className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--brand)]"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                {t("plans.fieldOrder")}
              </label>
              <input
                type="number"
                value={sortOrder}
                onChange={(e) => setSortOrder(e.target.value)}
                className="w-full text-sm bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-2 focus:outline-none focus:border-[var(--brand)]"
              />
            </div>
            <div className="flex items-end pb-0.5">
              <label className="flex items-center gap-2 text-xs text-[var(--text)] cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={visible}
                  onChange={(e) => setVisible(e.target.checked)}
                  className="rounded"
                />
                {t("plans.fieldVisible")}
              </label>
            </div>
          </div>
        </div>

        {error && (
          <p className="text-xs text-red-500">{error}</p>
        )}

        <div className="flex gap-2 justify-end">
          <Button size="sm" variant="secondary" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => save.mutate()}
            disabled={save.isPending || !displayName.trim() || (!isEdit && !planId.trim())}
          >
            {save.isPending ? <Spinner className="w-3 h-3" /> : (isEdit ? t("common.save") : t("common.create"))}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PlanDetail({
  plan,
  onClose,
}: {
  plan: Plan;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [newCap, setNewCap] = useState("");
  const [newQuotaKey, setNewQuotaKey] = useState("");
  const [newQuotaVal, setNewQuotaVal] = useState("-1");
  const [capError, setCapError] = useState<string | null>(null);
  const [quotaError, setQuotaError] = useState<string | null>(null);

  const addCap = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/platform/plans/${plan.plan_id}/capabilities`, {
        capability: newCap.trim().toLowerCase(),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-plans"] });
      setNewCap("");
      setCapError(null);
      toast(t("plans.capAdded"), "success");
    },
    onError: (e: Error) => setCapError(e.message),
  });

  const removeCap = useMutation({
    mutationFn: (cap: string) =>
      api.delete(`/api/v1/platform/plans/${plan.plan_id}/capabilities/${encodeURIComponent(cap)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-plans"] });
      toast(t("plans.capRemoved"), "success");
    },
  });

  const setQuota = useMutation({
    mutationFn: () =>
      api.post(`/api/v1/platform/plans/${plan.plan_id}/quotas`, {
        quota_key: newQuotaKey.trim().toLowerCase(),
        quota_value: parseInt(newQuotaVal),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-plans"] });
      setNewQuotaKey("");
      setNewQuotaVal("-1");
      setQuotaError(null);
      toast(t("plans.quotaSet"), "success");
    },
    onError: (e: Error) => setQuotaError(e.message),
  });

  const removeQuota = useMutation({
    mutationFn: (key: string) =>
      api.delete(`/api/v1/platform/plans/${plan.plan_id}/quotas/${encodeURIComponent(key)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-plans"] });
      toast(t("plans.quotaRemoved"), "success");
    },
  });

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-5 w-full max-w-2xl space-y-5 max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm font-semibold">{plan.display_name}</span>
            <span className="ml-2 text-[10px] text-[var(--text-muted)] font-mono">{plan.plan_id}</span>
          </div>
          <button onClick={onClose} className="text-[var(--text-muted)] hover:text-[var(--text)]">
            <X size={15} />
          </button>
        </div>

        {plan.description && (
          <p className="text-xs text-[var(--text-muted)] whitespace-pre-wrap leading-relaxed">
            {plan.description}
          </p>
        )}

        {/* Capabilities */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Tag size={12} className="text-[var(--text-muted)]" />
            <span className="text-xs font-medium">{t("plans.capabilities")}</span>
          </div>
          <div className="flex flex-wrap gap-1.5 mb-3">
            {plan.capabilities.length === 0 && (
              <span className="text-xs text-[var(--text-muted)]">{t("plans.noCaps")}</span>
            )}
            {plan.capabilities.map((cap) => (
              <span
                key={cap}
                className="inline-flex items-center gap-1 text-[11px] bg-[var(--bg)] border border-[var(--border)] rounded-full px-2.5 py-0.5"
              >
                {cap}
                <button
                  onClick={() => removeCap.mutate(cap)}
                  className="text-[var(--text-muted)] hover:text-red-500 ml-0.5"
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
          <div className="flex gap-2">
            <input
              value={newCap}
              onChange={(e) => setNewCap(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && newCap.trim() && addCap.mutate()}
              placeholder={t("plans.capPlaceholder")}
              className="flex-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[var(--brand)]"
            />
            <Button
              size="sm"
              onClick={() => addCap.mutate()}
              disabled={!newCap.trim() || addCap.isPending}
            >
              <Plus size={12} />
            </Button>
          </div>
          {capError && <p className="text-[10px] text-red-500 mt-1">{capError}</p>}
        </div>

        {/* Quotas */}
        <div>
          <div className="flex items-center gap-1.5 mb-2">
            <Gauge size={12} className="text-[var(--text-muted)]" />
            <span className="text-xs font-medium">{t("plans.quotas")}</span>
          </div>
          {plan.quotas.length > 0 && (
            <table className="w-full text-xs mb-3">
              <thead>
                <tr className="border-b border-[var(--border)]">
                  <th className="text-left text-[var(--text-muted)] font-normal py-1 pr-4">
                    {t("plans.quotaKey")}
                  </th>
                  <th className="text-left text-[var(--text-muted)] font-normal py-1 pr-4">
                    {t("plans.quotaValue")}
                  </th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {plan.quotas.map((q) => (
                  <tr key={q.quota_key} className="border-b border-[var(--border)]">
                    <td className="py-1.5 pr-4 font-mono text-[11px]">{q.quota_key}</td>
                    <td className="py-1.5 pr-4">
                      {q.quota_value === -1 ? (
                        <span className="text-[var(--text-muted)]">{t("plans.unlimited")}</span>
                      ) : (
                        q.quota_value.toLocaleString("pt-BR")
                      )}
                    </td>
                    <td className="py-1.5 text-right">
                      <button
                        onClick={() => removeQuota.mutate(q.quota_key)}
                        className="text-[var(--text-muted)] hover:text-red-500"
                      >
                        <Trash2 size={11} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {plan.quotas.length === 0 && (
            <p className="text-xs text-[var(--text-muted)] mb-3">{t("plans.noQuotas")}</p>
          )}
          <div className="flex gap-2">
            <input
              value={newQuotaKey}
              onChange={(e) => setNewQuotaKey(e.target.value)}
              placeholder={t("plans.quotaKeyPlaceholder")}
              className="flex-1 text-xs bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[var(--brand)]"
            />
            <input
              value={newQuotaVal}
              onChange={(e) => setNewQuotaVal(e.target.value)}
              type="number"
              min={-1}
              placeholder="-1"
              className="w-24 text-xs bg-[var(--bg)] border border-[var(--border)] rounded-lg px-3 py-1.5 focus:outline-none focus:border-[var(--brand)]"
            />
            <Button
              size="sm"
              onClick={() => setQuota.mutate()}
              disabled={!newQuotaKey.trim() || setQuota.isPending}
            >
              <Plus size={12} />
            </Button>
          </div>
          <p className="text-[10px] text-[var(--text-muted)] mt-1">{t("plans.quotaHint")}</p>
          {quotaError && <p className="text-[10px] text-red-500 mt-1">{quotaError}</p>}
        </div>
      </div>
    </div>
  );
}

function PlansTab() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<Plan | null>(null);
  const [detail, setDetail] = useState<Plan | null>(null);

  const { data: plans = [], isLoading, error } = useQuery<Plan[]>({
    queryKey: ["platform-plans"],
    queryFn: () => api.get("/api/v1/platform/plans").then((r) => r.data),
  });

  const toggleVisible = useMutation({
    mutationFn: (plan: Plan) =>
      api.patch(`/api/v1/platform/plans/${plan.plan_id}`, {
        visible: !plan.visible,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-plans"] });
      toast(t("plans.visibilityToggled"), "success");
    },
  });

  const archivePlan = useMutation({
    mutationFn: (plan: Plan) =>
      api.post(`/api/v1/platform/plans/${plan.plan_id}/archive`),
    onSuccess: (_, plan) => {
      qc.invalidateQueries({ queryKey: ["platform-plans"] });
      toast(t("plans.archivedToast", { name: plan.display_name }), "success");
    },
  });

  const restorePlan = useMutation({
    mutationFn: (plan: Plan) =>
      api.post(`/api/v1/platform/plans/${plan.plan_id}/restore`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-plans"] });
      toast(t("plans.restoredToast"), "success");
    },
  });

  const active = plans.filter((p) => p.state === "active");
  const archived = plans.filter((p) => p.state === "archived");

  if (isLoading) return <Spinner />;
  if (error)
    return (
      <p className="text-xs text-red-500">{t("plans.loadError")}</p>
    );

  const renderPlanCard = (plan: Plan) => (
    <div
      key={plan.plan_id}
      className={[
        "border rounded-xl p-4 space-y-3 transition-opacity",
        plan.state === "archived" ? "opacity-60" : "",
        "border-[var(--border)] bg-[var(--card-gradient)]",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-semibold truncate">
              {plan.display_name}
            </span>
            {plan.state === "archived" && (
              <Badge variant="muted">{t("plans.archived")}</Badge>
            )}
            {plan.state === "active" && !plan.visible && (
              <Badge variant="muted">{t("plans.hidden")}</Badge>
            )}
            {plan.active_contracts > 0 && (
              <Badge>
                {t("plans.activeContracts", { count: plan.active_contracts })}
              </Badge>
            )}
          </div>
          <span className="text-[10px] text-[var(--text-muted)] font-mono">
            {plan.plan_id}
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          {plan.state === "active" && (
            <>
              <button
                onClick={() => toggleVisible.mutate(plan)}
                title={plan.visible ? t("plans.hide") : t("plans.show")}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg)]"
              >
                {plan.visible ? <Eye size={13} /> : <EyeOff size={13} />}
              </button>
              <button
                onClick={() => setEditing(plan)}
                title={t("common.edit")}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text)] hover:bg-[var(--bg)]"
              >
                <FileText size={13} />
              </button>
              <button
                onClick={() => archivePlan.mutate(plan)}
                title={t("plans.archive")}
                className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-red-500 hover:bg-[var(--bg)]"
              >
                <Archive size={13} />
              </button>
            </>
          )}
          {plan.state === "archived" && (
            <button
              onClick={() => restorePlan.mutate(plan)}
              title={t("plans.restore")}
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--brand)] hover:bg-[var(--bg)]"
            >
              <RotateCcw size={13} />
            </button>
          )}
        </div>
      </div>

      {plan.description && (
        <p className="text-[11px] text-[var(--text-muted)] line-clamp-2 leading-relaxed">
          {plan.description}
        </p>
      )}

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex flex-wrap gap-1">
          {plan.capabilities.slice(0, 5).map((cap) => (
            <span
              key={cap}
              className="text-[10px] bg-[var(--bg)] border border-[var(--border)] rounded-full px-2 py-0.5"
            >
              {cap}
            </span>
          ))}
          {plan.capabilities.length > 5 && (
            <span className="text-[10px] text-[var(--text-muted)]">
              +{plan.capabilities.length - 5}
            </span>
          )}
          {plan.capabilities.length === 0 && (
            <span className="text-[10px] text-[var(--text-muted)]">
              {t("plans.noCaps")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-3">
          {plan.price_monthly != null && (
            <span className="text-xs font-medium">
              {plan.price_currency}{" "}
              {plan.price_monthly.toLocaleString("pt-BR", {
                minimumFractionDigits: 2,
              })}
              <span className="text-[var(--text-muted)] font-normal">/mês</span>
            </span>
          )}
          <button
            onClick={() => setDetail(plan)}
            className="text-[10px] text-[var(--brand)] hover:underline"
          >
            {t("plans.manageDetail")}
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <Package size={14} />
          <span className="text-sm font-semibold">{t("plans.header")}</span>
          <Badge variant="muted">{active.length}</Badge>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus size={13} /> {t("plans.createBtn")}
        </Button>
      </CardHeader>

      {active.length === 0 && archived.length === 0 && (
        <p className="text-xs text-[var(--text-muted)] py-4 text-center">
          {t("plans.empty")}
        </p>
      )}

      <div className="space-y-3">
        {active.map(renderPlanCard)}
      </div>

      {archived.length > 0 && (
        <div className="mt-5">
          <p className="text-[10px] text-[var(--text-muted)] mb-2 flex items-center gap-1">
            <Archive size={10} /> {t("plans.archivedSection")}
          </p>
          <div className="space-y-3">
            {archived.map(renderPlanCard)}
          </div>
        </div>
      )}

      {(showCreate || editing) && (
        <PlanModal
          plan={editing}
          onClose={() => { setShowCreate(false); setEditing(null); }}
        />
      )}
      {detail && (
        <PlanDetail plan={detail} onClose={() => setDetail(null)} />
      )}
    </Card>
  );
}

// ── Aba 3: Contratos & Entitlements ───────────────────────────────────────────

function CreateContractModal({
  accounts,
  onClose,
}: {
  accounts: CommercialAccount[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [accountId, setAccountId] = useState(accounts[0]?.commercial_account_id ?? "");
  const [planRef, setPlanRef] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: () =>
      api.post<Contract>("/api/v1/platform/contracts", {
        contract_id: crypto.randomUUID(),
        account_id: accountId,
        plan_ref: planRef.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-commercial-accounts"] });
      toast(t("platformAdmin.createContract.createdToast"), "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">{t("platformAdmin.createContract.title")}</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createContract.accountLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <select
            className={inputCls + " cursor-pointer"}
            value={accountId}
            onChange={(e) => setAccountId(e.target.value)}
          >
            {accounts.map((a) => (
              <option key={a.commercial_account_id} value={a.commercial_account_id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.createContract.planRefLabel")}</label>
          <input
            className={inputCls}
            value={planRef}
            onChange={(e) => setPlanRef(e.target.value)}
            placeholder="standard-v1"
          />
        </div>
        {error && <p className="text-xs text-[var(--red)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => create.mutate()}
            disabled={!accountId || create.isPending}
            className="flex-1"
          >
            {create.isPending ? <Spinner className="w-3 h-3" /> : t("platformAdmin.createContract.createBtn")}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            {t("platformAdmin.createContract.cancelBtn")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function CreateEntitlementModal({
  contracts,
  onClose,
}: {
  contracts: Contract[];
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [contractId, setContractId] = useState(contracts[0]?.contract_id ?? "");
  const [capability, setCapability] = useState<(typeof CAPABILITIES)[number]>("monitoring");
  const [entState, setEntState] = useState<(typeof ENTITLEMENT_STATES)[number]>("active");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: () =>
      api.post<Entitlement>("/api/v1/platform/entitlements", {
        contract_id: contractId,
        capability,
        state: entState,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-commercial-accounts"] });
      toast(t("platformAdmin.createEntitlement.createdToast"), "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">{t("platformAdmin.createEntitlement.title")}</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createEntitlement.contractLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <select
            className={inputCls + " cursor-pointer"}
            value={contractId}
            onChange={(e) => setContractId(e.target.value)}
          >
            {contracts.map((c) => (
              <option key={c.contract_id} value={c.contract_id}>
                {c.plan_ref || truncate(c.contract_id)} · {c.state}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            {t("platformAdmin.createEntitlement.capabilityLabel")} <span className="text-[var(--red)]">*</span>
          </label>
          <select
            className={inputCls + " cursor-pointer"}
            value={capability}
            onChange={(e) => setCapability(e.target.value as (typeof CAPABILITIES)[number])}
          >
            {CAPABILITIES.map((c) => (
              <option key={c} value={c}>
                {capLabel(c)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.createEntitlement.stateLabel")}</label>
          <select
            className={inputCls + " cursor-pointer"}
            value={entState}
            onChange={(e) =>
              setEntState(e.target.value as (typeof ENTITLEMENT_STATES)[number])
            }
          >
            {ENTITLEMENT_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        {error && <p className="text-xs text-[var(--red)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => create.mutate()}
            disabled={!contractId || create.isPending}
            className="flex-1"
          >
            {create.isPending ? <Spinner className="w-3 h-3" /> : t("platformAdmin.createEntitlement.createBtn")}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            {t("platformAdmin.createEntitlement.cancelBtn")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ContractsTab() {
  const { t } = useTranslation();
  const [showCreateContract, setShowCreateContract] = useState(false);
  const [showCreateEntitlement, setShowCreateEntitlement] = useState(false);

  const q = useQuery({
    queryKey: ["platform-commercial-accounts"],
    queryFn: () => api.get<CommercialAccount[]>("/api/v1/platform/commercial-accounts"),
    retry: 1,
  });

  const accounts = q.data ?? [];
  const allContracts = accounts.flatMap((a) => a.contracts ?? []);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">{t("platformAdmin.contracts.accountsHeader")}</span>
            {q.isFetching && <Spinner className="w-3 h-3" />}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowCreateEntitlement(true)}>
              <Plus size={13} /> {t("platformAdmin.contracts.newEntitlement")}
            </Button>
            <Button size="sm" onClick={() => setShowCreateContract(true)}>
              <Plus size={13} /> {t("platformAdmin.contracts.newContract")}
            </Button>
          </div>
        </div>

        {q.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)]">
            {t("platformAdmin.contracts.loadError")}
          </p>
        ) : accounts.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.contracts.noAccounts")}</p>
        ) : (
          <div className="space-y-4">
            {accounts.map((account) => (
              <div
                key={account.commercial_account_id}
                className="border border-[var(--border)] rounded-lg p-4 space-y-3"
              >
                <div>
                  <h4 className="text-xs font-semibold" style={{ color: "var(--text)" }}>
                    {account.name}
                  </h4>
                  <p className="text-[10px] font-mono text-[var(--text-muted)]">
                    {account.commercial_account_id}
                  </p>
                </div>

                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium mb-1.5">
                    {t("platformAdmin.contracts.contractsSection")}
                  </p>
                  {!account.contracts || account.contracts.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.contracts.noContracts")}</p>
                  ) : (
                    <div className="space-y-1">
                      {account.contracts.map((c) => (
                        <div
                          key={c.contract_id}
                          className="flex items-center gap-3 text-xs bg-[var(--surface-2)] rounded px-2 py-1.5"
                        >
                          <Badge variant={stateVariant(c.state)}>{c.state}</Badge>
                          <span className="font-mono text-[var(--text-muted)]">
                            {c.plan_ref || "—"}
                          </span>
                          <span className="text-[var(--text-muted)]">
                            {fmt(c.effective_from)} → {fmt(c.effective_until)}
                          </span>
                          <span
                            className="text-[10px] font-mono text-[var(--text-muted)] ml-auto"
                            title={c.contract_id}
                          >
                            {truncate(c.contract_id)}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <p className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium mb-1.5">
                    {t("platformAdmin.contracts.entitlementsSection")}
                  </p>
                  {!account.entitlements || account.entitlements.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.contracts.noEntitlements")}</p>
                  ) : (
                    <div className="flex flex-wrap gap-1.5">
                      {account.entitlements.map((e) => (
                        <Badge key={e.entitlement_id} variant={stateVariant(e.state)}>
                          {capLabel(e.capability)}
                        </Badge>
                      ))}
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>

      {showCreateContract && accounts.length > 0 && (
        <CreateContractModal accounts={accounts} onClose={() => setShowCreateContract(false)} />
      )}
      {showCreateContract && accounts.length === 0 && (
        <Modal onClose={() => setShowCreateContract(false)}>
          <p className="text-sm text-[var(--text-muted)] text-center py-4">
            {t("platformAdmin.contracts.noAccountsAvailable")}
          </p>
        </Modal>
      )}

      {showCreateEntitlement && allContracts.length > 0 && (
        <CreateEntitlementModal
          contracts={allContracts}
          onClose={() => setShowCreateEntitlement(false)}
        />
      )}
      {showCreateEntitlement && allContracts.length === 0 && (
        <Modal onClose={() => setShowCreateEntitlement(false)}>
          <p className="text-sm text-[var(--text-muted)] text-center py-4">
            {t("platformAdmin.contracts.noContractsYet")}
          </p>
        </Modal>
      )}
    </div>
  );
}

// ── Aba 4: Saúde da Plataforma ─────────────────────────────────────────────────

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <Card className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-medium">
        {label}
      </span>
      <span className="text-2xl font-bold tabular-nums" style={{ color: "var(--text)" }}>
        {value}
      </span>
    </Card>
  );
}

function HealthTab() {
  const { t } = useTranslation();
  const orgsQ = useQuery({
    queryKey: ["platform-organizations"],
    queryFn: () => api.get<Organization[]>("/api/v1/platform/organizations"),
    retry: 1,
  });

  const tenantsQ = useQuery({
    queryKey: ["platform-tenants"],
    queryFn: () => api.get<Tenant[]>("/api/v1/platform/tenants"),
    retry: 1,
  });

  const healthQ = useQuery({
    queryKey: ["platform-health"],
    queryFn: () => api.get<PlatformHealth>("/api/v1/platform/health"),
    retry: 0,
  });

  const usageQ = useQuery({
    queryKey: ["platform-usage"],
    queryFn: () => api.get<UsageMeter[]>("/api/v1/platform/usage"),
    retry: 0,
  });

  const orgs = orgsQ.data ?? [];
  const tenants = tenantsQ.data ?? [];
  const activeTenants = tenants.filter((tenant) => tenant.state === "active").length;
  const suspendedTenants = tenants.filter((tenant) => tenant.state === "suspended").length;

  const isLoading = orgsQ.isLoading || tenantsQ.isLoading;

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
          <StatCard label={t("platformAdmin.health.statOrgs")} value={orgs.length} />
          <StatCard label={t("platformAdmin.health.statTenants")} value={tenants.length} />
          <StatCard label={t("platformAdmin.health.statActiveTenants")} value={activeTenants} />
          <StatCard label={t("platformAdmin.health.statSuspendedTenants")} value={suspendedTenants} />
        </div>
      )}

      <Card className="flex flex-col gap-3">
        <CardHeader>
          <span className="text-sm font-semibold">{t("platformAdmin.health.platformStatusHeader")}</span>
          {healthQ.isFetching && <Spinner className="w-3 h-3" />}
        </CardHeader>
        {healthQ.isLoading ? (
          <Spinner className="w-4 h-4" />
        ) : healthQ.isError ? (
          <p className="text-xs text-[var(--text-muted)]">
            {t("platformAdmin.health.healthUnavailable")}
          </p>
        ) : healthQ.data ? (
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <Badge
                variant={
                  healthQ.data.status === "ok" || healthQ.data.status === "healthy"
                    ? "success"
                    : "warning"
                }
              >
                {healthQ.data.status}
              </Badge>
            </div>
            {healthQ.data.services &&
              Object.keys(healthQ.data.services).length > 0 && (
                <dl className="space-y-1 mt-2">
                  {Object.entries(healthQ.data.services).map(([svc, st]) => (
                    <div key={svc} className="flex justify-between text-xs">
                      <dt className="text-[var(--text-muted)]">{svc}</dt>
                      <dd>
                        <Badge
                          variant={
                            st === "ok" || st === "healthy" ? "success" : "warning"
                          }
                        >
                          {st}
                        </Badge>
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
          </div>
        ) : null}
      </Card>

      <Card className="flex flex-col gap-3">
        <CardHeader>
          <span className="text-sm font-semibold">{t("platformAdmin.health.usageHeader")}</span>
          {usageQ.isFetching && <Spinner className="w-3 h-3" />}
          {!usageQ.isLoading && (usageQ.data ?? []).length > 0 && (
            <span className="text-xs text-[var(--text-muted)] ml-auto">
              {t("platformAdmin.health.usageCount", { count: (usageQ.data ?? []).length })}
            </span>
          )}
          <button
            onClick={() => usageQ.refetch()}
            className="text-xs text-[var(--brand)] hover:underline ml-auto"
          >
            {t("platformAdmin.health.refresh")}
          </button>
        </CardHeader>
        {usageQ.isLoading ? (
          <div className="flex justify-center py-4"><Spinner /></div>
        ) : usageQ.isError ? (
          <p className="text-xs text-[var(--text-muted)] py-2">{t("platformAdmin.health.usageUnavailable")}</p>
        ) : (usageQ.data ?? []).length === 0 ? (
          <p className="text-xs text-[var(--text-muted)] py-2">{t("platformAdmin.health.noUsage")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[600px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.health.colOrg")}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.health.colTenant")}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.health.colMeter")}</th>
                  <th className="text-right px-2 py-1.5 font-medium">{t("platformAdmin.health.colQty")}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.health.colStart")}</th>
                  <th className="text-left px-2 py-1.5 font-medium">{t("platformAdmin.health.colEnd")}</th>
                </tr>
              </thead>
              <tbody>
                {(usageQ.data ?? []).map((m) => {
                  const tenantRow = tenants.find(ten => ten.tenant_id === m.tenant_id);
                  const org = tenantRow ? orgs.find(o => o.organization_id === tenantRow.organization_id) : null;
                  const { label: kindLabel, variant: kindVariant } = org ? orgKindBadge(org.org_kind, t) : { label: "—", variant: "muted" as const };
                  return (
                    <tr key={m.usage_id} className="border-b border-[var(--border)]">
                      <td className="px-2 py-1.5">
                        {org ? (
                          <div className="flex items-center gap-1">
                            <span className="truncate max-w-[100px]">{org.display_name || org.organization_id}</span>
                            <Badge variant={kindVariant}>{kindLabel}</Badge>
                          </div>
                        ) : <span className="text-[var(--text-muted)]">—</span>}
                      </td>
                      <td className="px-2 py-1.5">
                        <span className="font-medium">{tenantRow?.display_name || ""}</span>
                        <span className="text-[var(--text-muted)] font-mono ml-1">{truncate(m.tenant_id, 8)}</span>
                      </td>
                      <td className="px-2 py-1.5">{m.meter}</td>
                      <td className="px-2 py-1.5 text-right font-mono tabular-nums">
                        {m.quantity.toFixed(2)}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--text-muted)]">
                        {fmt(m.window_start)}
                      </td>
                      <td className="px-2 py-1.5 text-[var(--text-muted)]">
                        {fmt(m.window_end)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── MSP Onboarding Wizard ─────────────────────────────────────────────────────

const MSP_PERMISSIONS = [
  "tenant:read",
  "tenant:admin",
  "monitoring:read",
  "monitoring:operate",
  "alerting:read",
  "alerting:operate",
  "observability:read",
  "audit:read",
] as const;

interface WizardResult {
  org_id: string;
  tenant_id: string;
  temp_password: string;
  grant_id?: string;
  user_email: string;
}

function MSPOnboardingWizard({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { data: session } = useSession();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [step, setStep] = useState(0);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<WizardResult | null>(null);
  const [wizardError, setWizardError] = useState<string | null>(null);

  const orgsQ = useQuery({
    queryKey: ["platform-organizations"],
    queryFn: () => api.get<Organization[]>("/api/v1/platform/organizations"),
  });

  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [tenantName, setTenantName] = useState("");
  const [tenantSlug, setTenantSlug] = useState("");
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [sourceOrgId, setSourceOrgId] = useState("");
  const [skipGrant, setSkipGrant] = useState(false);
  const [grantPerms, setGrantPerms] = useState<string[]>([
    "tenant:read", "monitoring:read", "alerting:read", "observability:read",
  ]);

  const togglePerm = (p: string) =>
    setGrantPerms((prev) => prev.includes(p) ? prev.filter((x) => x !== p) : [...prev, p]);

  const STEPS = [t("platformAdmin.wizard.stepCompany"), t("platformAdmin.wizard.stepAdmin"), t("platformAdmin.wizard.stepMsp"), t("platformAdmin.wizard.stepDone")];

  async function runWizard() {
    setRunning(true);
    setWizardError(null);
    try {
      await api.post("/api/v1/platform/organizations", {
        organization_id: orgSlug,
        display_name: orgName,
      });
      await api.post("/api/v1/platform/tenants", {
        tenant_id: tenantSlug,
        display_name: tenantName,
        organization_id: orgSlug,
      });
      const userRes = await api.post<{ principal_id: string; temp_password: string }>(
        "/api/v1/platform/users",
        { email, first_name: firstName, last_name: lastName, tenant_id: tenantSlug, role: "admin" },
      );
      let grantId: string | undefined;
      if (!skipGrant && sourceOrgId) {
        await api.post("/api/v1/platform/relationships", {
          family: "msp",
          source_organization_id: sourceOrgId,
          target_organization_id: orgSlug,
        });
        if (session?.principal_id) {
          const g = await api.post<{ grant_id: string }>("/api/v1/platform/delegated-grants", {
            source_organization_id: sourceOrgId,
            target_tenant_id: tenantSlug,
            principal_id: session.principal_id,
            permissions: grantPerms,
          });
          grantId = g.grant_id;
        }
      }
      qc.invalidateQueries({ queryKey: ["platform-organizations"] });
      qc.invalidateQueries({ queryKey: ["platform-tenants"] });
      qc.invalidateQueries({ queryKey: ["teia-orgs"] });
      qc.invalidateQueries({ queryKey: ["teia-tenants"] });
      setResult({ org_id: orgSlug, tenant_id: tenantSlug, temp_password: userRes.temp_password, grant_id: grantId, user_email: email });
      setStep(3);
    } catch (e: unknown) {
      setWizardError(e instanceof Error ? e.message : "Erro desconhecido");
    } finally {
      setRunning(false);
    }
  }

  return (
    <Modal onClose={onClose}>
      {/* Step indicator */}
      <div className="flex items-center gap-1 mb-5">
        {STEPS.map((s, i) => (
          <div key={s} className="flex items-center gap-1">
            <div className={[
              "w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-semibold shrink-0",
              i < step ? "bg-[var(--brand)] text-white" :
              i === step ? "border-2 border-[var(--brand)] text-[var(--brand)]" :
              "border border-[var(--border)] text-[var(--text-muted)]",
            ].join(" ")}>
              {i < step ? "✓" : i + 1}
            </div>
            {i < STEPS.length - 1 && (
              <div className={["h-px w-5", i < step ? "bg-[var(--brand)]" : "bg-[var(--border)]"].join(" ")} />
            )}
          </div>
        ))}
        <span className="ml-2 text-xs text-[var(--text-muted)]">{STEPS[step]}</span>
      </div>

      {step === 0 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("platformAdmin.wizard.step0Title")}</h3>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.wizard.companyNameLabel")}</label>
            <input className={inputCls} value={orgName} onChange={(e) => setOrgName(e.target.value)} placeholder="Acme Corp" />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.wizard.orgIdLabel")}</label>
            <input className={inputCls} value={orgSlug} onChange={(e) => setOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="acme-corp" />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.wizard.workspaceNameLabel")}</label>
            <input className={inputCls} value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="Produção" />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.wizard.tenantIdLabel")}</label>
            <input className={inputCls} value={tenantSlug} onChange={(e) => setTenantSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, "-"))} placeholder="acme-prod" />
          </div>
          <div className="flex gap-2 pt-1">
            <Button className="flex-1" onClick={() => setStep(1)} disabled={!orgName || !orgSlug || !tenantName || !tenantSlug}>
              {t("platformAdmin.wizard.nextBtn")}
            </Button>
            <Button variant="ghost" className="flex-1" onClick={onClose}>{t("platformAdmin.wizard.cancelBtn")}</Button>
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("platformAdmin.wizard.step1Title")}</h3>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.wizard.emailLabel")}</label>
            <input className={inputCls} type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="admin@acme.com" />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.wizard.firstNameLabel")}</label>
            <input className={inputCls} value={firstName} onChange={(e) => setFirstName(e.target.value)} placeholder="João" />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.wizard.lastNameLabel")}</label>
            <input className={inputCls} value={lastName} onChange={(e) => setLastName(e.target.value)} placeholder="Silva" />
          </div>
          <div className="flex gap-2 pt-1">
            <Button variant="ghost" onClick={() => setStep(0)}>{t("platformAdmin.wizard.backBtn")}</Button>
            <Button className="flex-1" onClick={() => setStep(2)} disabled={!email}>{t("platformAdmin.wizard.nextBtn")}</Button>
          </div>
        </div>
      )}

      {step === 2 && (
        <div className="space-y-3">
          <h3 className="text-sm font-semibold">{t("platformAdmin.wizard.step2Title")}</h3>
          <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.wizard.step2Desc")}</p>
          <label className="flex items-center gap-2 text-xs cursor-pointer select-none">
            <input type="checkbox" checked={skipGrant} onChange={(e) => setSkipGrant(e.target.checked)} />
            {t("platformAdmin.wizard.skipGrant")}
          </label>
          {!skipGrant && (
            <>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.wizard.mspOrgLabel")}</label>
                <select className={inputCls + " cursor-pointer"} value={sourceOrgId} onChange={(e) => setSourceOrgId(e.target.value)}>
                  <option value="">{t("platformAdmin.wizard.selectOrgPlaceholder")}</option>
                  {(orgsQ.data ?? []).filter(o => o.organization_id !== orgSlug).map((o) => (
                    <option key={o.organization_id} value={o.organization_id}>
                      {o.display_name || o.organization_id}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-[var(--text-muted)] mb-2">{t("platformAdmin.wizard.grantPermsLabel")}</label>
                <div className="grid grid-cols-2 gap-1">
                  {MSP_PERMISSIONS.map((p) => (
                    <label key={p} className="flex items-center gap-1.5 text-[10px] cursor-pointer select-none">
                      <input type="checkbox" checked={grantPerms.includes(p)} onChange={() => togglePerm(p)} />
                      <code>{p}</code>
                    </label>
                  ))}
                </div>
              </div>
            </>
          )}
          {wizardError && <p className="text-xs text-[var(--red)]">{wizardError}</p>}
          <div className="flex gap-2 pt-1">
            <Button variant="ghost" onClick={() => { setWizardError(null); setStep(1); }}>{t("platformAdmin.wizard.backBtn")}</Button>
            <Button className="flex-1" onClick={runWizard} disabled={running || (!skipGrant && !sourceOrgId)}>
              {running ? <Spinner className="w-3 h-3" /> : t("platformAdmin.wizard.createClientBtn")}
            </Button>
          </div>
        </div>
      )}

      {step === 3 && result && (
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--green,#22c55e)", fontSize: 20 }}>✓</span>
            <h3 className="text-sm font-semibold">{t("platformAdmin.wizard.step3Title")}</h3>
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t("platformAdmin.wizard.labelOrg")}</span><code className="font-mono">{result.org_id}</code></div>
            <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t("platformAdmin.wizard.labelTenant")}</span><code className="font-mono">{result.tenant_id}</code></div>
            <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t("platformAdmin.wizard.labelAdmin")}</span><span>{result.user_email}</span></div>
            {result.grant_id && (
              <div className="flex justify-between"><span className="text-[var(--text-muted)]">{t("platformAdmin.wizard.labelGrantMsp")}</span><Badge variant="success">{t("platformAdmin.wizard.grantActive")}</Badge></div>
            )}
          </div>
          <div className="p-3 rounded-lg bg-[var(--surface-2)] border border-[var(--border)]">
            <p className="text-[10px] text-[var(--text-muted)] mb-1.5">{t("platformAdmin.wizard.tempPasswordLabel")}</p>
            <div className="flex items-center gap-2">
              <code className="text-sm font-mono flex-1 break-all select-all">{result.temp_password}</code>
              <button
                onClick={() => { navigator.clipboard.writeText(result.temp_password).catch(() => null); toast(t("platformAdmin.wizard.copiedToast"), "success"); }}
                className="p-1.5 rounded border border-[var(--border)] hover:bg-[var(--surface)] shrink-0"
              >
                <Copy size={12} />
              </button>
            </div>
          </div>
          <Button className="w-full" onClick={onClose}>{t("platformAdmin.wizard.closeBtn")}</Button>
        </div>
      )}
    </Modal>
  );
}

// ── Relacionamentos & Grants ───────────────────────────────────────────────────

interface Relationship {
  relationship_id: string;
  family: string;
  source_organization_id: string;
  target_organization_id: string;
  state: string;
  effective_from: string;
  effective_until: string | null;
}

interface Grant {
  grant_id: string;
  source_organization_id: string;
  target_tenant_id: string;
  principal_id: string;
  permissions: string[];
  state: string;
  effective_from: string;
  effective_until: string | null;
}

function RelationshipsTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreateRel, setShowCreateRel] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);
  const [confirmEndRel, setConfirmEndRel] = useState<string | null>(null);
  const [showTransfer, setShowTransfer] = useState(false);

  const relsQ = useQuery({
    queryKey: ["platform-relationships"],
    queryFn: () => api.get<Relationship[]>("/api/v1/platform/relationships"),
  });
  const grantsQ = useQuery({
    queryKey: ["platform-grants"],
    queryFn: () => api.get<Grant[]>("/api/v1/platform/delegated-grants"),
  });
  const orgsQ = useQuery({
    queryKey: ["platform-organizations"],
    queryFn: () => api.get<Organization[]>("/api/v1/platform/organizations"),
  });
  const tenantsQ = useQuery({
    queryKey: ["platform-tenants"],
    queryFn: () => api.get<Tenant[]>("/api/v1/platform/tenants"),
  });

  const [relSrc, setRelSrc] = useState("");
  const [relTgt, setRelTgt] = useState("");
  const [relFamily, setRelFamily] = useState("msp");

  const createRel = useMutation({
    mutationFn: () => api.post("/api/v1/platform/relationships", {
      family: relFamily,
      source_organization_id: relSrc,
      target_organization_id: relTgt,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-relationships"] });
      toast(t("platformAdmin.relationships.createdToast"), "success");
      setShowCreateRel(false);
      setRelSrc(""); setRelTgt(""); setRelFamily("msp");
    },
    onError: (e: Error) => toast(e.message || "Erro", "error"),
  });

  const endRel = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/platform/relationships/${id}/end`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-relationships"] });
      toast(t("platformAdmin.relationships.endedToast"), "success");
      setConfirmEndRel(null);
    },
    onError: (e: Error) => toast(e.message || "Erro ao encerrar", "error"),
  });

  const revokeGrant = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/platform/delegated-grants/${id}/revoke`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-grants"] });
      toast(t("platformAdmin.relationships.grantRevokedToast"), "success");
      setConfirmRevoke(null);
    },
    onError: (e: Error) => toast(e.message || "Erro", "error"),
  });

  const orgs = orgsQ.data ?? [];
  const orgName = (id: string) => orgs.find(o => o.organization_id === id)?.display_name || id;
  const tenants = tenantsQ.data ?? [];
  const tenantName = (id: string) => tenants.find(ten => ten.tenant_id === id)?.display_name || id;

  const activeGrants = (grantsQ.data ?? []).filter(g => g.state === "active");

  return (
    <div className="space-y-4">
      {/* Relationships */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold">{t("platformAdmin.relationships.header")}</span>
          <div className="flex gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowTransfer(true)}>
              <GitMerge size={13} /> {t("platformAdmin.relationships.transferBtn")}
            </Button>
            <Button size="sm" onClick={() => setShowCreateRel(true)}>
              <Plus size={13} /> {t("platformAdmin.relationships.newRelBtn")}
            </Button>
          </div>
        </div>

        {showCreateRel && (
          <div className="mb-4 p-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] space-y-3">
            <p className="text-xs font-semibold">{t("platformAdmin.relationships.createRelTitle")}</p>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.relationships.typeLabel")}</label>
              <select className={inputCls} value={relFamily} onChange={(e) => setRelFamily(e.target.value)}>
                <option value="msp">{t("platformAdmin.relationships.typeMsp")}</option>
                <option value="reseller">{t("platformAdmin.relationships.typeReseller")}</option>
                <option value="partner">{t("platformAdmin.relationships.typePartner")}</option>
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.relationships.srcOrgLabel")}</label>
              <select className={inputCls} value={relSrc} onChange={(e) => setRelSrc(e.target.value)}>
                <option value="">{t("platformAdmin.relationships.selectPlaceholder")}</option>
                {orgs.map(o => <option key={o.organization_id} value={o.organization_id}>{o.display_name || o.organization_id}</option>)}
              </select>
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.relationships.tgtOrgLabel")}</label>
              <select className={inputCls} value={relTgt} onChange={(e) => setRelTgt(e.target.value)}>
                <option value="">{t("platformAdmin.relationships.selectPlaceholder")}</option>
                {orgs.filter(o => o.organization_id !== relSrc).map(o => <option key={o.organization_id} value={o.organization_id}>{o.display_name || o.organization_id}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => createRel.mutate()} disabled={!relSrc || !relTgt || createRel.isPending}>
                {createRel.isPending ? <Spinner className="w-3 h-3" /> : null} {t("platformAdmin.relationships.createBtn")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setShowCreateRel(false)}>{t("platformAdmin.relationships.cancelBtn")}</Button>
            </div>
          </div>
        )}

        {relsQ.isLoading ? <Spinner /> : (relsQ.data ?? []).length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.relationships.noRelationships")}</p>
        ) : (
          <div className="space-y-1">
            {(relsQ.data ?? []).map(r => (
              <div key={r.relationship_id} className="flex items-center gap-3 text-xs bg-[var(--surface-2)] rounded-lg px-3 py-2.5">
                <Badge variant="muted">{familyLabel(r.family, t)}</Badge>
                <span className="font-medium">{orgName(r.source_organization_id)}</span>
                <span className="text-[var(--text-muted)]">→</span>
                <span className="font-medium">{orgName(r.target_organization_id)}</span>
                <Badge variant={stateVariant(r.state)} className="ml-auto">{r.state}</Badge>
                {r.state === "active" && (
                  <button
                    onClick={() => setConfirmEndRel(r.relationship_id)}
                    className="p-1 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--red,#ef4444)] shrink-0"
                    title={t("platformAdmin.relationships.endRelButtonTitle")}
                  >
                    <X size={13} />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* Delegated grants */}
      <Card>
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold">{t("platformAdmin.relationships.grantsHeader")}</span>
          <span className="text-xs text-[var(--text-muted)]">{t("platformAdmin.relationships.grantsCount", { count: activeGrants.length })}</span>
        </div>

        {grantsQ.isLoading ? <Spinner /> : activeGrants.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.relationships.noGrants")}</p>
        ) : (
          <div className="space-y-1">
            {activeGrants.map(g => (
              <div key={g.grant_id} className="flex items-center gap-3 text-xs bg-[var(--surface-2)] rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{tenantName(g.target_tenant_id)}</p>
                  <p className="text-[var(--text-muted)] text-[10px] truncate font-mono">{g.principal_id}</p>
                </div>
                <div className="flex flex-wrap gap-0.5 max-w-[160px]">
                  {g.permissions.slice(0, 3).map(p => (
                    <code key={p} className="text-[9px] bg-[var(--surface)] border border-[var(--border)] px-1 rounded">{p}</code>
                  ))}
                  {g.permissions.length > 3 && <span className="text-[9px] text-[var(--text-muted)]">+{g.permissions.length - 3}</span>}
                </div>
                <button
                  onClick={() => setConfirmRevoke(g.grant_id)}
                  className="p-1 rounded hover:bg-[var(--surface)] text-[var(--red,#ef4444)] shrink-0"
                  title={t("platformAdmin.relationships.revokeGrantButtonTitle")}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {confirmRevoke && (
        <ConfirmModal
          title={t("platformAdmin.relationships.revokeGrantTitle")}
          description={t("platformAdmin.relationships.revokeGrantDesc")}
          confirmLabel={t("platformAdmin.relationships.revokeLabel")}
          destructive
          onConfirm={() => revokeGrant.mutate(confirmRevoke)}
          onCancel={() => setConfirmRevoke(null)}
        />
      )}

      {confirmEndRel && (
        <ConfirmModal
          title={t("platformAdmin.relationships.endRelTitle")}
          description={t("platformAdmin.relationships.endRelDesc")}
          confirmLabel={t("platformAdmin.relationships.endRelLabel")}
          destructive
          onConfirm={() => endRel.mutate(confirmEndRel)}
          onCancel={() => setConfirmEndRel(null)}
        />
      )}

      {showTransfer && (
        <ServiceProviderTransferModal
          orgs={orgs}
          onClose={() => setShowTransfer(false)}
          onSuccess={() => {
            qc.invalidateQueries({ queryKey: ["platform-relationships"] });
            qc.invalidateQueries({ queryKey: ["platform-grants"] });
            setShowTransfer(false);
          }}
        />
      )}
    </div>
  );
}

// ── Service Provider Transfer Modal ───────────────────────────────────────────

function ServiceProviderTransferModal({
  orgs,
  onClose,
  onSuccess,
}: {
  orgs: Organization[];
  onClose: () => void;
  onSuccess: () => void;
}) {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [targetOrgId, setTargetOrgId] = useState("");
  const [fromOrgId, setFromOrgId] = useState("");
  const [toOrgId, setToOrgId] = useState("");
  const [result, setResult] = useState<{
    fenced_grants: string[];
    ended_relationships: string[];
    successor_relationships: string[];
  } | null>(null);

  const transfer = useMutation({
    mutationFn: () =>
      api.post<{
        fenced_grants: string[];
        ended_relationships: string[];
        successor_relationships: string[];
      }>("/api/v1/platform/service-provider-transfer", {
        target_organization_id: targetOrgId,
        from_organization_id: fromOrgId,
        to_organization_id: toOrgId,
      }),
    onSuccess: (data) => {
      setResult(data);
      toast(t("platformAdmin.transfer.completedToast"), "success");
      onSuccess();
    },
    onError: (e: Error) => toast(e.message || "Erro na transferência", "error"),
  });

  const orgName = (id: string) => orgs.find(o => o.organization_id === id)?.display_name || id;

  const mspOrgs = orgs.filter(o => o.org_kind === "msp");
  const clientOrgs = orgs.filter(o => o.org_kind === "client");

  if (result) {
    return (
      <Modal onClose={onClose}>
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <span style={{ color: "var(--green,#22c55e)", fontSize: 20 }}>✓</span>
            <h3 className="text-sm font-semibold">{t("platformAdmin.transfer.resultTitle")}</h3>
          </div>
          <div className="space-y-1.5 text-xs">
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">{t("platformAdmin.transfer.clientTransferred")}</span>
              <span className="font-medium">{orgName(targetOrgId)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">{t("platformAdmin.transfer.previousProvider")}</span>
              <span>{orgName(fromOrgId)}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-[var(--text-muted)]">{t("platformAdmin.transfer.newProvider")}</span>
              <span>{orgName(toOrgId)}</span>
            </div>
          </div>
          <div className="rounded-lg bg-[var(--surface-2)] border border-[var(--border)] p-3 space-y-1.5 text-[11px] text-[var(--text-muted)]">
            <p>{t("platformAdmin.transfer.fencedGrants")} <span className="font-mono text-[var(--text)]">{result.fenced_grants.length}</span></p>
            <p>{t("platformAdmin.transfer.endedRelationships")} <span className="font-mono text-[var(--text)]">{result.ended_relationships.length}</span></p>
            <p>{t("platformAdmin.transfer.successorRelationships")} <span className="font-mono text-[var(--text)]">{result.successor_relationships.length}</span></p>
          </div>
          <Button className="w-full" onClick={onClose}>{t("platformAdmin.transfer.closeBtn")}</Button>
        </div>
      </Modal>
    );
  }

  return (
    <Modal onClose={onClose}>
      <div className="space-y-4">
        <div>
          <h3 className="text-sm font-semibold">{t("platformAdmin.transfer.title")}</h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            {t("platformAdmin.transfer.desc")}
          </p>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.transfer.clientLabel")}</label>
            <select className={inputCls} value={targetOrgId} onChange={(e) => setTargetOrgId(e.target.value)}>
              <option value="">{t("platformAdmin.transfer.clientPlaceholder")}</option>
              {clientOrgs.map(o => (
                <option key={o.organization_id} value={o.organization_id}>
                  {o.display_name || o.organization_id}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.transfer.fromLabel")}</label>
            <select className={inputCls} value={fromOrgId} onChange={(e) => setFromOrgId(e.target.value)}>
              <option value="">{t("platformAdmin.transfer.fromPlaceholder")}</option>
              {mspOrgs.filter(o => o.organization_id !== toOrgId).map(o => (
                <option key={o.organization_id} value={o.organization_id}>
                  {o.display_name || o.organization_id}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">{t("platformAdmin.transfer.toLabel")}</label>
            <select className={inputCls} value={toOrgId} onChange={(e) => setToOrgId(e.target.value)}>
              <option value="">{t("platformAdmin.transfer.toPlaceholder")}</option>
              {mspOrgs.filter(o => o.organization_id !== fromOrgId).map(o => (
                <option key={o.organization_id} value={o.organization_id}>
                  {o.display_name || o.organization_id}
                </option>
              ))}
            </select>
          </div>
        </div>

        {targetOrgId && fromOrgId && toOrgId && (
          <div className="rounded-lg bg-[color-mix(in_srgb,var(--yellow,#f59e0b)_8%,transparent)] border border-[color-mix(in_srgb,var(--yellow,#f59e0b)_30%,transparent)] p-3 text-[11px] space-y-0.5">
            <p className="font-semibold" style={{ color: "var(--yellow,#f59e0b)" }}>{t("platformAdmin.transfer.warningTitle")}</p>
            <p className="text-[var(--text-muted)]">
              {t("platformAdmin.transfer.warningBody", { from: orgName(fromOrgId), target: orgName(targetOrgId), to: orgName(toOrgId) })}
            </p>
          </div>
        )}

        <div className="flex gap-2">
          <Button
            className="flex-1"
            onClick={() => transfer.mutate()}
            disabled={!targetOrgId || !fromOrgId || !toOrgId || fromOrgId === toOrgId || transfer.isPending}
          >
            {transfer.isPending ? <Spinner className="w-3 h-3" /> : t("platformAdmin.transfer.executeBtn")}
          </Button>
          <Button variant="ghost" onClick={onClose}>{t("platformAdmin.transfer.cancelBtn")}</Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Usuários (cross-tenant) ────────────────────────────────────────────────────

interface KcUserTenant {
  tenant_id: string;
  tenant_name: string | null;
  role: string;
  state: string;
  organization_id: string;
  organization_name: string | null;
}

interface KcUser {
  user_id: string;
  email: string;
  firstName: string;
  lastName: string;
  enabled: boolean;
  tenants?: KcUserTenant[];
}

function UsersTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [q, setQ] = useState("");
  const [searched, setSearched] = useState(false);
  const [resetResult, setResetResult] = useState<{ email: string; pwd: string } | null>(null);

  const searchQ = useQuery({
    queryKey: ["platform-users-search", q],
    queryFn: () => api.get<KcUser[]>(`/api/v1/platform/users?q=${encodeURIComponent(q)}`),
    enabled: searched,
  });

  const resetPwd = useMutation({
    mutationFn: (u: KcUser) =>
      api.post<{ temp_password: string }>(`/api/v1/platform/users/${u.user_id}/reset-password`, {}),
    onSuccess: (data, u) => {
      setResetResult({ email: u.email, pwd: data.temp_password });
      toast(t("platformAdmin.users.pwdResetToast"), "success");
    },
    onError: (e: Error) => toast(e.message || "Erro ao redefinir senha", "error"),
  });

  const disableUser = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/platform/users/${id}/disable`, {}),
    onSuccess: () => { toast(t("platformAdmin.users.disabledToast"), "success"); searchQ.refetch(); },
    onError: (e: Error) => toast(e.message || "Erro", "error"),
  });

  const enableUser = useMutation({
    mutationFn: (id: string) => api.post(`/api/v1/platform/users/${id}/enable`, {}),
    onSuccess: () => { toast(t("platformAdmin.users.enabledToast"), "success"); searchQ.refetch(); },
    onError: (e: Error) => toast(e.message || "Erro", "error"),
  });

  return (
    <div className="space-y-4">
      {resetResult && (
        <div className="p-4 rounded-xl border border-[var(--green,#22c55e)] bg-[color-mix(in_srgb,var(--green,#22c55e)_8%,transparent)] space-y-3">
          <p className="text-sm font-semibold" style={{ color: "var(--green,#22c55e)" }}>
            {t("platformAdmin.users.pwdResetBanner", { email: resetResult.email })}
          </p>
          <div className="flex items-center gap-2">
            <code className="text-sm font-mono flex-1 break-all select-all bg-[var(--surface-2)] px-2 py-1.5 rounded border border-[var(--border)]">
              {resetResult.pwd}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(resetResult.pwd).catch(() => null); toast(t("platformAdmin.users.copiedToast"), "success"); }}
              className="p-1.5 rounded border border-[var(--border)] hover:bg-[var(--surface-2)]"
            >
              <Copy size={13} />
            </button>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setResetResult(null)}>{t("platformAdmin.users.closeBtn")}</Button>
        </div>
      )}

      <Card>
        <div className="flex gap-2 mb-4">
          <div className="flex-1 relative">
            <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              className={inputCls + " pl-8"}
              placeholder={t("platformAdmin.users.searchPlaceholder")}
              value={q}
              onChange={(e) => setQ(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") { setSearched(true); searchQ.refetch(); } }}
            />
          </div>
          <Button size="sm" onClick={() => { setSearched(true); searchQ.refetch(); }}>
            {t("platformAdmin.users.searchBtn")}
          </Button>
        </div>

        {!searched && (
          <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.users.searchHint")}</p>
        )}

        {searched && searchQ.isLoading && <Spinner />}

        {searched && !searchQ.isLoading && (searchQ.data ?? []).length === 0 && (
          <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.users.noResults")}</p>
        )}

        {(searchQ.data ?? []).length > 0 && (
          <div className="space-y-1">
            {(searchQ.data ?? []).map((u) => (
              <div key={u.user_id} className="flex items-start gap-3 text-xs bg-[var(--surface-2)] rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{[u.firstName, u.lastName].filter(Boolean).join(" ") || u.email}</p>
                  <p className="text-[var(--text-muted)] text-[10px] truncate">{u.email}</p>
                  {(u.tenants ?? []).length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1.5">
                      {(u.tenants ?? []).map((ut) => (
                        <span key={ut.tenant_id} className="inline-flex items-center gap-0.5 text-[10px] px-1.5 py-0.5 rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text-muted)]">
                          <span className="font-medium text-[var(--text)]">{ut.tenant_name || ut.tenant_id}</span>
                          <span className="opacity-60">·</span>
                          <span>{ut.role === "tenant_admin" ? "admin" : t("platformAdmin.users.roleMember")}</span>
                        </span>
                      ))}
                    </div>
                  )}
                  {(u.tenants ?? []).length === 0 && searched && (
                    <p className="text-[10px] text-[var(--text-muted)] opacity-60 mt-0.5">{t("platformAdmin.users.noTenant")}</p>
                  )}
                </div>
                <Badge variant={u.enabled ? "success" : "muted"}>{u.enabled ? t("platformAdmin.users.userActive") : t("platformAdmin.users.userInactive")}</Badge>
                <div className="flex items-center gap-1 shrink-0">
                  <button
                    onClick={() => resetPwd.mutate(u)}
                    disabled={resetPwd.isPending}
                    className="p-1 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--brand)]"
                    title={t("platformAdmin.users.resetPwdTitle")}
                  >
                    <KeyRound size={13} />
                  </button>
                  {u.enabled ? (
                    <button
                      onClick={() => disableUser.mutate(u.user_id)}
                      className="p-1 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--yellow,#f59e0b)]"
                      title={t("platformAdmin.users.disableTitle")}
                    >
                      <ShieldOff size={13} />
                    </button>
                  ) : (
                    <button
                      onClick={() => enableUser.mutate(u.user_id)}
                      className="p-1 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--green,#22c55e)]"
                      title={t("platformAdmin.users.enableTitle")}
                    >
                      <ShieldCheck size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── TV Mode tab ────────────────────────────────────────────────────────────────

interface DisplayToken {
  principal_id: string;
  tenant_id: string;
  label: string | null;
  created_at: string;
  expires_at: string | null;
  retired: boolean;
}

function TVModeTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [newLabel, setNewLabel] = useState("");
  const [newTenantId, setNewTenantId] = useState("");
  const [newExpireDays, setNewExpireDays] = useState("365");
  const [createdToken, setCreatedToken] = useState<{ token: string; tv_url: string } | null>(null);
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null);

  const tenantsQ = useQuery({
    queryKey: ["platform-tenants-tv"],
    queryFn: () => api.get<Tenant[]>("/api/v1/platform/tenants"),
  });

  const tokensQ = useQuery({
    queryKey: ["platform-display-tokens"],
    queryFn: () => api.get<DisplayToken[]>("/api/v1/platform/display-principals"),
  });

  const createMut = useMutation({
    mutationFn: () =>
      api.post<{ principal_id: string; token: string }>("/api/v1/platform/display-tokens", {
        tenant_id: newTenantId,
        label: newLabel || "TV Display",
        expires_in_days: parseInt(newExpireDays) || 365,
      }),
    onSuccess: (data) => {
      const tvUrl = `${window.location.origin}/auth/tv?token=${data.token}`;
      setCreatedToken({ token: data.token, tv_url: tvUrl });
      qc.invalidateQueries({ queryKey: ["platform-display-tokens"] });
      setShowCreate(false);
      setNewLabel(""); setNewTenantId(""); setNewExpireDays("365");
    },
    onError: (e: Error) => toast(e.message || "Erro ao criar token", "error"),
  });

  const revokeMut = useMutation({
    mutationFn: (principalId: string) =>
      api.post(`/api/v1/platform/display-tokens/${principalId}/revoke`, {}),
    onSuccess: () => {
      toast(t("platformAdmin.tv.revokedToast"), "success");
      qc.invalidateQueries({ queryKey: ["platform-display-tokens"] });
      setConfirmRevoke(null);
    },
    onError: (e: Error) => toast(e.message || "Erro ao revogar", "error"),
  });

  const activeTokens = (tokensQ.data ?? []).filter((tok) => !tok.retired);

  return (
    <div className="space-y-4">
      {createdToken && (
        <div className="p-4 rounded-xl border border-[var(--green,#22c55e)] bg-[color-mix(in_srgb,var(--green,#22c55e)_8%,transparent)] space-y-3">
          <p className="text-sm font-semibold" style={{ color: "var(--green,#22c55e)" }}>
            {t("platformAdmin.tv.tokenCreatedMsg")}
          </p>
          <div className="flex items-center gap-2">
            <code className="text-xs flex-1 truncate font-mono bg-[var(--surface-2)] px-2 py-1.5 rounded border border-[var(--border)]">
              {createdToken.tv_url}
            </code>
            <button
              onClick={() => { navigator.clipboard.writeText(createdToken.tv_url).catch(() => null); toast(t("platformAdmin.tv.urlCopiedToast"), "success"); }}
              className="p-1.5 rounded border border-[var(--border)] hover:bg-[var(--surface-2)]"
              title={t("platformAdmin.tv.copyUrlTitle")}
            >
              <Copy size={13} />
            </button>
          </div>
          <Button size="sm" variant="secondary" onClick={() => setCreatedToken(null)}>{t("platformAdmin.tv.closeBtn")}</Button>
        </div>
      )}

      <Card>
        <div className="flex items-center justify-between mb-4">
          <span className="text-sm font-semibold">{t("platformAdmin.tv.header")}</span>
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={13} /> {t("platformAdmin.tv.newTokenBtn")}
          </Button>
        </div>

        {showCreate && (
          <div className="mb-4 p-4 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] space-y-3">
            <p className="text-xs font-semibold">{t("platformAdmin.tv.createFormTitle")}</p>
            <div className="space-y-2">
              <div>
                <label className="text-xs text-[var(--text-muted)] block mb-1">{t("platformAdmin.tv.tenantLabel")}</label>
                <select
                  className={inputCls}
                  value={newTenantId}
                  onChange={(e) => setNewTenantId(e.target.value)}
                >
                  <option value="">{t("platformAdmin.tv.selectPlaceholder")}</option>
                  {(tenantsQ.data ?? []).map((ten) => (
                    <option key={ten.tenant_id} value={ten.tenant_id}>
                      {ten.display_name || ten.tenant_id}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs text-[var(--text-muted)] block mb-1">{t("platformAdmin.tv.labelField")}</label>
                <input className={inputCls} placeholder={t("platformAdmin.tv.labelPlaceholder")} value={newLabel} onChange={(e) => setNewLabel(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-[var(--text-muted)] block mb-1">{t("platformAdmin.tv.expiryLabel")}</label>
                <input className={inputCls} type="number" min="1" value={newExpireDays} onChange={(e) => setNewExpireDays(e.target.value)} />
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => createMut.mutate()} disabled={!newTenantId || createMut.isPending}>
                {createMut.isPending ? <Spinner className="w-3 h-3" /> : null}
                {t("platformAdmin.tv.generateBtn")}
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setShowCreate(false)}>{t("platformAdmin.tv.cancelBtn")}</Button>
            </div>
          </div>
        )}

        {tokensQ.isLoading ? <Spinner /> : activeTokens.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.tv.noTokens")}</p>
        ) : (
          <div className="space-y-2">
            {activeTokens.map((tok) => (
              <div key={tok.principal_id} className="flex items-center gap-3 text-xs bg-[var(--surface-2)] rounded-lg px-3 py-2.5">
                <div className="flex-1 min-w-0">
                  <p className="font-medium truncate">{tok.label || "TV Display"}</p>
                  <p className="text-[var(--text-muted)] text-[10px] font-mono truncate">{tok.tenant_id}</p>
                </div>
                <span className="text-[var(--text-muted)] whitespace-nowrap">
                  {t("platformAdmin.tv.expiryPrefix")}{tok.expires_at ? new Date(tok.expires_at).toLocaleDateString(i18n.language) : t("platformAdmin.tv.neverExpires")}
                </span>
                <button
                  onClick={() => setConfirmRevoke(tok.principal_id)}
                  className="p-1 rounded hover:bg-[var(--surface)] text-[var(--red,#ef4444)]"
                  title={t("platformAdmin.tv.revokeTitle")}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))}
          </div>
        )}
      </Card>

      {confirmRevoke && (
        <ConfirmModal
          title={t("platformAdmin.tv.revokeTokenTitle")}
          description={t("platformAdmin.tv.revokeTokenDesc")}
          confirmLabel={t("platformAdmin.tv.revokeLabel")}
          destructive={true}
          onConfirm={() => revokeMut.mutate(confirmRevoke)}
          onCancel={() => setConfirmRevoke(null)}
        />
      )}
    </div>
  );
}

// ── Teia de relacionamentos ────────────────────────────────────────────────────

interface TreeOrg {
  organization_id: string;
  display_name: string | null;
  state: string;
  org_kind?: Organization["org_kind"];
}

interface TreeTenant {
  tenant_id: string;
  display_name: string;
  organization_id: string | null;
  state: string;
}

function TeiaTab() {
  const { t } = useTranslation();
  const orgsQ = useQuery({
    queryKey: ["teia-orgs"],
    queryFn: () => api.get<TreeOrg[]>("/api/v1/platform/organizations"),
  });
  const tenantsQ = useQuery({
    queryKey: ["teia-tenants"],
    queryFn: () => api.get<TreeTenant[]>("/api/v1/platform/tenants"),
  });
  const usersQ = useQuery({
    queryKey: ["teia-users"],
    queryFn: () => api.get<Principal[]>("/api/v1/platform/principals"),
  });

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const toggle = (id: string) =>
    setExpanded((prev) => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const isLoading = orgsQ.isLoading || tenantsQ.isLoading || usersQ.isLoading;

  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>;

  const orgs = orgsQ.data ?? [];
  const tenants = tenantsQ.data ?? [];
  const users = usersQ.data ?? [];

  // Group tenants by org, users by tenant
  const tenantsByOrg: Record<string, TreeTenant[]> = {};
  for (const ten of tenants) {
    const orgKey = ten.organization_id ?? "__no_org__";
    if (!tenantsByOrg[orgKey]) tenantsByOrg[orgKey] = [];
    tenantsByOrg[orgKey].push(ten);
  }
  const usersByTenant: Record<string, Principal[]> = {};
  for (const u of users) {
    if (!u.tenant_id) continue;
    if (!usersByTenant[u.tenant_id]) usersByTenant[u.tenant_id] = [];
    usersByTenant[u.tenant_id].push(u);
  }

  const kindIcon = (kind: string) => {
    if (kind === "platform_admin_principal") return "👑";
    if (kind === "display_principal") return "📺";
    return "👤";
  };

  const stateColor = (state: string) =>
    state === "active" ? "var(--green,#22c55e)" : state === "suspended" ? "var(--yellow,#f59e0b)" : "var(--text-muted)";

  return (
    <div className="space-y-2">
      <p className="text-xs text-[var(--text-muted)]">
        {t("platformAdmin.teia.orgCount", { count: orgs.length })} · {t("platformAdmin.teia.tenantCount", { count: tenants.length })} · {t("platformAdmin.teia.userCount", { count: users.length })}
      </p>

      {orgs.length === 0 ? (
        <Card><p className="text-xs text-[var(--text-muted)]">{t("platformAdmin.teia.noOrgs")}</p></Card>
      ) : (
        <div className="space-y-2">
          {orgs.map((org) => {
            const orgTenants = tenantsByOrg[org.organization_id] ?? [];
            const orgExpanded = expanded.has(org.organization_id);
            return (
              <div key={org.organization_id} className="rounded-xl border border-[var(--border)] overflow-hidden">
                {/* Org row */}
                <button
                  onClick={() => toggle(org.organization_id)}
                  className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-[var(--surface-2)] transition-colors"
                >
                  <span style={{ color: "var(--brand,#6366f1)" }}>
                    <Building2 size={15} />
                  </span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className="text-sm font-semibold truncate">{org.display_name || org.organization_id}</span>
                      {org.org_kind && (() => { const k = orgKindBadge(org.org_kind!, t); return <Badge variant={k.variant}>{k.label}</Badge>; })()}
                    </div>
                    <span className="text-[10px] font-mono text-[var(--text-muted)]">{org.organization_id}</span>
                  </div>
                  <span style={{ color: stateColor(org.state) }} className="text-xs">{org.state}</span>
                  <span className="text-xs text-[var(--text-muted)]">{t("platformAdmin.teia.tenantCount", { count: orgTenants.length })}</span>
                  <span className="text-[var(--text-muted)]">{orgExpanded ? "▲" : "▼"}</span>
                </button>

                {/* Tenants */}
                {orgExpanded && (
                  <div className="border-t border-[var(--border)] divide-y divide-[var(--border)]">
                    {orgTenants.length === 0 ? (
                      <p className="text-xs text-[var(--text-muted)] px-8 py-2">{t("platformAdmin.teia.noTenants")}</p>
                    ) : orgTenants.map((tenant) => {
                      const tenantUsers = usersByTenant[tenant.tenant_id] ?? [];
                      const tenantExpanded = expanded.has(tenant.tenant_id);
                      return (
                        <div key={tenant.tenant_id}>
                          <button
                            onClick={() => toggle(tenant.tenant_id)}
                            className="w-full flex items-center gap-3 px-8 py-2.5 text-left hover:bg-[var(--surface-2)] transition-colors"
                          >
                            <span style={{ color: "var(--text-muted)" }}><Server size={13} /></span>
                            <div className="flex-1 min-w-0">
                              <span className="text-xs font-medium truncate block">{tenant.display_name || tenant.tenant_id}</span>
                              <span className="text-[10px] font-mono text-[var(--text-muted)]">{tenant.tenant_id}</span>
                            </div>
                            <span style={{ color: stateColor(tenant.state) }} className="text-xs">{tenant.state}</span>
                            <span className="text-xs text-[var(--text-muted)]">{t("platformAdmin.teia.userCount", { count: tenantUsers.length })}</span>
                            <span className="text-[var(--text-muted)]">{tenantExpanded ? "▲" : "▼"}</span>
                          </button>

                          {/* Users */}
                          {tenantExpanded && (
                            <div className="px-14 py-2 space-y-1 bg-[var(--surface-2)]">
                              {tenantUsers.length === 0 ? (
                                <p className="text-[10px] text-[var(--text-muted)]">{t("platformAdmin.teia.noUsers")}</p>
                              ) : tenantUsers.map((u) => (
                                <div key={u.principal_id + (u.membership_id ?? "")} className="flex items-center gap-2 text-xs py-1">
                                  <span>{kindIcon(u.kind)}</span>
                                  <span className="flex-1 truncate">
                                    {u.display_name || u.email || u.principal_id}
                                  </span>
                                  {u.email && <span className="text-[10px] text-[var(--text-muted)] truncate max-w-[140px]">{u.email}</span>}
                                  <Badge variant={u.kind === "platform_admin_principal" ? "success" : "muted"}>
                                    {u.kind === "platform_admin_principal" ? "platform" : u.role || u.kind}
                                  </Badge>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Audit Log Tab ─────────────────────────────────────────────────────────────

interface AuditEvent {
  audit_event_id: string;
  tenant_id: string;
  action: string;
  actor_kind: string;
  actor_id: string;
  subject_type: string | null;
  subject_id: string | null;
  detail: Record<string, unknown> | null;
  occurred_at: string;
}

function actorBadge(kind: string): "success" | "warning" | "danger" | "muted" {
  if (kind === "platform_admin") return "warning";
  if (kind === "principal") return "success";
  if (kind === "system" || kind === "worker") return "muted";
  return "muted";
}

function AuditTab() {
  const { t } = useTranslation();
  const [filterTenant, setFilterTenant] = useState("");
  const [filterAction, setFilterAction] = useState("");
  const [limit, setLimit] = useState(50);

  const params = new URLSearchParams({ limit: String(limit) });
  if (filterTenant) params.set("tenant_id", filterTenant);
  if (filterAction) params.set("action", filterAction);

  const q = useQuery<AuditEvent[]>({
    queryKey: ["platform-audit", filterTenant, filterAction, limit],
    queryFn: () => api.get(`/api/v1/platform/audit?${params}`),
    refetchInterval: 15_000,
    retry: 1,
  });

  const events = q.data ?? [];

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <CardHeader>
          <span className="text-sm font-semibold">Audit Log</span>
          <span className="text-xs text-[var(--text-muted)]">cross-tenant · atualiza a cada 15s</span>
        </CardHeader>
        {q.isFetching && <Spinner className="w-3 h-3" />}
      </div>

      <div className="flex gap-2 flex-wrap">
        <input
          className="border border-[var(--border)] rounded-lg px-2 py-1 text-xs bg-[var(--surface)] w-48"
          placeholder="tenant_id"
          value={filterTenant}
          onChange={(e) => setFilterTenant(e.target.value.trim())}
        />
        <input
          className="border border-[var(--border)] rounded-lg px-2 py-1 text-xs bg-[var(--surface)] w-48"
          placeholder="action (ex: quota.exceeded)"
          value={filterAction}
          onChange={(e) => setFilterAction(e.target.value.trim())}
        />
        <select
          className="border border-[var(--border)] rounded-lg px-2 py-1 text-xs bg-[var(--surface)]"
          value={limit}
          onChange={(e) => setLimit(Number(e.target.value))}
        >
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>{n} eventos</option>
          ))}
        </select>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Erro ao carregar audit log</p>
      ) : events.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Nenhum evento encontrado.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[700px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th className="text-left px-2 py-1.5 font-medium">Quando</th>
                <th className="text-left px-2 py-1.5 font-medium">Tenant</th>
                <th className="text-left px-2 py-1.5 font-medium">Ação</th>
                <th className="text-left px-2 py-1.5 font-medium">Actor</th>
                <th className="text-left px-2 py-1.5 font-medium">Sujeito</th>
              </tr>
            </thead>
            <tbody>
              {events.map((ev) => (
                <tr key={ev.audit_event_id} className="border-b border-[var(--border)] hover:bg-[var(--surface-2)]">
                  <td className="px-2 py-1.5 text-[var(--text-muted)] whitespace-nowrap">
                    {new Date(ev.occurred_at).toLocaleString(i18n.language)}
                  </td>
                  <td className="px-2 py-1.5 font-mono text-[var(--text-muted)]" title={ev.tenant_id}>
                    {truncate(ev.tenant_id, 10)}
                  </td>
                  <td className="px-2 py-1.5 font-mono" style={{ color: "var(--text)" }}>{ev.action}</td>
                  <td className="px-2 py-1.5">
                    <Badge variant={actorBadge(ev.actor_kind)}>{ev.actor_kind}</Badge>
                    <span className="ml-1 text-[var(--text-muted)] font-mono">{truncate(ev.actor_id, 10)}</span>
                  </td>
                  <td className="px-2 py-1.5 text-[var(--text-muted)]">
                    {ev.subject_type ? `${ev.subject_type}:${truncate(ev.subject_id ?? "", 8)}` : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

// ── Quota Health Tab ──────────────────────────────────────────────────────────

interface QuotaItem { key: string; limit: number }
interface TenantHealth {
  tenant_id: string;
  display_name: string | null;
  state: string;
  plan_ref: string | null;
  quotas: QuotaItem[];
  member_count: number;
  source_count: number;
}

function quotaUsage(key: string, health: TenantHealth): number {
  if (key === "max_members") return health.member_count;
  if (key === "max_monitoring_sources") return health.source_count;
  return 0;
}

function QuotaHealthTab() {
  const q = useQuery<TenantHealth[]>({
    queryKey: ["platform-quota-health"],
    queryFn: () => api.get("/api/v1/platform/quota-health"),
    refetchInterval: 30_000,
    retry: 1,
  });

  const tenants = q.data ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Quota Health</span>
        <span className="text-xs text-[var(--text-muted)]">por tenant · atualiza a cada 30s</span>
        {q.isFetching && <Spinner className="w-3 h-3" />}
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Erro ao carregar quota health</p>
      ) : tenants.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Nenhum tenant ativo.</p>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
          {tenants.map((th) => (
            <Card key={th.tenant_id} className="flex flex-col gap-3 p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <span className="text-xs font-semibold">{th.display_name || th.tenant_id}</span>
                  <div className="text-[10px] text-[var(--text-muted)] font-mono">{truncate(th.tenant_id, 12)}</div>
                </div>
                <Badge variant={stateVariant(th.state)}>{th.state}</Badge>
              </div>

              {th.plan_ref && (
                <div className="flex items-center gap-1">
                  <Tag size={10} style={{ color: "var(--text-muted)" }} />
                  <span className="text-[10px] text-[var(--text-muted)]">{th.plan_ref}</span>
                </div>
              )}

              <div className="space-y-2">
                <QuotaBar label="Membros" used={th.member_count} limit={
                  th.quotas.find(q => q.key === "max_members")?.limit ?? -1
                } />
                <QuotaBar label="Sources" used={th.source_count} limit={
                  th.quotas.find(q => q.key === "max_monitoring_sources")?.limit ?? -1
                } />
                {th.quotas
                  .filter(q => q.key !== "max_members" && q.key !== "max_monitoring_sources")
                  .map((q) => (
                    <QuotaBar key={q.key} label={q.key} used={quotaUsage(q.key, th)} limit={q.limit} />
                  ))}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function QuotaBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const unlimited = limit === -1;
  const pct = unlimited ? 0 : Math.min(100, Math.round((used / Math.max(limit, 1)) * 100));
  const color = pct >= 90 ? "var(--red)" : pct >= 70 ? "var(--amber)" : "var(--brand)";

  return (
    <div className="space-y-0.5">
      <div className="flex justify-between text-[10px]">
        <span className="text-[var(--text-muted)]">{label}</span>
        <span style={{ color: unlimited ? "var(--text-muted)" : color }}>
          {used}{unlimited ? " / ∞" : ` / ${limit}`}
        </span>
      </div>
      {!unlimited && (
        <div className="h-1.5 bg-[var(--surface-2)] rounded-full overflow-hidden">
          <div
            className="h-full rounded-full transition-all"
            style={{ width: `${pct}%`, background: color }}
          />
        </div>
      )}
    </div>
  );
}

// ── Billing Overview Tab ──────────────────────────────────────────────────────

interface BillingContract {
  contract_id: string;
  account_id: string;
  plan_ref: string | null;
  state: string;
  effective_from: string | null;
  effective_until: string | null;
  org_name: string | null;
  days_remaining: number | null;
}

interface BillingOverview {
  total_active: number;
  expiring_soon: number;
  expired_or_ended: number;
  contracts: BillingContract[];
}

function daysBadge(days: number | null, state: string): "success" | "warning" | "danger" | "muted" {
  if (state === "ended" || state === "suspended") return "danger";
  if (days === null) return "muted";
  if (days <= 7) return "danger";
  if (days <= 30) return "warning";
  return "success";
}

function BillingTab() {
  const q = useQuery<BillingOverview>({
    queryKey: ["platform-billing"],
    queryFn: () => api.get("/api/v1/platform/billing-overview"),
    retry: 1,
  });

  const data = q.data;
  const contracts = data?.contracts ?? [];

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">Billing Overview</span>
        {q.isFetching && <Spinner className="w-3 h-3" />}
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Erro ao carregar billing</p>
      ) : (
        <>
          <div className="grid grid-cols-3 gap-3">
            {[
              { label: "Ativos", value: data?.total_active ?? 0, variant: "success" as const },
              { label: "Expiram em 30 dias", value: data?.expiring_soon ?? 0, variant: "warning" as const },
              { label: "Encerrados", value: data?.expired_or_ended ?? 0, variant: "danger" as const },
            ].map((stat) => (
              <Card key={stat.label} className="p-3 text-center">
                <div className="text-2xl font-bold" style={{ color: `var(--${stat.variant === "success" ? "green" : stat.variant === "warning" ? "amber" : "red"})` }}>
                  {stat.value}
                </div>
                <div className="text-[10px] text-[var(--text-muted)] mt-0.5">{stat.label}</div>
              </Card>
            ))}
          </div>

          <Card className="overflow-x-auto">
            <table className="w-full text-xs min-w-[640px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="text-left px-3 py-2 font-medium">Organização</th>
                  <th className="text-left px-3 py-2 font-medium">Plano</th>
                  <th className="text-left px-3 py-2 font-medium">Estado</th>
                  <th className="text-left px-3 py-2 font-medium">Vigência</th>
                  <th className="text-left px-3 py-2 font-medium">Dias restantes</th>
                </tr>
              </thead>
              <tbody>
                {contracts.map((c) => (
                  <tr key={c.contract_id} className="border-b border-[var(--border)] hover:bg-[var(--surface-2)]">
                    <td className="px-3 py-2 font-medium">{c.org_name || "—"}</td>
                    <td className="px-3 py-2 font-mono text-[var(--text-muted)]">{c.plan_ref || "—"}</td>
                    <td className="px-3 py-2">
                      <Badge variant={stateVariant(c.state)}>{c.state}</Badge>
                    </td>
                    <td className="px-3 py-2 text-[var(--text-muted)]">
                      {fmt(c.effective_from)} → {c.effective_until ? fmt(c.effective_until) : "∞"}
                    </td>
                    <td className="px-3 py-2">
                      <Badge variant={daysBadge(c.days_remaining, c.state)}>
                        {c.days_remaining === null ? "sem limite" : c.days_remaining < 0 ? "expirado" : `${c.days_remaining}d`}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        </>
      )}
    </div>
  );
}

// ── Marketplace Catalog Tab ───────────────────────────────────────────────────

interface CatalogIntegration {
  integration_id: string;
  name: string;
  description: string;
  category: string;
  icon_emoji: string;
  vendor: string;
  website_url: string | null;
  config_schema: Record<string, unknown>;
  is_enabled: boolean;
  created_at: string;
}

const MKT_CATEGORIES = ["monitoring", "alerting", "itsm", "chatops", "security", "automation", "storage", "other"];
const MKT_CATEGORY_LABELS: Record<string, string> = {
  monitoring: "Monitoramento", alerting: "Alertas", itsm: "ITSM",
  chatops: "ChatOps", security: "Segurança", automation: "Automação",
  storage: "Armazenamento", other: "Outros",
};

function MarketplaceCatalogTab() {
  const qc = useQueryClient();
  const { showToast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [editing, setEditing] = useState<CatalogIntegration | null>(null);
  const [form, setForm] = useState({
    integration_id: "", name: "", description: "", category: "other",
    icon_emoji: "🔌", vendor: "", website_url: "",
  });

  const { data: catalog = [], isLoading } = useQuery<CatalogIntegration[]>({
    queryKey: ["admin-marketplace-catalog"],
    queryFn: () => api.get<CatalogIntegration[]>("/api/v1/marketplace"),
  });

  const mutCreate = useMutation({
    mutationFn: (body: typeof form) =>
      api.post<CatalogIntegration>("/api/v1/marketplace/catalog", body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-marketplace-catalog"] });
      setShowCreate(false);
      setForm({ integration_id: "", name: "", description: "", category: "other", icon_emoji: "🔌", vendor: "", website_url: "" });
      showToast("Integração criada", "success");
    },
    onError: (e: Error) => showToast(e.message ?? "Erro ao criar", "error"),
  });

  const mutPatch = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Partial<CatalogIntegration> }) =>
      api.patch<CatalogIntegration>(`/api/v1/marketplace/catalog/${id}`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-marketplace-catalog"] });
      setEditing(null);
      showToast("Integração atualizada", "success");
    },
    onError: (e: Error) => showToast(e.message ?? "Erro ao atualizar", "error"),
  });

  const toggleEnabled = (item: CatalogIntegration) =>
    mutPatch.mutate({ id: item.integration_id, body: { is_enabled: !item.is_enabled } });

  const openEdit = (item: CatalogIntegration) => {
    setEditing(item);
    setForm({
      integration_id: item.integration_id,
      name: item.name,
      description: item.description,
      category: item.category,
      icon_emoji: item.icon_emoji,
      vendor: item.vendor,
      website_url: item.website_url ?? "",
    });
  };

  const handleSubmitCreate = (e: React.FormEvent) => {
    e.preventDefault();
    mutCreate.mutate(form);
  };

  const handleSubmitEdit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editing) return;
    const { integration_id: _, ...rest } = form;
    mutPatch.mutate({ id: editing.integration_id, body: rest });
  };

  const FormFields = () => (
    <div className="grid gap-3">
      {!editing && (
        <div>
          <label className="text-xs text-[var(--text-muted)] block mb-1">ID (imutável)</label>
          <input value={form.integration_id} onChange={(e) => setForm((f) => ({ ...f, integration_id: e.target.value }))}
            placeholder="int:slack" className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5" required />
        </div>
      )}
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-xs text-[var(--text-muted)] block mb-1">Nome</label>
          <input value={form.name} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
            placeholder="Slack" className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5" required />
        </div>
        <div>
          <label className="text-xs text-[var(--text-muted)] block mb-1">Vendor</label>
          <input value={form.vendor} onChange={(e) => setForm((f) => ({ ...f, vendor: e.target.value }))}
            placeholder="Slack Inc." className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5" />
        </div>
      </div>
      <div>
        <label className="text-xs text-[var(--text-muted)] block mb-1">Descrição</label>
        <textarea value={form.description} onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
          rows={2} placeholder="Envie alertas e notificações para canais Slack..."
          className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5 resize-none" />
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <label className="text-xs text-[var(--text-muted)] block mb-1">Categoria</label>
          <select value={form.category} onChange={(e) => setForm((f) => ({ ...f, category: e.target.value }))}
            className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5">
            {MKT_CATEGORIES.map((c) => <option key={c} value={c}>{MKT_CATEGORY_LABELS[c]}</option>)}
          </select>
        </div>
        <div>
          <label className="text-xs text-[var(--text-muted)] block mb-1">Emoji</label>
          <input value={form.icon_emoji} onChange={(e) => setForm((f) => ({ ...f, icon_emoji: e.target.value }))}
            placeholder="🔌" className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5" />
        </div>
        <div>
          <label className="text-xs text-[var(--text-muted)] block mb-1">Website</label>
          <input value={form.website_url} onChange={(e) => setForm((f) => ({ ...f, website_url: e.target.value }))}
            placeholder="https://..." type="url" className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface)] px-2 py-1.5" />
        </div>
      </div>
    </div>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-[var(--text-muted)]">
          Catálogo global de integrações — {catalog.length} integrações, {catalog.filter((i) => i.is_enabled).length} habilitadas
        </p>
        <Button size="sm" onClick={() => { setShowCreate(true); setEditing(null); }}>
          <Plus size={13} /> Nova integração
        </Button>
      </div>

      {showCreate && !editing && (
        <Card className="p-4">
          <h4 className="text-xs font-semibold mb-3">Nova integração no catálogo</h4>
          <form onSubmit={handleSubmitCreate} className="space-y-3">
            <FormFields />
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" type="button" onClick={() => setShowCreate(false)}>Cancelar</Button>
              <Button size="sm" type="submit" disabled={mutCreate.isPending}>
                {mutCreate.isPending ? "Criando…" : "Criar"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {editing && (
        <Card className="p-4">
          <h4 className="text-xs font-semibold mb-3">Editar: {editing.name}</h4>
          <form onSubmit={handleSubmitEdit} className="space-y-3">
            <FormFields />
            <div className="flex gap-2 justify-end">
              <Button size="sm" variant="ghost" type="button" onClick={() => setEditing(null)}>Cancelar</Button>
              <Button size="sm" type="submit" disabled={mutPatch.isPending}>
                {mutPatch.isPending ? "Salvando…" : "Salvar"}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {isLoading ? (
        <div className="text-xs text-[var(--text-muted)]">Carregando…</div>
      ) : (
        <div className="rounded-md border border-[var(--border)] overflow-hidden">
          <table className="w-full text-xs">
            <thead className="bg-[var(--surface-raised)]">
              <tr>
                <th className="text-left px-3 py-2 font-medium text-[var(--text-muted)]">Integração</th>
                <th className="text-left px-3 py-2 font-medium text-[var(--text-muted)]">Categoria</th>
                <th className="text-left px-3 py-2 font-medium text-[var(--text-muted)]">Vendor</th>
                <th className="text-left px-3 py-2 font-medium text-[var(--text-muted)]">ID</th>
                <th className="text-center px-3 py-2 font-medium text-[var(--text-muted)]">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {catalog.map((item) => (
                <tr key={item.integration_id} className="hover:bg-[var(--surface-hover)]">
                  <td className="px-3 py-2 flex items-center gap-2">
                    <span className="text-base">{item.icon_emoji}</span>
                    <div>
                      <div className="font-medium text-[var(--text)]">{item.name}</div>
                      <div className="text-[10px] text-[var(--text-muted)] max-w-[200px] truncate">{item.description}</div>
                    </div>
                  </td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">{MKT_CATEGORY_LABELS[item.category] ?? item.category}</td>
                  <td className="px-3 py-2 text-[var(--text-muted)]">{item.vendor || "—"}</td>
                  <td className="px-3 py-2 font-mono text-[10px] text-[var(--text-muted)]">{item.integration_id}</td>
                  <td className="px-3 py-2 text-center">
                    <button onClick={() => toggleEnabled(item)} title={item.is_enabled ? "Desabilitar" : "Habilitar"}
                      className="text-[var(--text-muted)] hover:text-[var(--brand)] transition-colors">
                      {item.is_enabled
                        ? <ToggleRight size={18} className="text-green-500" />
                        : <ToggleLeft size={18} className="text-gray-400" />}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => openEdit(item)} className="text-[var(--text-muted)] hover:text-[var(--brand)] transition-colors">
                      <Edit2 size={13} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

export type PlatformAdminTab = "orgs" | "tenants" | "plans" | "contracts" | "health" | "tv" | "teia" | "relationships" | "users" | "audit" | "quota-health" | "billing" | "marketplace";

type Tab = PlatformAdminTab;

interface PlatformAdminPageProps {
  tenantId: string;
  /** Quando fornecido, o componente opera em modo controlado (sem tabs próprias) */
  activeTab?: Tab;
  /** Callback para o shell externo pedir abertura do wizard MSP */
  onOpenMSPWizard?: (open: boolean) => void;
  /** Controlado externamente: se o wizard MSP está aberto */
  mspWizardOpen?: boolean;
}

export function PlatformAdminPage({ tenantId: _tenantId, activeTab: externalTab, onOpenMSPWizard, mspWizardOpen }: PlatformAdminPageProps) {
  const { t } = useTranslation();
  const [internalTab, setInternalTab] = useState<Tab>("orgs");
  const [internalWizard, setInternalWizard] = useState(false);

  const showMSPWizard = mspWizardOpen !== undefined ? mspWizardOpen : internalWizard;
  const setShowMSPWizard = onOpenMSPWizard ?? setInternalWizard;

  const controlled = externalTab !== undefined;
  const activeTab = controlled ? externalTab : internalTab;

  const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "orgs", label: t("platformAdmin.tabs.orgs"), icon: <Building2 size={14} /> },
    { id: "tenants", label: t("platformAdmin.tabs.tenants"), icon: <Server size={14} /> },
    { id: "relationships", label: t("platformAdmin.tabs.relationships"), icon: <GitMerge size={14} /> },
    { id: "users", label: t("platformAdmin.tabs.users"), icon: <Users size={14} /> },
    { id: "plans", label: t("platformAdmin.tabs.plans"), icon: <Package size={14} /> },
    { id: "contracts", label: t("platformAdmin.tabs.contracts"), icon: <FileText size={14} /> },
    { id: "health", label: t("platformAdmin.tabs.health"), icon: <Activity size={14} /> },
    { id: "tv", label: t("platformAdmin.tabs.tv"), icon: <Tv2 size={14} /> },
    { id: "teia", label: t("platformAdmin.tabs.teia"), icon: <Network size={14} /> },
    { id: "audit", label: "Audit Log", icon: <ClipboardList size={14} /> },
    { id: "quota-health", label: "Quota Health", icon: <BarChart3 size={14} /> },
    { id: "billing", label: "Billing", icon: <CreditCard size={14} /> },
    { id: "marketplace", label: "Marketplace", icon: <ShoppingBag size={14} /> },
  ];

  const panels = (
    <>
      {activeTab === "orgs" && <OrgsTab />}
      {activeTab === "tenants" && <TenantsTab />}
      {activeTab === "plans" && <PlansTab />}
      {activeTab === "contracts" && <ContractsTab />}
      {activeTab === "health" && <HealthTab />}
      {activeTab === "tv" && <TVModeTab />}
      {activeTab === "teia" && <TeiaTab />}
      {activeTab === "relationships" && <RelationshipsTab />}
      {activeTab === "users" && <UsersTab />}
      {activeTab === "audit" && <AuditTab />}
      {activeTab === "quota-health" && <QuotaHealthTab />}
      {activeTab === "billing" && <BillingTab />}
      {activeTab === "marketplace" && <MarketplaceCatalogTab />}
      {showMSPWizard && <MSPOnboardingWizard onClose={() => setShowMSPWizard(false)} />}
    </>
  );

  // Modo controlado: apenas renderiza o panel (o shell externo gerencia navegação)
  if (controlled) return <div className="p-6">{panels}</div>;

  // Modo standalone: inclui header + tabs próprias
  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold">Platform Admin</h2>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            {t("platformAdmin.subtitle")}
          </p>
        </div>
        <Button size="sm" onClick={() => setShowMSPWizard(true)}>
          <Plus size={13} /> {t("platformAdmin.newMspClient")}
        </Button>
      </div>

      <div className="flex items-center gap-1 border-b border-[var(--border)] overflow-x-auto">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setInternalTab(tab.id)}
            className={[
              "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap",
              "border-b-2 -mb-px transition-colors cursor-pointer",
              activeTab === tab.id
                ? "border-[var(--brand)] text-[var(--brand)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {panels}
    </div>
  );
}

export { type Tab as _PlatformAdminTabInternal };
