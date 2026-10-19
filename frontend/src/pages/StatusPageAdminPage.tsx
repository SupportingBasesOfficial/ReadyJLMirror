import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ExternalLink, Plus, Trash2, Globe, CheckCircle2, AlertTriangle, AlertOctagon, Wrench } from "lucide-react";

type ComponentStatus = "operational" | "degraded" | "outage" | "maintenance";

interface StatusComponent {
  name: string;
  description?: string;
  status: ComponentStatus;
}

interface StatusPageConfig {
  configured: boolean;
  status_slug?: string;
  public_name?: string;
  enabled?: boolean;
  updated_at?: string;
  public_url?: string;
  components?: StatusComponent[];
}

const STATUS_OPTIONS: { value: ComponentStatus; label: string; color: string }[] = [
  { value: "operational",  label: "Operacional",   color: "var(--green, #6fdc8c)" },
  { value: "degraded",     label: "Degradado",      color: "#e6b450" },
  { value: "outage",       label: "Interrupção",    color: "var(--red)" },
  { value: "maintenance",  label: "Manutenção",     color: "var(--text-muted)" },
];

const STATUS_ICON: Record<ComponentStatus, React.FC<{ className?: string }>> = {
  operational: CheckCircle2,
  degraded: AlertTriangle,
  outage: AlertOctagon,
  maintenance: Wrench,
};

function statusColor(s: ComponentStatus): string {
  return STATUS_OPTIONS.find(o => o.value === s)?.color ?? "var(--text-muted)";
}

