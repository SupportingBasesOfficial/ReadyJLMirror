import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";

interface Member {
  membership_id: string;
  principal_id: string;
  role: string;
  state: string;
  created_at: string;
}

interface TenantRole {
  role_name: string;
  permissions: string[];
  state: string;
  created_by: string | null;
  created_at: string;
}

const BUILTIN_ROLES = ["admin", "operator", "viewer", "auditor"];
const ALL_PERMISSIONS = [
  "tenant:read",
  "tenant:admin",
  "monitoring:read",
  "monitoring:operate",
  "alerting:read",
  "alerting:operate",
  "observability:read",
  "audit:read",
];

function fmt(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { dateStyle: "short" });
}

function roleVariant(role: string): "success" | "warning" | "muted" {
  if (role === "admin" || role === "tenant_admin") return "warning";
  if (role === "operator") return "success";
  return "muted";
}

function MembersSection() {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showAdd, setShowAdd] = useState(false);
  const [principalId, setPrincipalId] = useState("");
  const [role, setRole] = useState("viewer");
  const [addError, setAddError] = useState<string | null>(null);
  const [editingRoleId, setEditingRoleId] = useState<string | null>(null);
  const [editingRoleValue, setEditingRoleValue] = useState("");

  const q = useQuery({
    queryKey: ["team-members"],
    queryFn: () => api.get<Member[]>("/api/v1/tenant/members"),
    refetchInterval: 60_000,
  });

  const add = useMutation({
    mutationFn: () =>
      api.post("/api/v1/tenant/members", { principal_id: principalId.trim(), role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      setPrincipalId("");
      setRole("viewer");
      setShowAdd(false);
      setAddError(null);
    },
    onError: (e: Error) => setAddError(e.message),
  });

  const revoke = useMutation({
    mutationFn: (membership_id: string) =>
      api.post(`/api/v1/tenant/members/${membership_id}/revoke`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      toast("Acesso revogado", "success");
    },
    onError: () => toast("Erro ao revogar acesso", "error"),
  });

  const changeRole = useMutation({
    mutationFn: ({ membership_id, role }: { membership_id: string; role: string }) =>
      api.patch(`/api/v1/tenant/members/${membership_id}`, { role }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["team-members"] });
      setEditingRoleId(null);
      toast("Função atualizada", "success");
    },
    onError: () => toast("Erro ao atualizar função", "error"),
  });

  const members = q.data ?? [];
  const active = members.filter((m) => m.state !== "revoked");
  const revoked = members.filter((m) => m.state === "revoked");

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <CardHeader>
          <span className="text-sm font-semibold">Members</span>
          <span className="text-xs text-[var(--text-muted)]">
            {active.length} active
          </span>
        </CardHeader>
        <div className="flex items-center gap-2">
          {q.isFetching && <Spinner className="w-3 h-3" />}
          <Button size="sm" onClick={() => setShowAdd((v) => !v)}>
            {showAdd ? "Cancel" : "Add member"}
          </Button>
        </div>
      </div>

      {showAdd && (
        <div className="border border-[var(--border)] rounded-lg p-3 space-y-3">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">
                Principal ID
              </label>
              <input
                value={principalId}
                onChange={(e) => setPrincipalId(e.target.value)}
                placeholder="Email do usuário (ex: joao@empresa.com)"
                className="w-full px-2 py-1.5 rounded border border-[var(--border)]
                  bg-[var(--surface-2)] text-[var(--text)] font-mono text-xs"
              />
              <p className="text-[10px] text-[var(--text-muted)] mt-1">
                O sistema buscará o principal_id pelo email automaticamente.
              </p>
            </div>
            <div>
              <label className="block text-xs text-[var(--text-muted)] mb-1">Role</label>
              <select
                value={role}
                onChange={(e) => setRole(e.target.value)}
                className="w-full px-2 py-1.5 rounded border border-[var(--border)]
                  bg-[var(--surface-2)] text-[var(--text)] text-xs cursor-pointer"
              >
                {BUILTIN_ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
          </div>
          {addError && <p className="text-xs text-[var(--red)]">{addError}</p>}
          <Button
            size="sm"
            onClick={() => add.mutate()}
            disabled={!principalId.trim() || add.isPending}
          >
            {add.isPending ? <Spinner className="w-3 h-3" /> : "Add"}
          </Button>
        </div>
      )}

      {q.isLoading ? (
        <Spinner className="w-5 h-5" />
      ) : q.isError ? (
        <p className="text-xs text-[var(--red)]">Could not load members.</p>
      ) : active.length === 0 ? (
        <p className="text-xs text-[var(--text-muted)]">No active members.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-xs min-w-[480px]">
            <thead>
              <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                <th className="text-left px-2 py-1.5 font-medium">Principal</th>
                <th className="text-left px-2 py-1.5 font-medium">Role</th>
                <th className="text-left px-2 py-1.5 font-medium">Since</th>
                <th className="px-2 py-1.5" />
              </tr>
            </thead>
            <tbody>
              {active.map((m) => (
                <tr key={m.membership_id} className="border-b border-[var(--border)]">
                  <td className="px-2 py-2 font-mono text-[var(--text)] truncate max-w-[240px]">
                    {m.principal_id}
                  </td>
                  <td className="px-2 py-2">
                    {editingRoleId === m.membership_id ? (
                      <div className="flex items-center gap-1.5">
                        <select
                          autoFocus
                          value={editingRoleValue}
                          onChange={(e) => setEditingRoleValue(e.target.value)}
                          className="px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] text-xs cursor-pointer"
                        >
                          {BUILTIN_ROLES.map((r) => (
                            <option key={r} value={r}>{r}</option>
                          ))}
                        </select>
                        <button
                          onClick={() => changeRole.mutate({ membership_id: m.membership_id, role: editingRoleValue })}
                          disabled={changeRole.isPending || editingRoleValue === m.role}
                          className="text-[10px] text-[var(--brand)] hover:underline cursor-pointer disabled:opacity-50"
                        >
                          {changeRole.isPending ? <Spinner className="w-3 h-3" /> : "Salvar"}
                        </button>
                        <button
                          onClick={() => setEditingRoleId(null)}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer"
                        >
                          ✕
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1.5">
                        <Badge variant={roleVariant(m.role)}>{m.role}</Badge>
                        <button
                          onClick={() => { setEditingRoleId(m.membership_id); setEditingRoleValue(m.role); }}
                          className="text-[10px] text-[var(--text-muted)] hover:text-[var(--brand)] cursor-pointer underline"
                        >
                          Alterar função
                        </button>
                      </div>
                    )}
                  </td>
                  <td className="px-2 py-2 text-[var(--text-muted)]">
                    {fmt(m.created_at)}
                  </td>
                  <td className="px-2 py-2 text-right">
                    <button
                      onClick={() => revoke.mutate(m.membership_id)}
                      disabled={revoke.isPending}
                      className="text-[var(--red)] hover:underline text-xs cursor-pointer disabled:opacity-50"
                    >
                      Revoke
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {revoked.length > 0 && (
        <details className="text-xs">
          <summary className="text-[var(--text-muted)] cursor-pointer select-none">
            {revoked.length} revoked
          </summary>
          <div className="mt-1 space-y-0.5 pl-2">
            {revoked.map((m) => (
              <p key={m.membership_id} className="text-[var(--text-muted)] font-mono truncate">
                {m.principal_id} <span className="not-italic">·</span> {m.role}
              </p>
            ))}
          </div>
        </details>
      )}
    </Card>
  );
}

function RolesSection() {
  const qc = useQueryClient();
  const [showCreate, setShowCreate] = useState(false);
  const [roleName, setRoleName] = useState("");
  const [selectedPerms, setSelectedPerms] = useState<string[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["tenant-roles"],
    queryFn: () => api.get<TenantRole[]>("/api/v1/tenant/roles"),
    refetchInterval: 60_000,
  });

  const create = useMutation({
    mutationFn: () =>
      api.post("/api/v1/tenant/roles", {
        name: roleName.trim(),
        permissions: selectedPerms,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["tenant-roles"] });
      setRoleName("");
      setSelectedPerms([]);
      setShowCreate(false);
      setCreateError(null);
    },
    onError: (e: Error) => setCreateError(e.message),
  });

  const retire = useMutation({
    mutationFn: (role_name: string) =>
      api.post(`/api/v1/tenant/roles/${role_name}/retire`, {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["tenant-roles"] }),
  });

  const togglePerm = (p: string) =>
    setSelectedPerms((ps) =>
      ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]
    );

  const customRoles = (q.data ?? []).filter((r) => r.state !== "retired");
  const retiredRoles = (q.data ?? []).filter((r) => r.state === "retired");

  return (
    <Card className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <CardHeader>
          <span className="text-sm font-semibold">Custom roles</span>
          <span className="text-xs text-[var(--text-muted)]">
            {customRoles.length} active
          </span>
        </CardHeader>
        <div className="flex items-center gap-2">
          {q.isFetching && <Spinner className="w-3 h-3" />}
          <Button size="sm" onClick={() => setShowCreate((v) => !v)}>
            {showCreate ? "Cancel" : "Create role"}
          </Button>
        </div>
      </div>

      {showCreate && (
        <div className="border border-[var(--border)] rounded-lg p-3 space-y-3">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              Role name (slug)
            </label>
            <input
              value={roleName}
              onChange={(e) => setRoleName(e.target.value)}
              placeholder="e.g. readonly-ops"
              className="w-full px-2 py-1.5 rounded border border-[var(--border)]
                bg-[var(--surface-2)] text-[var(--text)] font-mono text-xs"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-2">
              Permissions
            </label>
            <div className="grid grid-cols-2 gap-1.5">
              {ALL_PERMISSIONS.map((p) => (
                <label key={p} className="flex items-center gap-1.5 cursor-pointer text-xs">
                  <input
                    type="checkbox"
                    checked={selectedPerms.includes(p)}
                    onChange={() => togglePerm(p)}
                  />
                  <span className="font-mono">{p}</span>
                </label>
              ))}
            </div>
          </div>
          {createError && <p className="text-xs text-[var(--red)]">{createError}</p>}
          <Button
            size="sm"
            onClick={() => create.mutate()}
            disabled={!roleName.trim() || selectedPerms.length === 0 || create.isPending}
          >
            {create.isPending ? <Spinner className="w-3 h-3" /> : "Create"}
          </Button>
        </div>
      )}

      <div className="text-xs">
        <p className="text-[var(--text-muted)] mb-2">Built-in roles</p>
        <div className="flex gap-2 flex-wrap mb-4">
          {BUILTIN_ROLES.map((r) => (
            <Badge key={r} variant={roleVariant(r)}>{r}</Badge>
          ))}
        </div>

        {q.isLoading ? (
          <Spinner className="w-4 h-4" />
        ) : customRoles.length > 0 ? (
          <>
            <p className="text-[var(--text-muted)] mb-2">Custom</p>
            <div className="space-y-2">
              {customRoles.map((r) => (
                <div
                  key={r.role_name}
                  className="flex items-start justify-between gap-3 p-2 rounded
                    bg-[var(--surface-2)] border border-[var(--border)]"
                >
                  <div className="space-y-1">
                    <span className="font-mono text-[var(--brand)]">
                      custom:{r.role_name}
                    </span>
                    <div className="flex gap-1 flex-wrap">
                      {r.permissions.map((p) => (
                        <Badge key={p} variant="muted">{p}</Badge>
                      ))}
                    </div>
                  </div>
                  <button
                    onClick={() => retire.mutate(r.role_name)}
                    disabled={retire.isPending}
                    className="text-[var(--text-muted)] hover:text-[var(--red)] text-xs
                      cursor-pointer disabled:opacity-50 whitespace-nowrap"
                  >
                    Retire
                  </button>
                </div>
              ))}
            </div>
          </>
        ) : (
          <p className="text-[var(--text-muted)]">No custom roles defined.</p>
        )}

        {retiredRoles.length > 0 && (
          <details className="mt-3">
            <summary className="text-[var(--text-muted)] cursor-pointer select-none">
              {retiredRoles.length} retired
            </summary>
            <div className="mt-1 pl-2 space-y-0.5">
              {retiredRoles.map((r) => (
                <p key={r.role_name} className="text-[var(--text-muted)] font-mono">
                  custom:{r.role_name}
                </p>
              ))}
            </div>
          </details>
        )}
      </div>
    </Card>
  );
}

export function TeamPage({ tenantId: _tenantId }: { tenantId: string }) {
  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Team</h2>
        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
          Tenant-scoped · requires tenant:admin
        </p>
      </div>
      <MembersSection />
      <RolesSection />
    </div>
  );
}
