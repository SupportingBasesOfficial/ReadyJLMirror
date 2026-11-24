import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api, logout } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Activity, Bell, Zap, CheckCircle, Building2, Wrench } from "lucide-react";

interface Props {
  principalId: string;
}

type Step =
  | "welcome"
  | "profile"
  | "generic-name"
  | "self-managed-form"
  | "creating"
  | "binding"
  | "done";

const FEATURES = [
  {
    Icon: Activity,
    title: "Monitoramento unificado",
    desc: "Zabbix integrado nativamente — alertas, inventário e métricas em tempo real.",
  },
  {
    Icon: Bell,
    title: "Alertas inteligentes",
    desc: "Políticas de alerta com supressão, escalonamento e resposta automática.",
  },
  {
    Icon: Zap,
    title: "Automação e ITSM",
    desc: "Tickets, SLA, mudanças e automações integrados ao fluxo de operação.",
  },
];

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

function isValidSlug(s: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/.test(s);
}

const cardStyle = (selected: boolean): React.CSSProperties => ({
  display: "flex",
  alignItems: "flex-start",
  gap: 14,
  padding: "16px 18px",
  borderRadius: 12,
  background: selected
    ? "color-mix(in srgb, var(--brand) 8%, var(--surface))"
    : "var(--surface)",
  border: selected ? "1.5px solid var(--brand)" : "1px solid var(--border)",
  cursor: "pointer",
  width: "100%",
  textAlign: "left",
  transition: "border-color 0.15s, background 0.15s",
});

const inputStyle: React.CSSProperties = {
  width: "100%",
  fontSize: 14,
  background: "var(--surface-2)",
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: "8px 12px",
  color: "var(--text)",
  outline: "none",
  boxSizing: "border-box",
};

