import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { UserPlus, Copy, Check, X, ShieldOff, ShieldCheck, Trash2, KeyRound, Pencil } from "lucide-react";

interface User {
  principal_id: string;
  idp_subject_ref: string;
  active: boolean;
  created_at: string | null;
  role: string;
  membership_state: string;
  email: string;
  first_name: string;
  last_name: string;
  kc_enabled: boolean;
}

const ROLES = ["admin", "operator", "viewer", "auditor"] as const;
type Role = typeof ROLES[number];

function roleVariant(role: string): "warning" | "success" | "muted" {
  if (role === "admin" || role === "tenant_admin") return "warning";
  if (role === "operator") return "success";
  return "muted";
}

function fmt(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("pt-BR", { dateStyle: "short" });
}

function fullName(u: User): string {
  return [u.first_name, u.last_name].filter(Boolean).join(" ") || u.email || u.idp_subject_ref;
}

function initials(u: User): string {
  const name = [u.first_name, u.last_name].filter(Boolean).join(" ");
  if (name) return name.split(" ").map((w) => w[0]).join("").slice(0, 2).toUpperCase();
  if (u.email) return u.email[0].toUpperCase();
  return "?";
}

// ── Copy button ─────────────────────────────────────────────────────────────
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const el = document.createElement("textarea");
      el.value = text;
      document.body.appendChild(el);
      el.select();
      document.execCommand("copy");
      document.body.removeChild(el);
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button
      onClick={copy}
      className="inline-flex items-center gap-1 px-2 py-1 rounded text-xs
        border border-[var(--border)] bg-[var(--surface-2)]
        text-[var(--text-muted)] hover:text-[var(--text)] cursor-pointer transition-colors"
    >
      {copied ? <Check size={11} /> : <Copy size={11} />}
      {copied ? "Copiado" : "Copiar"}
    </button>
  );
}

// ── Modal overlay ────────────────────────────────────────────────────────────
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

// ── Invite modal ─────────────────────────────────────────────────────────────
function InviteModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (email: string, pwd: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [error, setError] = useState<string | null>(null);
  const qc = useQueryClient();

  const invite = useMutation({
    mutationFn: () =>
      api.post<{ principal_id: string; temp_password: string }>(
        "/api/admin/users",
        { email: email.trim(), first_name: firstName.trim(), last_name: lastName.trim(), role }
      ),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      onCreated(email.trim(), data.temp_password);
    },
    onError: (e: Error) => setError(e.message),
  });

  const inputCls =
    "w-full px-2.5 py-1.5 rounded border border-[var(--border)] " +
    "bg-[var(--surface-2)] text-[var(--text)] text-sm focus:outline-none " +
    "focus:ring-1 focus:ring-[var(--brand)]";

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">Convidar usuário</h3>
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              Nome <span className="text-[var(--red)]">*</span>
            </label>
            <input
              className={inputCls}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Maria"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">
              Sobrenome
            </label>
            <input
              className={inputCls}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Silva"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">
            Email <span className="text-[var(--red)]">*</span>
          </label>
          <input
            type="email"
            className={inputCls}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="maria@empresa.com"
          />
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Função</label>
          <select
            className={inputCls + " cursor-pointer"}
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
          >
            {ROLES.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
        {error && <p className="text-xs text-[var(--red)]">{error}</p>}
        <div className="flex gap-2 pt-1">
          <Button
            onClick={() => invite.mutate()}
            disabled={!email.trim() || !firstName.trim() || invite.isPending}
            className="flex-1"
          >
            {invite.isPending ? <Spinner className="w-3 h-3" /> : "Criar usuário"}
          </Button>
          <Button variant="ghost" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
        </div>
      </div>
    </Modal>
  );
}

// ── Temp password modal ───────────────────────────────────────────────────────
function TempPasswordModal({
  email,
  password,
  onClose,
}: {
  email: string;
  password: string;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose}>
      <div className="flex flex-col items-center gap-4 text-center">
        <div className="w-10 h-10 rounded-full bg-[var(--brand)] flex items-center justify-center">
          <UserPlus size={18} className="text-white" />
        </div>
        <div>
          <h3 className="text-sm font-semibold">Usuário criado</h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">
            Compartilhe estas credenciais com o usuário pelo WhatsApp ou telefone.
          </p>
        </div>
        <div className="w-full space-y-2 text-left">
          <div>
            <p className="text-xs text-[var(--text-muted)] mb-1">Email de acesso</p>
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)]">
              <span className="text-sm flex-1 font-mono">{email}</span>
              <CopyButton text={email} />
            </div>
          </div>
          <div>
            <p className="text-xs text-[var(--text-muted)] mb-1">Senha temporária</p>
            <div className="flex items-center gap-2 px-2.5 py-1.5 rounded border border-[var(--border)] bg-[var(--surface-2)]">
              <span className="text-sm flex-1 font-mono tracking-widest">{password}</span>
              <CopyButton text={password} />
            </div>
          </div>
        </div>
        <p className="text-[10px] text-[var(--text-muted)]">
          O usuário deverá trocar a senha no primeiro login.
        </p>
        <Button onClick={onClose} className="w-full">Entendido</Button>
      </div>
    </Modal>
  );
}

