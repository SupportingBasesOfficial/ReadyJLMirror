import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ShieldCheck, Plus, Rocket, Trash2, ChevronDown, ChevronRight,
  CheckCircle, XCircle, Clock, RefreshCw, Edit2, ArrowUp, ArrowDown,
  History, Eye
} from "lucide-react";

interface LastDeployment {
  deployment_id: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

interface Ruleset {
  ruleset_id: string;
  name: string;
  description: string | null;
  device_id: string | null;
  target_host: string;
  target_port: number;
  target_user: string;
  backend: string;
  credential_ref: string | null;
  enabled: boolean;
  created_at: string;
  rule_count: number;
  last_deployment: LastDeployment | null;
}

interface FirewallRule {
  rule_id: string;
  ruleset_id: string;
  position: number;
  action: string;
  direction: string;
  protocol: string | null;
  src_ip: string | null;
  dst_ip: string | null;
  src_port: string | null;
  dst_port: string | null;
  comment: string | null;
  enabled: boolean;
  created_at: string;
}

interface Deployment {
  deployment_id: string;
  status: string;
  triggered_by: string;
  output: string | null;
  error_message: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  duration_s: number | null;
}

interface Version {
  version_id: string;
  rule_count: number;
  comment: string | null;
  created_at: string;
  created_by: string;
}

const BACKENDS = ["iptables", "nftables", "ufw"];
const ACTIONS = ["ACCEPT", "DROP", "REJECT", "LOG"];
const DIRECTIONS = ["INPUT", "OUTPUT", "FORWARD"];
const PROTOCOLS = ["", "tcp", "udp", "icmp", "all"];

const ACTION_STYLES: Record<string, string> = {
  ACCEPT: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
  DROP: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  REJECT: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
  LOG: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
};

function StatusIcon({ status }: { status: string }) {
  if (status === "success") return <CheckCircle size={13} className="text-green-500" />;
  if (status === "failed") return <XCircle size={13} className="text-red-500" />;
  if (status === "running") return <RefreshCw size={13} className="text-blue-500 animate-spin" />;
  return <Clock size={13} className="text-yellow-500" />;
}

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    success: "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400",
    failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
    running: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
    pending: "bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400",
    cancelled: "bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400",
  };
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium ${cls[status] || cls.pending}`}>
      <StatusIcon status={status} />
      {status}
    </span>
  );
}

function RuleRow({
  rule,
  tenantId,
  onMoveUp,
  onMoveDown,
  onEdit,
  onDelete,
}: {
  rule: FirewallRule;
  tenantId: string;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <tr className="border-t border-gray-100 dark:border-gray-700/50 text-xs">
      <td className="px-2 py-1.5 text-gray-400 w-10 text-right">{rule.position}</td>
      <td className="px-2 py-1.5">
        <span className={`px-1.5 py-0.5 rounded font-mono font-medium text-xs ${ACTION_STYLES[rule.action] || ""}`}>
          {rule.action}
        </span>
      </td>
      <td className="px-2 py-1.5 text-gray-500">{rule.direction}</td>
      <td className="px-2 py-1.5 text-gray-500">{rule.protocol || "any"}</td>
      <td className="px-2 py-1.5 font-mono text-gray-700 dark:text-gray-300">
        {rule.src_ip || "any"}{rule.src_port ? `:${rule.src_port}` : ""}
      </td>
      <td className="px-2 py-1.5 font-mono text-gray-700 dark:text-gray-300">
        {rule.dst_ip || "any"}{rule.dst_port ? `:${rule.dst_port}` : ""}
      </td>
      <td className="px-2 py-1.5 text-gray-400 max-w-[160px] truncate">{rule.comment || ""}</td>
      <td className="px-2 py-1.5">
        {!rule.enabled && <span className="text-xs text-gray-400 italic">off</span>}
      </td>
      <td className="px-2 py-1.5">
        <div className="flex items-center gap-0.5">
          <button onClick={onMoveUp} className="p-0.5 text-gray-400 hover:text-gray-600"><ArrowUp size={12} /></button>
          <button onClick={onMoveDown} className="p-0.5 text-gray-400 hover:text-gray-600"><ArrowDown size={12} /></button>
          <button onClick={onEdit} className="p-0.5 text-gray-400 hover:text-blue-500"><Edit2 size={12} /></button>
          <button onClick={onDelete} className="p-0.5 text-gray-400 hover:text-red-500"><Trash2 size={12} /></button>
        </div>
      </td>
    </tr>
  );
}

function RuleModal({
  rule,
  rulesetId,
  tenantId,
  onClose,
}: {
  rule?: FirewallRule | null;
  rulesetId: string;
  tenantId: string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    position: rule?.position ?? 100,
    action: rule?.action ?? "ACCEPT",
    direction: rule?.direction ?? "INPUT",
    protocol: rule?.protocol ?? "",
    src_ip: rule?.src_ip ?? "",
    dst_ip: rule?.dst_ip ?? "",
    src_port: rule?.src_port ?? "",
    dst_port: rule?.dst_port ?? "",
    comment: rule?.comment ?? "",
    enabled: rule?.enabled ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload: Record<string, unknown> = {
        ...form,
        protocol: form.protocol || null,
        src_ip: form.src_ip || null,
        dst_ip: form.dst_ip || null,
        src_port: form.src_port || null,
        dst_port: form.dst_port || null,
        comment: form.comment || null,
      };
      const url = rule
        ? `/api/v1/firewall/rules/${rule.rule_id}`
        : `/api/v1/firewall/rulesets/${rulesetId}/rules`;
      const r = await fetch(url, {
        method: rule ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firewall-rules", rulesetId] });
      onClose();
    },
  });

  const sel = (key: keyof typeof form, label: string, options: string[]) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{label}</label>
      <select
        value={String(form[key])}
        onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
        className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {options.map((o) => <option key={o} value={o}>{o || "(qualquer)"}</option>)}
      </select>
    </div>
  );

  const txt = (key: keyof typeof form, label: string, placeholder?: string) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{label}</label>
      <input
        type="text"
        value={String(form[key])}
        onChange={(e) => setForm((p) => ({ ...p, [key]: e.target.value }))}
        placeholder={placeholder}
        className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm font-mono text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md">
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {rule ? "Editar regra" : "Nova regra"}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5 flex flex-col gap-3">
          <div className="grid grid-cols-3 gap-3">
            {sel("action", "Ação", ACTIONS)}
            {sel("direction", "Direção", DIRECTIONS)}
            {sel("protocol", "Protocolo", PROTOCOLS)}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {txt("src_ip", "IP origem", "0.0.0.0/0")}
            {txt("src_port", "Porta origem", "80")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {txt("dst_ip", "IP destino", "0.0.0.0/0")}
            {txt("dst_port", "Porta destino", "443")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Posição</label>
              <input
                type="number"
                value={form.position}
                onChange={(e) => setForm((p) => ({ ...p, position: Number(e.target.value) }))}
                className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 cursor-pointer pb-2">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))}
                  className="rounded"
                />
                <span className="text-sm text-gray-700 dark:text-gray-300">Habilitada</span>
              </label>
            </div>
          </div>
          {txt("comment", "Comentário", "ex: Permite HTTP de qualquer origem")}
          {save.isError && <p className="text-xs text-red-500">{String(save.error)}</p>}
        </div>
        <div className="p-5 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">Cancelar</button>
          <button
            onClick={() => save.mutate()}
            disabled={save.isPending}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

function RulesetModal({
  ruleset,
  onClose,
  tenantId,
}: {
  ruleset?: Ruleset | null;
  onClose: () => void;
  tenantId: string;
}) {
  const qc = useQueryClient();
  const [form, setForm] = useState({
    name: ruleset?.name ?? "",
    description: ruleset?.description ?? "",
    target_host: ruleset?.target_host ?? "",
    target_port: ruleset?.target_port ?? 22,
    target_user: ruleset?.target_user ?? "root",
    backend: ruleset?.backend ?? "iptables",
    credential_ref: ruleset?.credential_ref ?? "",
    enabled: ruleset?.enabled ?? true,
  });

  const save = useMutation({
    mutationFn: async () => {
      const payload = {
        ...form,
        description: form.description || null,
        credential_ref: form.credential_ref || null,
      };
      const url = ruleset ? `/api/v1/firewall/rulesets/${ruleset.ruleset_id}` : "/api/v1/firewall/rulesets";
      const r = await fetch(url, {
        method: ruleset ? "PUT" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["firewall-rulesets", tenantId] }); onClose(); },
  });

  const fld = (key: keyof typeof form, label: string, type = "text", extra?: React.InputHTMLAttributes<HTMLInputElement>) => (
    <div>
      <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">{label}</label>
      <input
        type={type}
        value={String(form[key])}
        onChange={(e) => setForm((p) => ({ ...p, [key]: type === "number" ? Number(e.target.value) : e.target.value }))}
        className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
        {...extra}
      />
    </div>
  );

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-gray-900 rounded-xl shadow-2xl w-full max-w-md">
        <div className="p-5 border-b border-gray-200 dark:border-gray-700 flex items-center justify-between">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {ruleset ? "Editar ruleset" : "Novo ruleset"}
          </h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">×</button>
        </div>
        <div className="p-5 flex flex-col gap-3">
          {fld("name", "Nome *")}
          {fld("description", "Descrição")}
          <div className="grid grid-cols-3 gap-3">
            {fld("target_host", "Host SSH")}
            {fld("target_port", "Porta", "number")}
            {fld("target_user", "Usuário")}
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 dark:text-gray-400 mb-1">Backend</label>
            <select
              value={form.backend}
              onChange={(e) => setForm((p) => ({ ...p, backend: e.target.value }))}
              className="w-full px-3 py-2 rounded border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {BACKENDS.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
          {fld("credential_ref", "Referência de credencial (opcional)", "text", { placeholder: "ex: cred-ssh-prod-1" })}
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={form.enabled} onChange={(e) => setForm((p) => ({ ...p, enabled: e.target.checked }))} className="rounded" />
            <span className="text-sm text-gray-700 dark:text-gray-300">Habilitado</span>
          </label>
          {save.isError && <p className="text-xs text-red-500">{String(save.error)}</p>}
        </div>
        <div className="p-5 border-t border-gray-200 dark:border-gray-700 flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800">Cancelar</button>
          <button onClick={() => save.mutate()} disabled={save.isPending || !form.name.trim()} className="px-4 py-2 rounded-lg text-sm font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50">
            {save.isPending ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>
    </div>
  );
}

type PanelView = "rules" | "deployments" | "versions";

function RulesetDetail({ ruleset, tenantId }: { ruleset: Ruleset; tenantId: string }) {
  const qc = useQueryClient();
  const [panel, setPanel] = useState<PanelView>("rules");
  const [ruleModal, setRuleModal] = useState<{ open: boolean; rule?: FirewallRule | null }>({ open: false });

  const { data: rules = [] } = useQuery<FirewallRule[]>({
    queryKey: ["firewall-rules", ruleset.ruleset_id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/firewall/rulesets/${ruleset.ruleset_id}/rules`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: panel === "rules",
  });

  const { data: deployments = [] } = useQuery<Deployment[]>({
    queryKey: ["firewall-deployments", ruleset.ruleset_id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/firewall/rulesets/${ruleset.ruleset_id}/deployments`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: panel === "deployments",
    refetchInterval: panel === "deployments" ? 10000 : false,
  });

  const { data: versions = [] } = useQuery<Version[]>({
    queryKey: ["firewall-versions", ruleset.ruleset_id],
    queryFn: async () => {
      const r = await fetch(`/api/v1/firewall/rulesets/${ruleset.ruleset_id}/versions`);
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    enabled: panel === "versions",
  });

  const deleteRule = useMutation({
    mutationFn: async (ruleId: string) => {
      await fetch(`/api/v1/firewall/rules/${ruleId}`, { method: "DELETE" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["firewall-rules", ruleset.ruleset_id] }); },
  });

  const moveRule = useMutation({
    mutationFn: async ({ ruleId, delta }: { ruleId: string; delta: number }) => {
      const idx = rules.findIndex((r) => r.rule_id === ruleId);
      if (idx < 0) return;
      const target = rules[idx + delta];
      if (!target) return;
      const newPos = target.position;
      const targetPos = rules[idx].position;
      await Promise.all([
        fetch(`/api/v1/firewall/rules/${ruleId}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: newPos }),
        }),
        fetch(`/api/v1/firewall/rules/${target.rule_id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ position: targetPos }),
        }),
      ]);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["firewall-rules", ruleset.ruleset_id] }); },
  });

  const deploy = useMutation({
    mutationFn: async () => {
      const r = await fetch(`/api/v1/firewall/rulesets/${ruleset.ruleset_id}/deploy`, { method: "POST" });
      if (!r.ok) throw new Error(await r.text());
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["firewall-rulesets", tenantId] });
      qc.invalidateQueries({ queryKey: ["firewall-deployments", ruleset.ruleset_id] });
      setPanel("deployments");
    },
  });

  const tabBtn = (id: PanelView, label: string) => (
    <button
      onClick={() => setPanel(id)}
      className={`px-3 py-1.5 text-xs rounded font-medium transition-colors ${
        panel === id
          ? "bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300"
          : "text-gray-500 hover:text-gray-700 dark:hover:text-gray-300"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="border-t border-gray-100 dark:border-gray-700 bg-gray-50/50 dark:bg-gray-800/30">
      {/* panel nav */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-gray-100 dark:border-gray-700">
        {tabBtn("rules", `Regras (${rules.length})`)}
        {tabBtn("deployments", "Deploys")}
        {tabBtn("versions", "Versões")}
        <div className="flex-1" />
        {panel === "rules" && (
          <button
            onClick={() => setRuleModal({ open: true, rule: null })}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-300"
          >
            <Plus size={12} /> Regra
          </button>
        )}
        <button
          onClick={() => { if (confirm("Deploy das regras atuais para o host?")) deploy.mutate(); }}
          disabled={deploy.isPending}
          className="flex items-center gap-1 px-2.5 py-1 rounded text-xs font-medium bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 ml-1"
        >
          <Rocket size={12} /> Deploy
        </button>
      </div>

      {/* Rules panel */}
      {panel === "rules" && (
        rules.length === 0 ? (
          <div className="p-4 text-xs text-gray-400 text-center">Nenhuma regra. Clique em "+ Regra" para adicionar.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-500 bg-gray-100 dark:bg-gray-800">
                  <th className="px-2 py-1.5 text-right font-medium w-10">#</th>
                  <th className="px-2 py-1.5 text-left font-medium">Ação</th>
                  <th className="px-2 py-1.5 text-left font-medium">Direção</th>
                  <th className="px-2 py-1.5 text-left font-medium">Protocolo</th>
                  <th className="px-2 py-1.5 text-left font-medium">Origem</th>
                  <th className="px-2 py-1.5 text-left font-medium">Destino</th>
                  <th className="px-2 py-1.5 text-left font-medium">Comentário</th>
                  <th className="px-2 py-1.5 text-left font-medium"></th>
                  <th className="px-2 py-1.5 w-24"></th>
                </tr>
              </thead>
              <tbody>
                {rules.map((rule, idx) => (
                  <RuleRow
                    key={rule.rule_id}
                    rule={rule}
                    tenantId={tenantId}
                    onMoveUp={() => idx > 0 && moveRule.mutate({ ruleId: rule.rule_id, delta: -1 })}
                    onMoveDown={() => idx < rules.length - 1 && moveRule.mutate({ ruleId: rule.rule_id, delta: 1 })}
                    onEdit={() => setRuleModal({ open: true, rule })}
                    onDelete={() => { if (confirm("Excluir regra?")) deleteRule.mutate(rule.rule_id); }}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* Deployments panel */}
      {panel === "deployments" && (
        deployments.length === 0 ? (
          <div className="p-4 text-xs text-gray-400 text-center">Nenhum deploy realizado.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 bg-gray-100 dark:bg-gray-800">
                <th className="px-3 py-1.5 text-left font-medium">Status</th>
                <th className="px-3 py-1.5 text-left font-medium">Iniciado</th>
                <th className="px-3 py-1.5 text-left font-medium">Duração</th>
                <th className="px-3 py-1.5 text-left font-medium">Trigger</th>
                <th className="px-3 py-1.5 text-left font-medium">Erro</th>
              </tr>
            </thead>
            <tbody>
              {deployments.map((d) => (
                <tr key={d.deployment_id} className="border-t border-gray-100 dark:border-gray-700/50">
                  <td className="px-3 py-1.5"><StatusBadge status={d.status} /></td>
                  <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">
                    {new Date(d.created_at).toLocaleString("pt-BR")}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500">
                    {d.duration_s !== null ? `${d.duration_s}s` : "—"}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500">{d.triggered_by}</td>
                  <td className="px-3 py-1.5 text-red-500 max-w-[200px] truncate" title={d.error_message || undefined}>
                    {d.error_message || ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {/* Versions panel */}
      {panel === "versions" && (
        versions.length === 0 ? (
          <div className="p-4 text-xs text-gray-400 text-center">Nenhuma versão. Realize um deploy para criar um snapshot.</div>
        ) : (
          <table className="w-full text-xs">
            <thead>
              <tr className="text-gray-500 bg-gray-100 dark:bg-gray-800">
                <th className="px-3 py-1.5 text-left font-medium">Data</th>
                <th className="px-3 py-1.5 text-left font-medium">Regras</th>
                <th className="px-3 py-1.5 text-left font-medium">Por</th>
                <th className="px-3 py-1.5 text-left font-medium">Comentário</th>
              </tr>
            </thead>
            <tbody>
              {versions.map((v) => (
                <tr key={v.version_id} className="border-t border-gray-100 dark:border-gray-700/50">
                  <td className="px-3 py-1.5 text-gray-600 dark:text-gray-300">
                    {new Date(v.created_at).toLocaleString("pt-BR")}
                  </td>
                  <td className="px-3 py-1.5 text-gray-500">{v.rule_count}</td>
                  <td className="px-3 py-1.5 text-gray-500">{v.created_by}</td>
                  <td className="px-3 py-1.5 text-gray-400">{v.comment || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )
      )}

      {ruleModal.open && (
        <RuleModal
          rule={ruleModal.rule}
          rulesetId={ruleset.ruleset_id}
          tenantId={tenantId}
          onClose={() => setRuleModal({ open: false })}
        />
      )}
    </div>
  );
}

export function FirewallPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [modal, setModal] = useState<{ open: boolean; ruleset?: Ruleset | null }>({ open: false });

  const { data: rulesets = [], isLoading } = useQuery<Ruleset[]>({
    queryKey: ["firewall-rulesets", tenantId],
    queryFn: async () => {
      const r = await fetch("/api/v1/firewall/rulesets");
      if (!r.ok) throw new Error("failed");
      return r.json();
    },
    refetchInterval: 20000,
  });

  const deleteRuleset = useMutation({
    mutationFn: async (id: string) => {
      await fetch(`/api/v1/firewall/rulesets/${id}`, { method: "DELETE" });
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["firewall-rulesets", tenantId] }); },
  });

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <ShieldCheck size={22} className="text-blue-500" />
          <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">Firewall</h1>
        </div>
        <button
          onClick={() => setModal({ open: true, ruleset: null })}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
        >
          <Plus size={15} /> Novo ruleset
        </button>
      </div>

      {isLoading ? (
        <div className="text-sm text-gray-400">Carregando rulesets...</div>
      ) : rulesets.length === 0 ? (
        <div className="text-center py-16 text-gray-400">
          <ShieldCheck size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">Nenhum ruleset configurado.</p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
          {rulesets.map((rs, idx) => {
            const isOpen = expanded.has(rs.ruleset_id);
            return (
              <div key={rs.ruleset_id} className={idx > 0 ? "border-t border-gray-100 dark:border-gray-700" : ""}>
                <div className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-700/30">
                  <button onClick={() => toggleExpand(rs.ruleset_id)} className="text-gray-400 hover:text-gray-600 flex-shrink-0">
                    {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                  </button>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-sm text-gray-900 dark:text-gray-100">{rs.name}</span>
                      <span className="text-xs text-gray-400 bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded font-mono">{rs.backend}</span>
                      {!rs.enabled && <span className="text-xs text-gray-400 italic">desabilitado</span>}
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5 font-mono">
                      {rs.target_user}@{rs.target_host}:{rs.target_port} · {rs.rule_count} regra{rs.rule_count !== 1 ? "s" : ""}
                    </p>
                  </div>
                  <div className="flex-shrink-0 text-right">
                    {rs.last_deployment ? (
                      <div className="flex flex-col items-end gap-0.5">
                        <StatusBadge status={rs.last_deployment.status} />
                        <span className="text-xs text-gray-400">
                          {new Date(rs.last_deployment.created_at).toLocaleDateString("pt-BR")}
                        </span>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-400">sem deploy</span>
                    )}
                  </div>
                  <div className="flex-shrink-0 flex items-center gap-1">
                    <button
                      onClick={() => setModal({ open: true, ruleset: rs })}
                      title="Editar"
                      className="p-1.5 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={() => { if (confirm(`Excluir ruleset "${rs.name}"?`)) deleteRuleset.mutate(rs.ruleset_id); }}
                      title="Excluir"
                      className="p-1.5 rounded text-gray-400 hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
                {isOpen && <RulesetDetail ruleset={rs} tenantId={tenantId} />}
              </div>
            );
          })}
        </div>
      )}

      {modal.open && (
        <RulesetModal
          ruleset={modal.ruleset}
          onClose={() => setModal({ open: false })}
          tenantId={tenantId}
        />
      )}
    </div>
  );
}