export function OnboardingPage({ principalId: _principalId }: Props) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("welcome");
  const [profile, setProfile] = useState<"msp" | "self-managed" | null>(null);

  // Generic / MSP flow
  const [tenantName, setTenantName] = useState("");

  // Self-managed flow
  const [orgName, setOrgName] = useState("");
  const [orgSlug, setOrgSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [smTenantName, setSmTenantName] = useState("");

  const [err, setErr] = useState<string | null>(null);

  async function bindAndDone(tenantId: string) {
    setStep("binding");
    try {
      await api.post("/api/tenant/select", { tenant_id: tenantId });
      setStep("done");
      setTimeout(() => qc.invalidateQueries({ queryKey: ["session"] }), 800);
    } catch {
      setErr(
        "Workspace criado, mas não foi possível iniciar a sessão. Recarregue a página.",
      );
    }
  }

  const registerGeneric = useMutation({
    mutationFn: (name: string) =>
      api.post<{ tenant_id: string; role: string }>(
        "/api/v1/onboarding/register",
        { tenant_name: name },
      ),
    onSuccess: async (data) => bindAndDone(data.tenant_id),
    onError: (e: unknown) => {
      setErr((e as Error)?.message ?? "Falha no registro.");
      setStep("generic-name");
    },
  });

  const registerSelfManaged = useMutation({
    mutationFn: (body: {
      organization_name: string;
      organization_slug: string;
      tenant_name: string;
    }) =>
      api.post<{ tenant_id: string }>(
        "/api/v1/onboarding/self-managed",
        body,
      ),
    onSuccess: async (data) => bindAndDone(data.tenant_id),
    onError: (e: unknown) => {
      setErr((e as Error)?.message ?? "Falha no registro.");
      setStep("self-managed-form");
    },
  });

  function submitGeneric() {
    const name = tenantName.trim();
    if (!name) return;
    setErr(null);
    setStep("creating");
    registerGeneric.mutate(name);
  }

  function submitSelfManaged() {
    const on = orgName.trim();
    const sl = orgSlug.trim();
    const tn = (smTenantName.trim() || on);
    if (!on || !isValidSlug(sl) || !tn) return;
    setErr(null);
    setStep("creating");
    registerSelfManaged.mutate({
      organization_name: on,
      organization_slug: sl,
      tenant_name: tn,
    });
  }

  // ── Loading ────────────────────────────────────────────────────────────────

  if (step === "creating" || step === "binding") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div
          className="text-center"
          style={{
            padding: 40,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            minWidth: 320,
          }}
        >
          <Spinner className="w-6 h-6 mx-auto mb-4" />
          <p className="text-sm" style={{ color: "var(--text-muted)" }}>
            {step === "creating" ? "Criando workspace…" : "Configurando sessão…"}
          </p>
        </div>
      </div>
    );
  }

  if (step === "done") {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <div
          className="text-center"
          style={{
            padding: 40,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
            minWidth: 320,
          }}
        >
          <CheckCircle
            size={36}
            className="mx-auto mb-4"
            style={{ color: "var(--green)" }}
          />
          <p className="text-sm font-medium mb-1" style={{ color: "var(--text)" }}>
            Workspace pronto!
          </p>
          <p className="text-xs" style={{ color: "var(--text-muted)" }}>
            Carregando…
          </p>
        </div>
      </div>
    );
  }

  // ── Welcome ────────────────────────────────────────────────────────────────

  if (step === "welcome") {
    return (
      <div
        className="flex items-center justify-center min-h-screen p-4"
        style={{ background: "var(--bg)" }}
      >
        <div style={{ maxWidth: 480, width: "100%" }}>
          <div className="text-center mb-8">
            <div className="text-2xl font-bold mb-2">
              <span style={{ color: "var(--brand)" }}>Argos</span>
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 15 }}>
              Plataforma de operações para MSPs e equipes de TI
            </p>
          </div>

          <div className="space-y-3 mb-8">
            {FEATURES.map(({ Icon, title, desc }) => (
              <div
                key={title}
                style={{
                  display: "flex",
                  alignItems: "flex-start",
                  gap: 14,
                  padding: "14px 16px",
                  borderRadius: 12,
                  background: "var(--surface)",
                  border: "1px solid var(--border)",
                }}
              >
                <div
                  style={{
                    width: 34,
                    height: 34,
                    borderRadius: 8,
                    background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    flexShrink: 0,
                  }}
                >
                  <Icon size={16} style={{ color: "var(--brand)" }} />
                </div>
                <div>
                  <div className="text-sm font-medium mb-0.5" style={{ color: "var(--text)" }}>
                    {title}
                  </div>
                  <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                    {desc}
                  </div>
                </div>
              </div>
            ))}
          </div>

          <Button className="w-full" onClick={() => setStep("profile")}>
            Criar meu workspace
          </Button>

          <button
            type="button"
            onClick={() => logout()}
            className="w-full text-xs py-1 mt-3"
            style={{
              color: "var(--text-muted)",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            Sair
          </button>
        </div>
      </div>
    );
  }

  // ── Profile selection ──────────────────────────────────────────────────────

  if (step === "profile") {
    return (
      <div
        className="flex items-center justify-center min-h-screen p-4"
        style={{ background: "var(--bg)" }}
      >
        <div
          style={{
            maxWidth: 460,
            width: "100%",
            padding: 32,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
          }}
        >
          <button
            onClick={() => setStep("welcome")}
            className="text-xs mb-5 flex items-center gap-1"
            style={{
              color: "var(--text-muted)",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            ← Voltar
          </button>

          <h2 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>
            Como você usa o Argos?
          </h2>
          <p className="text-xs mb-5" style={{ color: "var(--text-muted)" }}>
            Escolha o perfil que melhor descreve sua organização.
          </p>

          <div className="space-y-3 mb-6">
            <button
              type="button"
              style={cardStyle(profile === "self-managed")}
              onClick={() => setProfile("self-managed")}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Building2 size={16} style={{ color: "var(--brand)" }} />
              </div>
              <div>
                <div className="text-sm font-medium mb-0.5" style={{ color: "var(--text)" }}>
                  Empresa com TI própria
                </div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Minha equipe gerencia o próprio ambiente, sem MSP externo.
                </div>
              </div>
            </button>

            <button
              type="button"
              style={cardStyle(profile === "msp")}
              onClick={() => setProfile("msp")}
            >
              <div
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: 8,
                  background: "color-mix(in srgb, var(--brand) 12%, transparent)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  flexShrink: 0,
                }}
              >
                <Wrench size={16} style={{ color: "var(--brand)" }} />
              </div>
              <div>
                <div className="text-sm font-medium mb-0.5" style={{ color: "var(--text)" }}>
                  MSP / Provedor de serviços
                </div>
                <div className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Monitoro e opero ambientes de múltiplos clientes.
                </div>
              </div>
            </button>
          </div>

          <Button
            className="w-full"
            disabled={!profile}
            onClick={() => {
              if (profile === "self-managed") setStep("self-managed-form");
              else setStep("generic-name");
            }}
          >
            Continuar
          </Button>
        </div>
      </div>
    );
  }

  // ── Self-managed form ──────────────────────────────────────────────────────

  if (step === "self-managed-form") {
    const slugInvalid = orgSlug.length > 0 && !isValidSlug(orgSlug);

    return (
      <div
        className="flex items-center justify-center min-h-screen p-4"
        style={{ background: "var(--bg)" }}
      >
        <div
          style={{
            maxWidth: 440,
            width: "100%",
            padding: 32,
            background: "var(--surface)",
            border: "1px solid var(--border)",
            borderRadius: 16,
          }}
        >
          <button
            onClick={() => { setErr(null); setStep("profile"); }}
            className="text-xs mb-5 flex items-center gap-1"
            style={{
              color: "var(--text-muted)",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
          >
            ← Voltar
          </button>

          <h2 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>
            Sua organização
          </h2>
          <p className="text-xs mb-5" style={{ color: "var(--text-muted)" }}>
            Dados da empresa. Pode ser alterado depois nas configurações.
          </p>

          <div className="space-y-4">
            {/* Org name */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Nome da empresa *
              </label>
              <input
                type="text"
                value={orgName}
                onChange={(e) => {
                  setOrgName(e.target.value);
                  if (!slugEdited) {
                    setOrgSlug(slugify(e.target.value));
                  }
                }}
                placeholder="Ex: Acme Corp"
                maxLength={120}
                autoFocus
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = "var(--brand)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
              />
            </div>

            {/* Org slug */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Identificador único (slug) *
              </label>
              <input
                type="text"
                value={orgSlug}
                onChange={(e) => {
                  setSlugEdited(true);
                  setOrgSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""));
                }}
                placeholder="acme-corp"
                maxLength={50}
                style={{
                  ...inputStyle,
                  borderColor: slugInvalid ? "var(--red)" : undefined,
                }}
                onFocus={(e) =>
                  (e.target.style.borderColor = slugInvalid
                    ? "var(--red)"
                    : "var(--brand)")
                }
                onBlur={(e) =>
                  (e.target.style.borderColor = slugInvalid
                    ? "var(--red)"
                    : "var(--border)")
                }
              />
              {slugInvalid ? (
                <p className="text-xs" style={{ color: "var(--red)" }}>
                  Mínimo 3 caracteres: letras minúsculas, dígitos e hífens.
                </p>
              ) : (
                <p className="text-xs" style={{ color: "var(--text-muted)" }}>
                  Usado como identificador interno. Letras minúsculas, dígitos e hífens.
                </p>
              )}
            </div>

            {/* Workspace name (optional) */}
            <div className="space-y-1.5">
              <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
                Nome do workspace{" "}
                <span style={{ fontWeight: 400 }}>(padrão: nome da empresa)</span>
              </label>
              <input
                type="text"
                value={smTenantName}
                onChange={(e) => setSmTenantName(e.target.value)}
                placeholder={orgName || "Ex: Acme Corp Operações"}
                maxLength={120}
                style={inputStyle}
                onFocus={(e) => (e.target.style.borderColor = "var(--brand)")}
                onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
              />
            </div>

            {err && (
              <p className="text-xs" style={{ color: "var(--red)" }}>
                {err}
              </p>
            )}

            <Button
              className="w-full"
              onClick={submitSelfManaged}
              disabled={
                !orgName.trim() ||
                !isValidSlug(orgSlug) ||
                registerSelfManaged.isPending
              }
            >
              {registerSelfManaged.isPending ? (
                <Spinner className="w-4 h-4 mr-2" />
              ) : null}
              Criar workspace
            </Button>
          </div>
        </div>
      </div>
    );
  }

  // ── Generic / MSP name ─────────────────────────────────────────────────────

  return (
    <div
      className="flex items-center justify-center min-h-screen p-4"
      style={{ background: "var(--bg)" }}
    >
      <div
        style={{
          maxWidth: 420,
          width: "100%",
          padding: 32,
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 16,
        }}
      >
        <button
          onClick={() => { setErr(null); setStep("profile"); }}
          className="text-xs mb-5 flex items-center gap-1"
          style={{
            color: "var(--text-muted)",
            background: "none",
            border: "none",
            cursor: "pointer",
          }}
        >
          ← Voltar
        </button>

        <h2 className="text-base font-semibold mb-1" style={{ color: "var(--text)" }}>
          Nomeie seu workspace
        </h2>
        <p className="text-xs mb-5" style={{ color: "var(--text-muted)" }}>
          Use o nome da sua empresa ou equipe. Pode ser alterado depois.
        </p>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label className="text-xs font-medium" style={{ color: "var(--text-muted)" }}>
              Nome do workspace
            </label>
            <input
              type="text"
              value={tenantName}
              onChange={(e) => setTenantName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitGeneric()}
              placeholder="Ex: Acme Corp Operações"
              maxLength={120}
              autoFocus
              style={inputStyle}
              onFocus={(e) => (e.target.style.borderColor = "var(--brand)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
            />
          </div>

          {err && (
            <p className="text-xs" style={{ color: "var(--red)" }}>
              {err}
            </p>
          )}

          <Button
            className="w-full"
            onClick={submitGeneric}
            disabled={!tenantName.trim() || registerGeneric.isPending}
          >
            {registerGeneric.isPending ? (
              <Spinner className="w-4 h-4 mr-2" />
            ) : null}
            Criar workspace
          </Button>
        </div>
      </div>
    </div>
  );
}