// ── Edit user modal ───────────────────────────────────────────────────────────
function EditUserModal({ user, onClose }: { user: User; onClose: () => void }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [firstName, setFirstName] = useState(user.first_name);
  const [lastName, setLastName] = useState(user.last_name);
  const [email, setEmail] = useState(user.email);
  const [emailError, setEmailError] = useState("");

  const update = useMutation({
    mutationFn: () =>
      api.patch(`/api/admin/users/${user.principal_id}`, {
        first_name: firstName.trim() || undefined,
        last_name: lastName.trim() || undefined,
        email: email.trim() !== user.email ? email.trim() : undefined,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      toast("Usuário atualizado", "success");
      onClose();
    },
    onError: (e: Error) => toast(e.message || "Erro ao atualizar", "error"),
  });

  const inputCls =
    "w-full px-2.5 py-1.5 rounded border border-[var(--border)] " +
    "bg-[var(--surface-2)] text-[var(--text)] text-sm focus:outline-none " +
    "focus:ring-1 focus:ring-[var(--brand)]";

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (email && (!email.includes("@") || email.length < 3)) {
      setEmailError("Email inválido.");
      return;
    }
    setEmailError("");
    update.mutate();
  }

  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-4">Editar usuário</h3>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Nome</label>
            <input
              className={inputCls}
              value={firstName}
              onChange={(e) => setFirstName(e.target.value)}
              placeholder="Maria"
            />
          </div>
          <div>
            <label className="block text-xs text-[var(--text-muted)] mb-1">Sobrenome</label>
            <input
              className={inputCls}
              value={lastName}
              onChange={(e) => setLastName(e.target.value)}
              placeholder="Silva"
            />
          </div>
        </div>
        <div>
          <label className="block text-xs text-[var(--text-muted)] mb-1">Email</label>
          <input
            type="email"
            className={inputCls}
            value={email}
            onChange={(e) => { setEmail(e.target.value); setEmailError(""); }}
          />
          {emailError && <p className="text-[11px] text-[var(--red)] mt-1">{emailError}</p>}
        </div>
        <div className="flex gap-2 pt-1">
          <Button type="submit" disabled={update.isPending} className="flex-1">
            {update.isPending ? <Spinner className="w-3 h-3" /> : "Salvar"}
          </Button>
          <Button variant="ghost" type="button" onClick={onClose} className="flex-1">
            Cancelar
          </Button>
        </div>
      </form>
    </Modal>
  );
}

// ── Confirm dialog ────────────────────────────────────────────────────────────
function ConfirmModal({
  title,
  message,
  confirmLabel,
  danger,
  isPending,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  isPending?: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose}>
      <h3 className="text-sm font-semibold mb-2">{title}</h3>
      <p className="text-xs text-[var(--text-muted)] mb-4">{message}</p>
      <div className="flex gap-2">
        <Button
          onClick={onConfirm}
          disabled={isPending}
          className={`flex-1 ${danger ? "bg-[var(--red)] hover:opacity-90" : ""}`}
        >
          {isPending ? <Spinner className="w-3 h-3" /> : confirmLabel}
        </Button>
        <Button variant="ghost" onClick={onClose} className="flex-1">
          Cancelar
        </Button>
      </div>
    </Modal>
  );
}

