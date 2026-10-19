import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client";
import { Spinner } from "@/components/ui/spinner";
import {
  Activity, Bell, Shield, ChevronRight, Check,
  Search, CheckSquare, Square, AlertCircle, X,
} from "lucide-react";

interface DiscoveredGroup { groupid: string; name: string | null }

type WizardStep = "source" | "channels" | "policies";

function slugify(s: string) {
  return s.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9-]/g, "").slice(0, 40) || "cred-binding";
}

interface Props {
  tenantId: string;
  hasSources: boolean;
}

export function SetupWizard({ tenantId, hasSources }: Props) {
  const doneKey = `jlm_wizard_done_${tenantId}`;
  const stepKey = `jlm_wizard_step_${tenantId}`;

  const [done, setDone] = useState(() => {
    try { return localStorage.getItem(doneKey) === "1"; } catch { return false; }
  });
  const [step, setStep] = useState<WizardStep>(() => {
    try {
      const s = localStorage.getItem(stepKey);
      if (s === "channels" || s === "policies") return s;
    } catch { /* */ }
    return "source";
  });

  // Source form state
  const [form, setForm] = useState({ display_name: "", provider_base_url: "", api_token: "", credential_binding_ref: "" });
  const [discoveredGroups, setDiscoveredGroups] = useState<DiscoveredGroup[] | null>(null);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverError, setDiscoverError] = useState<string | null>(null);
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [submitLoading, setSubmitLoading] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [sourceAdded, setSourceAdded] = useState(false);

  const canDiscover = form.provider_base_url.trim().length > 0 && form.api_token.trim().length > 0;
  const canSubmit = form.display_name.trim().length > 0 && form.provider_base_url.trim().length > 0 && form.api_token.trim().length > 0;

  // Auto-advance from source → channels when hasSources becomes true
  useEffect(() => {
    if (step === "source" && hasSources && !done) {
      advanceTo("channels");
    }
  }, [hasSources, step, done]);

  if (done) return null;

  const advanceTo = (next: WizardStep) => {
    setStep(next);
    try { localStorage.setItem(stepKey, next); } catch { /* */ }
  };

  const dismiss = () => {
    try { localStorage.setItem(doneKey, "1"); } catch { /* */ }
    setDone(true);
  };

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

  const toggleGroup = (id: string) => {
    setSelectedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!discoveredGroups) return;
    setSelectedGroups(
      selectedGroups.size === discoveredGroups.length
        ? new Set()
        : new Set(discoveredGroups.map((g) => g.groupid))
    );
  };

  const submitSource = async () => {
    setSubmitLoading(true);
    setSubmitError(null);
    try {
      const groups = discoveredGroups
        ? [...selectedGroups].map((id) => discoveredGroups.find((g) => g.groupid === id)?.name ?? id).filter(Boolean)
        : [];
      await api.post("/api/v1/monitoring/sources", {
        display_name: form.display_name,
        provider_base_url: form.provider_base_url,
        api_token: form.api_token,
        credential_binding_ref: form.credential_binding_ref || slugify(form.display_name),
        host_group_refs: groups.length > 0 ? groups : undefined,
      });
      setSourceAdded(true);
      // hasSources will become true via SSE → useEffect auto-advances
    } catch (err: unknown) {
      const e = err as { detail?: string; message?: string };
      setSubmitError(e?.detail ?? e?.message ?? "Erro ao adicionar fonte.");
    } finally {
      setSubmitLoading(false);
    }
  };

  const STEPS: { id: WizardStep; label: string; Icon: React.ElementType }[] = [
    { id: "source", label: "Conectar fonte", Icon: Activity },
    { id: "channels", label: "Notificações", Icon: Bell },
    { id: "policies", label: "Políticas", Icon: Shield },
  ];

  const stepIndex = STEPS.findIndex((s) => s.id === step);

  return (
    <div style={{
      border: "1px solid var(--border)", borderRadius: 14, overflow: "hidden",
      background: "color-mix(in srgb, var(--brand) 3%, var(--surface))",
    }}>
      {/* Header */}
      <div style={{
        display: "flex", alignItems: "center", justifyContent: "space-between",
        padding: "16px 20px", borderBottom: "1px solid var(--border)",
        background: "color-mix(in srgb, var(--brand) 6%, var(--surface))",
      }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text)" }}>
            {step === "source" ? "Bem-vindo ao JLMirror 👋" : "Configuração inicial"}
          </div>
          <div style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 2 }}>
            {step === "source"
              ? "Conecte sua primeira fonte de monitoramento para começar."
              : step === "channels"
                ? "Fonte conectada! Configure agora onde receber alertas."
                : "Quase lá! Defina sua primeira política de alertas."}
          </div>
        </div>
        <button
          onClick={dismiss}
          title="Pular configuração"
          style={{ background: "none", border: "none", cursor: "pointer", color: "var(--text-muted)", padding: 4, display: "flex" }}
        >
          <X size={15} />
        </button>
      </div>

      {/* Step indicator */}
      <div style={{ display: "flex", alignItems: "center", padding: "12px 20px", gap: 0, borderBottom: "1px solid var(--border)" }}>
        {STEPS.map(({ id, label, Icon }, i) => {
          const isActive = id === step;
          const isDone = i < stepIndex;
          return (
            <div key={id} style={{ display: "flex", alignItems: "center", gap: 0, flex: i < STEPS.length - 1 ? 1 : undefined }}>
              <div style={{ display: "flex", alignItems: "center", gap: 7 }}>
                <div style={{
                  width: 22, height: 22, borderRadius: "50%", flexShrink: 0,
                  display: "flex", alignItems: "center", justifyContent: "center",
                  background: isDone
                    ? "var(--green, #22c55e)"
                    : isActive
                      ? "var(--brand)"
                      : "var(--surface-2, #262c3a)",
                  border: isActive ? "2px solid var(--brand)" : isDone ? "none" : "1px solid var(--border)",
                  transition: "all 0.2s",
                }}>
                  {isDone
                    ? <Check size={11} color="#fff" />
                    : isActive
                      ? <Icon size={11} color="#fff" />
                      : <span style={{ fontSize: 10, fontWeight: 700, color: "var(--text-muted)" }}>{i + 1}</span>}
                </div>
                <span style={{
                  fontSize: 11, fontWeight: isActive ? 600 : 400,
                  color: isActive ? "var(--text)" : isDone ? "var(--green, #22c55e)" : "var(--text-muted)",
                  whiteSpace: "nowrap",
                }}>
                  {label}
                </span>
              </div>
              {i < STEPS.length - 1 && (
                <div style={{ flex: 1, height: 1, background: "var(--border)", margin: "0 10px" }} />
              )}
            </div>
          );
        })}
      </div>

      {/* Step content */}
      <div style={{ padding: "20px" }}>

        {/* ── Step 1: Source form ── */}
        {step === "source" && (
          sourceAdded ? (
            <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 13, color: "var(--green, #22c55e)" }}>
              <Check size={16} />
              Fonte adicionada! Aguardando sincronização inicial…
              <Spinner className="w-3 h-3 ml-1" />
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <WizardField label="Nome da fonte *">
                  <input type="text" placeholder="Ex: Produção - Cliente X" value={form.display_name}
                    onChange={(e) => setForm((f) => ({ ...f, display_name: e.target.value }))} />
                </WizardField>
                <WizardField label={`Referência`} hint={`Auto: "${form.credential_binding_ref || slugify(form.display_name) || "cred-binding"}"`}>
                  <input type="text" placeholder={form.credential_binding_ref || slugify(form.display_name) || "cred-binding"}
                    value={form.credential_binding_ref}
                    onChange={(e) => setForm((f) => ({ ...f, credential_binding_ref: e.target.value }))} />
                </WizardField>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <WizardField label="URL do Zabbix *">
                  <input type="url" placeholder="https://zabbix.exemplo.com" value={form.provider_base_url}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, provider_base_url: e.target.value }));
                      setDiscoveredGroups(null); setDiscoverError(null); setSelectedGroups(new Set());
                    }} />
                </WizardField>
                <WizardField label="Token de API *">
                  <input type="password" placeholder="Token do Zabbix (User → API tokens)" value={form.api_token}
                    onChange={(e) => {
                      setForm((f) => ({ ...f, api_token: e.target.value }));
                      setDiscoveredGroups(null); setDiscoverError(null); setSelectedGroups(new Set());
                    }} />
                </WizardField>
              </div>

              {/* Discover groups */}
              <div>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>
                    Grupos de hosts
                    <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>
                      {discoveredGroups
                        ? `${selectedGroups.size} de ${discoveredGroups.length} selecionados`
                        : "deixe vazio para todos"}
                    </span>
                  </span>
                  <button
                    type="button" onClick={discoverGroups} disabled={!canDiscover || discoverLoading}
                    style={{
                      display: "flex", alignItems: "center", gap: 5, padding: "4px 10px",
                      borderRadius: 6, fontSize: 11, fontWeight: 600, cursor: canDiscover && !discoverLoading ? "pointer" : "default",
                      background: canDiscover ? "var(--brand)" : "var(--surface-2, #262c3a)",
                      color: canDiscover ? "#fff" : "var(--text-muted)",
                      border: canDiscover ? "none" : "1px solid var(--border)", opacity: discoverLoading ? 0.7 : 1,
                    }}
                  >
                    {discoverLoading ? <Spinner className="w-3 h-3" /> : <Search size={11} />}
                    {discoverLoading ? "Buscando…" : "Buscar grupos"}
                  </button>
                </div>

                {discoverError && (
                  <div style={{
                    display: "flex", alignItems: "flex-start", gap: 7, padding: "8px 12px",
                    borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
                    fontSize: 12, color: "#f87171", marginBottom: 8,
                  }}>
                    <AlertCircle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                    {discoverError}
                  </div>
                )}

                {discoveredGroups && discoveredGroups.length > 0 && (
                  <div style={{ border: "1px solid var(--border)", borderRadius: 8, maxHeight: 160, overflowY: "auto", background: "var(--bg)" }}>
                    <button type="button" onClick={toggleAll} style={{
                      width: "100%", display: "flex", alignItems: "center", gap: 8,
                      padding: "6px 12px", background: "none", border: "none",
                      borderBottom: "1px solid var(--border)", cursor: "pointer",
                      fontSize: 11, fontWeight: 600, color: "var(--text-muted)", textAlign: "left",
                    }}>
                      {selectedGroups.size === discoveredGroups.length
                        ? <CheckSquare size={13} style={{ color: "var(--brand)" }} />
                        : <Square size={13} />}
                      Todos ({discoveredGroups.length})
                    </button>
                    {discoveredGroups.map((g) => {
                      const checked = selectedGroups.has(g.groupid);
                      return (
                        <button key={g.groupid} type="button" onClick={() => toggleGroup(g.groupid)} style={{
                          width: "100%", display: "flex", alignItems: "center", gap: 8,
                          padding: "5px 12px", background: checked ? "rgba(99,102,241,0.08)" : "none",
                          border: "none", borderBottom: "1px solid var(--border)",
                          cursor: "pointer", fontSize: 12, color: "var(--text)", textAlign: "left",
                        }}>
                          {checked
                            ? <CheckSquare size={13} style={{ color: "var(--brand)", flexShrink: 0 }} />
                            : <Square size={13} style={{ flexShrink: 0, color: "var(--text-muted)" }} />}
                          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {g.name ?? g.groupid}
                          </span>
                          <span style={{ fontSize: 10, color: "var(--text-muted)" }}>#{g.groupid}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>

              {submitError && (
                <div style={{
                  display: "flex", alignItems: "flex-start", gap: 7, padding: "8px 12px",
                  borderRadius: 8, background: "rgba(239,68,68,0.1)", border: "1px solid rgba(239,68,68,0.25)",
                  fontSize: 12, color: "#f87171",
                }}>
                  <AlertCircle size={13} style={{ marginTop: 1, flexShrink: 0 }} />
                  {submitError}
                </div>
              )}

              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <button
                  onClick={dismiss}
                  style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                >
                  Pular configuração
                </button>
                <button
                  onClick={submitSource}
                  disabled={!canSubmit || submitLoading}
                  style={{
                    display: "flex", alignItems: "center", gap: 6,
                    padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                    background: "var(--brand)", color: "#fff", border: "none",
                    cursor: canSubmit && !submitLoading ? "pointer" : "default",
                    opacity: !canSubmit ? 0.5 : 1,
                  }}
                >
                  {submitLoading && <Spinner className="w-3 h-3" />}
                  Conectar fonte
                </button>
              </div>
            </div>
          )
        )}

        {/* ── Step 2: Channels ── */}
        {step === "channels" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{
              display: "flex", alignItems: "flex-start", gap: 14, padding: "14px",
              background: "var(--surface-2, #262c3a)", border: "1px solid var(--border)", borderRadius: 10,
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8, flexShrink: 0, background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Bell size={16} style={{ color: "var(--brand)" }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                  Configure canais de notificação
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
                  Defina onde receber alertas — Slack, Teams, e-mail, webhook ou SMS. Sem canais configurados, alertas ficam apenas no painel.
                </div>
                <Link to="/channels" style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 12, fontWeight: 500, color: "var(--brand)", textDecoration: "none",
                }}>
                  Abrir Canais de Notificação <ChevronRight size={13} />
                </Link>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <button onClick={dismiss} style={{ fontSize: 12, color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
                Pular configuração
              </button>
              <button
                onClick={() => advanceTo("policies")}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: "var(--brand)", color: "#fff", border: "none", cursor: "pointer",
                }}
              >
                Avançar <ChevronRight size={14} />
              </button>
            </div>
          </div>
        )}

        {/* ── Step 3: Policies ── */}
        {step === "policies" && (
          <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{
              display: "flex", alignItems: "flex-start", gap: 14, padding: "14px",
              background: "var(--surface-2, #262c3a)", border: "1px solid var(--border)", borderRadius: 10,
            }}>
              <div style={{
                width: 36, height: 36, borderRadius: 8, flexShrink: 0, background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                display: "flex", alignItems: "center", justifyContent: "center",
              }}>
                <Shield size={16} style={{ color: "var(--brand)" }} />
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "var(--text)", marginBottom: 4 }}>
                  Crie sua primeira política de alerta
                </div>
                <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 10 }}>
                  Políticas definem quando gerar alertas e como escalonar. Sem elas, todos os eventos do Zabbix chegam sem filtro.
                </div>
                <Link to="/policies" style={{
                  display: "inline-flex", alignItems: "center", gap: 5,
                  fontSize: 12, fontWeight: 500, color: "var(--brand)", textDecoration: "none",
                }}>
                  Abrir Políticas de Alerta <ChevronRight size={13} />
                </Link>
              </div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <button
                onClick={dismiss}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "8px 20px", borderRadius: 8, fontSize: 13, fontWeight: 600,
                  background: "var(--brand)", color: "#fff", border: "none", cursor: "pointer",
                }}
              >
                <Check size={14} /> Concluir configuração
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function WizardField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <span style={{ fontSize: 12, fontWeight: 500, color: "var(--text)" }}>
        {label}
        {hint && <span style={{ fontWeight: 400, color: "var(--text-muted)", marginLeft: 6 }}>{hint}</span>}
      </span>
      <style>{`
        .wiz-field input {
          background: var(--bg); border: 1px solid var(--border); border-radius: 8px;
          padding: 7px 11px; font-size: 12px; color: var(--text); width: 100%;
          box-sizing: border-box; outline: none; font-family: inherit;
        }
        .wiz-field input:focus { border-color: var(--brand); }
        .wiz-field input::placeholder { color: var(--text-muted); }
      `}</style>
      <div className="wiz-field">{children}</div>
    </label>
  );
}