function ComponentRow({
  comp,
  idx,
  onChange,
  onRemove,
}: {
  comp: StatusComponent;
  idx: number;
  onChange: (idx: number, next: StatusComponent) => void;
  onRemove: (idx: number) => void;
}) {
  const Icon = STATUS_ICON[comp.status];
  return (
    <div className="flex items-start gap-2 bg-[var(--surface-2)] rounded-lg px-3 py-2">
      <div style={{ color: statusColor(comp.status) }} className="mt-1.5 flex-shrink-0">
        <Icon className="w-3.5 h-3.5" />
      </div>
      <div className="flex-1 min-w-0 grid grid-cols-1 md:grid-cols-3 gap-2">
        <input
          value={comp.name}
          onChange={e => onChange(idx, { ...comp, name: e.target.value })}
          placeholder="Nome do componente"
          className="text-xs rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] placeholder:text-[var(--text-muted)] px-2 py-1.5 focus:outline-none focus:border-[var(--brand)] transition-colors"
        />
        <input
          value={comp.description ?? ""}
          onChange={e => onChange(idx, { ...comp, description: e.target.value })}
          placeholder="Descrição (opcional)"
          className="text-xs rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] placeholder:text-[var(--text-muted)] px-2 py-1.5 focus:outline-none focus:border-[var(--brand)] transition-colors"
        />
        <select
          value={comp.status}
          onChange={e => onChange(idx, { ...comp, status: e.target.value as ComponentStatus })}
          className="text-xs rounded border border-[var(--border)] bg-[var(--surface)] text-[var(--text)] px-2 py-1.5 focus:outline-none focus:border-[var(--brand)] transition-colors"
        >
          {STATUS_OPTIONS.map(o => (
            <option key={o.value} value={o.value}>{o.label}</option>
          ))}
        </select>
      </div>
      <button
        onClick={() => onRemove(idx)}
        className="mt-1 p-1 rounded hover:bg-[var(--surface)] text-[var(--text-muted)] hover:text-[var(--red)] transition-colors flex-shrink-0"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export function StatusPageAdminPage({ tenantId }: { tenantId: string }) {
  const { toast } = useToast();
  const qc = useQueryClient();

  const [slug, setSlug] = useState("");
  const [publicName, setPublicName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [components, setComponents] = useState<StatusComponent[]>([]);
  const [dirty, setDirty] = useState(false);

  const q = useQuery<StatusPageConfig>({
    queryKey: ["status-page-config", tenantId],
    queryFn: () => api.get<StatusPageConfig>(`/api/v1/platform/status-page?tenant_id=${tenantId}`),
  });

  useEffect(() => {
    if (!q.data || dirty) return;
    if (q.data.configured) {
      setSlug(q.data.status_slug ?? "");
      setPublicName(q.data.public_name ?? "");
      setEnabled(q.data.enabled ?? true);
      setComponents(q.data.components ?? []);
    }
  }, [q.data, dirty]);

  const saveMut = useMutation({
    mutationFn: () =>
      api.put(`/api/v1/platform/status-page?tenant_id=${tenantId}`, {
        status_slug: slug.trim(),
        public_name: publicName.trim(),
        enabled,
        components: components.filter(c => c.name.trim()),
      }),
    onSuccess: () => {
      toast("Página de status salva", "success");
      setDirty(false);
      qc.invalidateQueries({ queryKey: ["status-page-config", tenantId] });
    },
    onError: (e: Error) => toast(e.message || "Erro ao salvar", "error"),
  });

  const mark = <T,>(fn: (v: T) => void) => (v: T) => { fn(v); setDirty(true); };

  const addComponent = () => {
    setComponents(prev => [...prev, { name: "", status: "operational" }]);
    setDirty(true);
  };

  const updateComponent = (idx: number, next: StatusComponent) => {
    setComponents(prev => prev.map((c, i) => i === idx ? next : c));
    setDirty(true);
  };

  const removeComponent = (idx: number) => {
    setComponents(prev => prev.filter((_, i) => i !== idx));
    setDirty(true);
  };

  const publicUrl = q.data?.configured && q.data.public_url
    ? `${window.location.origin}${q.data.public_url}`
    : null;

  const canSave = slug.trim().length > 0 && publicName.trim().length > 0 && dirty;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2">
          <Globe className="w-4 h-4 text-[var(--brand)]" />
          <h2 className="text-sm font-semibold">Página de Status Pública</h2>
        </div>
        {q.data?.configured && (
          <Badge variant={q.data.enabled ? "success" : "muted"}>
            {q.data.enabled ? "Ativa" : "Desativada"}
          </Badge>
        )}
        {publicUrl && q.data?.enabled && (
          <a
            href={publicUrl}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 text-xs text-[var(--brand)] hover:underline"
          >
            <ExternalLink className="w-3 h-3" />
            Ver página pública
          </a>
        )}
      </div>

      {q.isLoading && <div className="flex justify-center py-12"><Spinner /></div>}
      {q.isError && <p className="text-xs text-[var(--red)]">Falha ao carregar configuração.</p>}

      {!q.isLoading && !q.isError && (
        <>
          {!q.data?.configured && (
            <div className="bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-4 py-3 text-xs text-[var(--text-muted)]">
              Nenhuma página de status configurada ainda. Preencha os campos abaixo para criar.
            </div>
          )}

          <Card>
            <CardHeader><span className="text-sm font-medium">Configuração Geral</span></CardHeader>
            <div className="px-4 pb-4 space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[10px] text-[var(--text-muted)] mb-1 uppercase tracking-wide">
                    Slug público
                  </label>
                  <div className="flex items-center rounded border border-[var(--border)] bg-[var(--surface-2)] overflow-hidden focus-within:border-[var(--brand)] transition-colors">
                    <span className="text-xs text-[var(--text-muted)] px-2 py-1.5 border-r border-[var(--border)] select-none">
                      /status/
                    </span>
                    <input
                      value={slug}
                      onChange={e => mark<string>(setSlug)(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                      placeholder="minha-empresa"
                      className="flex-1 text-xs bg-transparent text-[var(--text)] px-2 py-1.5 focus:outline-none font-mono"
                    />
                  </div>
                </div>
                <div>
                  <label className="block text-[10px] text-[var(--text-muted)] mb-1 uppercase tracking-wide">
                    Nome público
                  </label>
                  <input
                    value={publicName}
                    onChange={e => mark<string>(setPublicName)(e.target.value)}
                    placeholder="Ex: Acme Corp Status"
                    className="w-full text-xs rounded border border-[var(--border)] bg-[var(--surface-2)] text-[var(--text)] placeholder:text-[var(--text-muted)] px-3 py-1.5 focus:outline-none focus:border-[var(--brand)] transition-colors"
                  />
                </div>
              </div>
              <label className="flex items-center gap-2 cursor-pointer select-none w-fit">
                <input
                  type="checkbox"
                  checked={enabled}
                  onChange={e => mark<boolean>(setEnabled)(e.target.checked)}
                  className="accent-[var(--brand)] w-3.5 h-3.5"
                />
                <span className="text-xs text-[var(--text)]">Página pública ativa</span>
              </label>
            </div>
          </Card>

          <Card>
            <CardHeader>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">Componentes</span>
                <Button size="sm" variant="ghost" onClick={addComponent}>
                  <Plus className="w-3.5 h-3.5 mr-1" />
                  Adicionar
                </Button>
              </div>
            </CardHeader>
            <div className="px-4 pb-4 space-y-2">
              {components.length === 0 ? (
                <p className="text-xs text-[var(--text-muted)]">
                  Nenhum componente. Adicione serviços para exibir o status na página pública.
                </p>
              ) : (
                components.map((comp, idx) => (
                  <ComponentRow
                    key={idx}
                    comp={comp}
                    idx={idx}
                    onChange={updateComponent}
                    onRemove={removeComponent}
                  />
                ))
              )}
            </div>
          </Card>

          {publicUrl && (
            <Card>
              <CardHeader><span className="text-sm font-medium">Pré-visualização do Link</span></CardHeader>
              <div className="px-4 pb-4">
                <div className="flex items-center gap-2 bg-[var(--surface-2)] rounded-lg px-3 py-2">
                  <Globe className="w-3.5 h-3.5 text-[var(--brand)] flex-shrink-0" />
                  <code className="text-xs font-mono text-[var(--text)] flex-1 break-all">{publicUrl}</code>
                  <a href={publicUrl} target="_blank" rel="noreferrer"
                    className="flex-shrink-0 text-[var(--brand)] hover:text-[var(--brand)] transition-colors">
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>
              </div>
            </Card>
          )}

          <div className="flex justify-end">
            <Button
              disabled={!canSave || saveMut.isPending}
              onClick={() => saveMut.mutate()}
            >
              {saveMut.isPending && <Spinner className="w-3 h-3 mr-1" />}
              {q.data?.configured ? "Salvar alterações" : "Criar página de status"}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