// ── Role cell (inline edit) ───────────────────────────────────────────────────
function RoleCell({ user }: { user: User }) {
  const [editing, setEditing] = useState(false);
  const [role, setRole] = useState(user.role as Role);
  const qc = useQueryClient();

  const update = useMutation({
    mutationFn: (r: Role) =>
      api.patch(`/api/admin/users/${user.principal_id}/role`, { role: r }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setEditing(false);
    },
  });

  if (!editing) {
    return (
      <button
        onClick={() => setEditing(true)}
        className="cursor-pointer"
        title="Clique para editar"
      >
        <Badge variant={roleVariant(user.role)}>{user.role}</Badge>
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <select
        autoFocus
        value={role}
        onChange={(e) => setRole(e.target.value as Role)}
        className="px-1 py-0.5 rounded border border-[var(--border)] bg-[var(--surface-2)]
          text-[var(--text)] text-xs cursor-pointer"
      >
        {ROLES.map((r) => (
          <option key={r} value={r}>{r}</option>
        ))}
      </select>
      <button
        onClick={() => update.mutate(role)}
        disabled={update.isPending}
        className="text-[var(--brand)] cursor-pointer disabled:opacity-50"
        title="Salvar"
      >
        {update.isPending ? <Spinner className="w-3 h-3" /> : <Check size={13} />}
      </button>
      <button
        onClick={() => { setRole(user.role as Role); setEditing(false); }}
        className="text-[var(--text-muted)] cursor-pointer"
        title="Cancelar"
      >
        <X size={13} />
      </button>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
export function UsersAdminPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [showInvite, setShowInvite] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [tempPwd, setTempPwd] = useState<{ email: string; pwd: string } | null>(null);
  const [confirmAction, setConfirmAction] = useState<{
    type: "deactivate" | "reactivate" | "delete";
    user: User;
  } | null>(null);

  const q = useQuery({
    queryKey: ["admin-users", tenantId],
    queryFn: () => api.get<User[]>("/api/admin/users"),
    refetchInterval: 60_000,
  });

  const deactivate = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/users/${id}/deactivate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setConfirmAction(null);
      toast("Usuário desativado", "success");
    },
    onError: (e: Error) => toast(e.message || "Erro na operação", "error"),
  });

  const reactivate = useMutation({
    mutationFn: (id: string) => api.post(`/api/admin/users/${id}/reactivate`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setConfirmAction(null);
      toast("Usuário reativado", "success");
    },
    onError: (e: Error) => toast(e.message || "Erro na operação", "error"),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/api/admin/users/${id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin-users"] });
      setConfirmAction(null);
      toast("Usuário removido", "success");
    },
    onError: (e: Error) => toast(e.message || "Erro na operação", "error"),
  });

  const resetPwd = useMutation({
    mutationFn: (u: User) =>
      api.post<{ temp_password: string }>(`/api/admin/users/${u.principal_id}/reset-password`, {}),
    onSuccess: (data, u) => {
      setTempPwd({ email: u.email, pwd: data.temp_password });
      toast("Senha redefinida", "success");
    },
    onError: (e: Error) => toast(e.message || "Erro ao redefinir senha", "error"),
  });

  const users = q.data ?? [];
  const active = users.filter((u) => u.active && u.membership_state === "active");
  const inactive = users.filter((u) => !u.active || u.membership_state !== "active");

  const handleConfirm = () => {
    if (!confirmAction) return;
    const id = confirmAction.user.principal_id;
    if (confirmAction.type === "deactivate") deactivate.mutate(id);
    else if (confirmAction.type === "reactivate") reactivate.mutate(id);
    else remove.mutate(id);
  };

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-base font-semibold">Usuários</h2>
        <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
          Gerenciamento de acesso · requer tenant:admin
        </p>
      </div>

      <Card className="flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <CardHeader>
            <span className="text-sm font-semibold">Usuários ativos</span>
            <span className="text-xs text-[var(--text-muted)]">{active.length} usuário{active.length !== 1 ? "s" : ""}</span>
          </CardHeader>
          <div className="flex items-center gap-2">
            {q.isFetching && <Spinner className="w-3 h-3" />}
            <Button size="sm" onClick={() => setShowInvite(true)}>
              <UserPlus size={13} />
              Convidar
            </Button>
          </div>
        </div>

        {q.isLoading ? (
          <Spinner className="w-5 h-5" />
        ) : q.isError ? (
          <p className="text-xs text-[var(--red)]">Não foi possível carregar os usuários.</p>
        ) : active.length === 0 ? (
          <p className="text-xs text-[var(--text-muted)]">Nenhum usuário ativo.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs min-w-[580px]">
              <thead>
                <tr className="border-b border-[var(--border)] text-[var(--text-muted)]">
                  <th className="text-left px-2 py-1.5 font-medium">Nome</th>
                  <th className="text-left px-2 py-1.5 font-medium">Email</th>
                  <th className="text-left px-2 py-1.5 font-medium">Função</th>
                  <th className="text-left px-2 py-1.5 font-medium">Criado</th>
                  <th className="px-2 py-1.5" />
                </tr>
              </thead>
              <tbody>
                {active.map((u) => (
                  <tr key={u.principal_id} className="border-b border-[var(--border)] hover:bg-[var(--surface-2)]">
                    <td className="px-2 py-2 font-medium" style={{ color: "var(--text)" }}>
                      <div className="flex items-center gap-2">
                        <div className="w-6 h-6 rounded-full bg-[var(--brand)]/15 flex items-center justify-center text-[10px] font-semibold text-[var(--brand)] flex-shrink-0">
                          {initials(u)}
                        </div>
                        <span>{fullName(u)}</span>
                      </div>
                    </td>
                    <td className="px-2 py-2 text-[var(--text-muted)] truncate max-w-[200px]">
                      {u.email || <span className="italic">sem email</span>}
                    </td>
                    <td className="px-2 py-2">
                      <RoleCell user={u} />
                    </td>
                    <td className="px-2 py-2 text-[var(--text-muted)]">
                      {fmt(u.created_at)}
                    </td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1 justify-end">
                        <button
                          onClick={() => setEditUser(u)}
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--brand)]
                            cursor-pointer transition-colors"
                          title="Editar usuário"
                        >
                          <Pencil size={13} />
                        </button>
                        <button
                          onClick={() => resetPwd.mutate(u)}
                          disabled={resetPwd.isPending}
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--brand)]
                            cursor-pointer transition-colors"
                          title="Redefinir senha"
                        >
                          <KeyRound size={13} />
                        </button>
                        <button
                          onClick={() => setConfirmAction({ type: "deactivate", user: u })}
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--yellow)]
                            cursor-pointer transition-colors"
                          title="Desativar"
                        >
                          <ShieldOff size={13} />
                        </button>
                        <button
                          onClick={() => setConfirmAction({ type: "delete", user: u })}
                          className="p-1 rounded text-[var(--text-muted)] hover:text-[var(--red)]
                            cursor-pointer transition-colors"
                          title="Remover"
                        >
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {inactive.length > 0 && (
          <details className="text-xs">
            <summary className="text-[var(--text-muted)] cursor-pointer select-none">
              {inactive.length} desativado{inactive.length !== 1 ? "s" : ""}
            </summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full min-w-[480px]">
                <tbody>
                  {inactive.map((u) => (
                    <tr key={u.principal_id} className="border-b border-[var(--border)]">
                      <td className="px-2 py-1.5 text-[var(--text-muted)]">{fullName(u)}</td>
                      <td className="px-2 py-1.5 text-[var(--text-muted)]">{u.email}</td>
                      <td className="px-2 py-1.5">
                        <Badge variant="muted">{u.role}</Badge>
                      </td>
                      <td className="px-2 py-1.5">
                        <button
                          onClick={() => setConfirmAction({ type: "reactivate", user: u })}
                          className="inline-flex items-center gap-1 text-[var(--brand)]
                            hover:underline cursor-pointer"
                        >
                          <ShieldCheck size={11} /> Reativar
                        </button>
                      </td>
                      <td className="px-2 py-1.5">
                        <button
                          onClick={() => setConfirmAction({ type: "delete", user: u })}
                          className="text-[var(--text-muted)] hover:text-[var(--red)] cursor-pointer"
                        >
                          <Trash2 size={11} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        )}
      </Card>

      {showInvite && (
        <InviteModal
          onClose={() => setShowInvite(false)}
          onCreated={(email, pwd) => {
            setShowInvite(false);
            setTempPwd({ email, pwd });
          }}
        />
      )}

      {editUser && (
        <EditUserModal user={editUser} onClose={() => setEditUser(null)} />
      )}

      {tempPwd && (
        <TempPasswordModal
          email={tempPwd.email}
          password={tempPwd.pwd}
          onClose={() => setTempPwd(null)}
        />
      )}

      {confirmAction && (
        <ConfirmModal
          title={
            confirmAction.type === "delete"
              ? "Remover usuário"
              : confirmAction.type === "deactivate"
              ? "Desativar usuário"
              : "Reativar usuário"
          }
          message={
            confirmAction.type === "delete"
              ? `Isso vai remover ${fullName(confirmAction.user)} do workspace e revogar o acesso. O registro de auditoria é preservado.`
              : confirmAction.type === "deactivate"
              ? `${fullName(confirmAction.user)} não conseguirá fazer login até ser reativado.`
              : `${fullName(confirmAction.user)} voltará a ter acesso ao workspace.`
          }
          confirmLabel={
            confirmAction.type === "delete"
              ? "Remover"
              : confirmAction.type === "deactivate"
              ? "Desativar"
              : "Reativar"
          }
          danger={confirmAction.type === "delete"}
          isPending={deactivate.isPending || reactivate.isPending || remove.isPending}
          onConfirm={handleConfirm}
          onClose={() => setConfirmAction(null)}
        />
      )}
    </div>
  );
}
