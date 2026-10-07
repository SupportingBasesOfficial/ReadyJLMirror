import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ConfirmModal } from "@/components/ui/confirm-modal";
import { X, Plus, Building2, Server, FileText, Activity } from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────────

interface Organization {
  organization_id: string;
  display_name: string | null;
  state: string;
  created_at: string | null;
}

interface Tenant {
  tenant_id: string;
  name: string;
  slug: string;
  org_id: string;
  org_name?: string;
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

interface PlatformUsage {
  total_orgs?: number;
  total_tenants?: number;
  active_tenants?: number;
  suspended_tenants?: number;
  [key: string]: unknown;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { dateStyle: "short" });
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
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  const create = useMutation({
    mutationFn: () =>
      api.post<Organization>("/api/v1/platform/organizations", {
        organization_id: slug.trim(),
        display_name: displayName.trim() || name.trim() || undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["platform-organizations"] });
      toast("Organização criada", "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message || "Erro ao criar organização"),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">Criar organização</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            Nome <span className="text-[var(--red)]">*</span>
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
            Slug <span className="text-[var(--red)]">*</span>
          </label>
          <input
            className={inputCls}
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/\s+/g, "-"))}
            placeholder="acme-corp"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Display name</label>
          <input
            className={inputCls}
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Acme Corporation"
          />
        </div>
        {error && <p className="text-xs text-[var(--red)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => create.mutate()}
            disabled={!name.trim() || !slug.trim() || create.isPending}
            className="flex-1"
          >
            {create.isPending ? <Spinner className="w-3 h-3" /> : "Criar"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function OrgsTab() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showCreate, setShowCreate] = useState(false);
  const [confirmSuspend, setConfirmSuspend] = useState<Organization | null>(null);

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
      toast(vars.state === "suspended" ? "Organização suspensa" : "Organização ativada", "success");
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
          <span className="text-sm font-semibold">Organizações</span>
          <span className="text-xs text-[var(--text-muted)]">
            {orgs.length} org{orgs.length !== 1 ? "s" : ""}
          </span>
        </CardHeader>
        <div className="flex items-center gap-2">
          {q.isFetching && <Spinner className="w-3 h-3" />}
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={13} /> Criar organização
          </Button>
        </div>
      </div>

      {q.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">
          Não foi possível carregar as organizações. Verifique suas permissões.
        </p>
      ) : orgs.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Nenhuma organização cadastrada.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[520px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th className="text-left px-2 py-1.5 font-medium">Nome</th>
                <th className="text-left px-2 py-1.5 font-medium">Slug</th>
                <th className="text-left px-2 py-1.5 font-medium">Estado</th>
                <th className="text-left px-2 py-1.5 font-medium">Criado</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {orgs.map((org) => (
                <tr
                  key={org.organization_id}
                  className="border-b border-[var(--border)] hover:bg-[var(--surface-2)]"
                >
                  <td className="px-2 py-2 font-medium" style={{ color: "var(--text)" }}>
                    {org.display_name || org.organization_id}
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
                          Ativar
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => setConfirmSuspend(org)}
                        >
                          Suspender
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

      {showCreate && <CreateOrgModal onClose={() => setShowCreate(false)} />}

      {confirmSuspend && (
        <ConfirmModal
          title="Suspender organização"
          description={`Isso vai suspender "${confirmSuspend.display_name || confirmSuspend.organization_id}" e bloquear o acesso de todos os tenants associados.`}
          confirmLabel="Suspender"
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
      toast("Tenant criado", "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message || "Erro ao criar tenant"),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">Criar tenant</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            Organização <span className="text-[var(--red)]">*</span>
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
            Nome <span className="text-[var(--red)]">*</span>
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
            Slug <span className="text-[var(--red)]">*</span>
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
            {create.isPending ? <Spinner className="w-3 h-3" /> : "Criar"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function TenantsTab() {
  const [showCreate, setShowCreate] = useState(false);

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

  const tenants = tenantsQ.data ?? [];
  const orgs = orgsQ.data ?? [];

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <CardHeader>
          <span className="text-sm font-semibold">Tenants</span>
          <span className="text-xs text-[var(--text-muted)]">
            {tenants.length} tenant{tenants.length !== 1 ? "s" : ""}
          </span>
        </CardHeader>
        <div className="flex items-center gap-2">
          {tenantsQ.isFetching && <Spinner className="w-3 h-3" />}
          <Button size="sm" onClick={() => setShowCreate(true)}>
            <Plus size={13} /> Criar tenant
          </Button>
        </div>
      </div>

      {tenantsQ.isLoading ? (
        <div className="flex justify-center py-6">
          <Spinner />
        </div>
      ) : tenantsQ.isError ? (
        <p className="text-xs text-[var(--red)]">
          Não foi possível carregar os tenants. Verifique suas permissões.
        </p>
      ) : tenants.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">Nenhum tenant cadastrado.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[580px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th className="text-left px-2 py-1.5 font-medium">ID</th>
                <th className="text-left px-2 py-1.5 font-medium">Nome</th>
                <th className="text-left px-2 py-1.5 font-medium">Organização</th>
                <th className="text-left px-2 py-1.5 font-medium">Estado</th>
                <th className="text-left px-2 py-1.5 font-medium">Criado</th>
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => (
                <tr
                  key={t.tenant_id}
                  className="border-b border-[var(--border)] hover:bg-[var(--surface-2)]"
                >
                  <td
                    className="px-2 py-2 font-mono text-[var(--text-muted)]"
                    title={t.tenant_id}
                  >
                    {truncate(t.tenant_id, 8)}
                  </td>
                  <td className="px-2 py-2 font-medium" style={{ color: "var(--text)" }}>
                    {t.name}
                  </td>
                  <td className="px-2 py-2 text-[var(--text-muted)]">
                    {t.org_name ||
                      orgs.find((o) => o.organization_id === t.org_id)?.display_name ||
                      truncate(t.org_id)}
                  </td>
                  <td className="px-2 py-2">
                    <Badge variant={stateVariant(t.state)}>{t.state}</Badge>
                  </td>
                  <td className="px-2 py-2 text-[var(--text-muted)]">{fmt(t.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showCreate && orgs.length > 0 && (
        <CreateTenantModal orgs={orgs} onClose={() => setShowCreate(false)} />
      )}
      {showCreate && orgs.length === 0 && (
        <Modal onClose={() => setShowCreate(false)}>
          <p className="text-sm text-[var(--text-muted)] text-center py-4">
            Crie uma organização antes de criar um tenant.
          </p>
        </Modal>
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
      toast("Contrato criado", "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message || "Erro ao criar contrato"),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">Novo contrato</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            Conta comercial <span className="text-[var(--red)]">*</span>
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
          <label className="block text-xs text-[var(--text-muted)] mb-1">Plan ref</label>
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
            {create.isPending ? <Spinner className="w-3 h-3" /> : "Criar contrato"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancelar
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
      toast("Entitlement criado", "success");
      onClose();
    },
    onError: (e: Error) => setError(e.message || "Erro ao criar entitlement"),
  });

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">Novo entitlement</h3>
      <div className="space-y-3">
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            Contrato <span className="text-[var(--red)]">*</span>
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
            Capability <span className="text-[var(--red)]">*</span>
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
          <label className="block text-xs text-[var(--text-muted)] mb-1">Estado</label>
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
            {create.isPending ? <Spinner className="w-3 h-3" /> : "Criar entitlement"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function ContractsTab() {
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
            <span className="text-sm font-semibold">Contas Comerciais</span>
            {q.isFetching && <Spinner className="w-3 h-3" />}
          </div>
          <div className="flex items-center gap-2">
            <Button size="sm" variant="secondary" onClick={() => setShowCreateEntitlement(true)}>
              <Plus size={13} /> Novo entitlement
            </Button>
            <Button size="sm" onClick={() => setShowCreateContract(true)}>
              <Plus size={13} /> Novo contrato
            </Button>
          </div>
        </div>

        {q.isLoading ? (
          <div className="flex justify-center py-6">
            <Spinner />
          </div>
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)]">
            Não foi possível carregar as contas comerciais. Verifique suas permissões.
          </p>
        ) : accounts.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">Nenhuma conta comercial cadastrada.</p>
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
                    Contratos
                  </p>
                  {!account.contracts || account.contracts.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">Sem contratos.</p>
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
                    Entitlements
                  </p>
                  {!account.entitlements || account.entitlements.length === 0 ? (
                    <p className="text-xs text-[var(--text-muted)]">Sem entitlements.</p>
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
            Nenhuma conta comercial disponível.
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
            Crie um contrato antes de adicionar entitlements.
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
    queryFn: () => api.get<PlatformUsage>("/api/v1/platform/usage"),
    retry: 0,
  });

  const orgs = orgsQ.data ?? [];
  const tenants = tenantsQ.data ?? [];
  const activeTenants = tenants.filter((t) => t.state === "active").length;
  const suspendedTenants = tenants.filter((t) => t.state === "suspended").length;

  const isLoading = orgsQ.isLoading || tenantsQ.isLoading;

  return (
    <div className="space-y-4">
      {isLoading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : (
        <div className="grid gap-4 grid-cols-2 md:grid-cols-4">
          <StatCard
            label="Organizações"
            value={usageQ.data?.total_orgs ?? orgs.length}
          />
          <StatCard
            label="Tenants"
            value={usageQ.data?.total_tenants ?? tenants.length}
          />
          <StatCard
            label="Tenants ativos"
            value={usageQ.data?.active_tenants ?? activeTenants}
          />
          <StatCard
            label="Tenants suspensos"
            value={usageQ.data?.suspended_tenants ?? suspendedTenants}
          />
        </div>
      )}

      <Card className="flex flex-col gap-3">
        <CardHeader>
          <span className="text-sm font-semibold">Status da plataforma</span>
          {healthQ.isFetching && <Spinner className="w-3 h-3" />}
        </CardHeader>
        {healthQ.isLoading ? (
          <Spinner className="w-4 h-4" />
        ) : healthQ.isError ? (
          <p className="text-xs text-[var(--text-muted)]">
            Endpoint de health não disponível.
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

      {!usageQ.isError && usageQ.data && (
        <Card className="flex flex-col gap-3">
          <CardHeader>
            <span className="text-sm font-semibold">Usage consolidado</span>
          </CardHeader>
          <dl className="space-y-1.5">
            {Object.entries(usageQ.data).map(([key, value]) => (
              <div key={key} className="flex justify-between text-xs">
                <dt className="text-[var(--text-muted)]">{key.replace(/_/g, " ")}</dt>
                <dd
                  className="font-mono font-medium tabular-nums"
                  style={{ color: "var(--text)" }}
                >
                  {String(value)}
                </dd>
              </div>
            ))}
          </dl>
        </Card>
      )}
    </div>
  );
}

// ── Main ───────────────────────────────────────────────────────────────────────

type Tab = "orgs" | "tenants" | "contracts" | "health";

const TABS: { id: Tab; label: string; icon: React.ReactNode }[] = [
  { id: "orgs", label: "Organizações", icon: <Building2 size={14} /> },
  { id: "tenants", label: "Tenants", icon: <Server size={14} /> },
  { id: "contracts", label: "Contratos & Entitlements", icon: <FileText size={14} /> },
  { id: "health", label: "Saúde da Plataforma", icon: <Activity size={14} /> },
];

export function PlatformAdminPage({ tenantId: _tenantId }: { tenantId: string }) {
  const [activeTab, setActiveTab] = useState<Tab>("orgs");

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Platform Admin</h2>
        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
          Administração global da plataforma JLMirror · requer platform:admin
        </p>
      </div>

      <div className="flex items-center gap-1 border-b border-[var(--border)] overflow-x-auto">
        {TABS.map((t) => (
          <button
            key={t.id}
            onClick={() => setActiveTab(t.id)}
            className={[
              "inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap",
              "border-b-2 -mb-px transition-colors cursor-pointer",
              activeTab === t.id
                ? "border-[var(--brand)] text-[var(--brand)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]",
            ].join(" ")}
          >
            {t.icon}
            {t.label}
          </button>
        ))}
      </div>

      {activeTab === "orgs" && <OrgsTab />}
      {activeTab === "tenants" && <TenantsTab />}
      {activeTab === "contracts" && <ContractsTab />}
      {activeTab === "health" && <HealthTab />}
    </div>
  );
}
