import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Activity, Bell, Zap, CheckCircle } from "lucide-react";

interface Props {
  principalId: string;
}

type Step = "welcome" | "name" | "creating" | "binding" | "done";

const FEATURES = [
  {
    Icon: Activity,
    title: "Monitoramento unificado",
    desc: "Zabbix, Nagios, Prometheus e mais — tudo em um único painel.",
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

export function OnboardingPage({ principalId: _principalId }: Props) {
  const qc = useQueryClient();
  const [step, setStep] = useState<Step>("welcome");
  const [tenantName, setTenantName] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const register = useMutation({
    mutationFn: (name: string) =>
      api.post<{ tenant_id: string; role: string }>("/api/v1/onboarding/register", {
        tenant_name: name,
      }),
    onSuccess: async (data) => {
      setStep("binding");
      try {
        await api.post("/api/tenant/select", { tenant_id: data.tenant_id });
        setStep("done");
        setTimeout(() => qc.invalidateQueries({ queryKey: ["session"] }), 800);
      } catch {
        setErr("Workspace criado, mas não foi possível iniciar a sessão. Recarregue a página.");
      }
    },
    onError: (e: unknown) => {
      setErr((e as Error)?.message ?? "Falha no registro.");
      setStep("name");
    },
  });

  function submit() {
    const name = tenantName.trim();
    if (!name) return;
    setErr(null);
    setStep("creating");
    register.mutate(name);
  }

  // Loading states
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

  // Welcome screen
  if (step === "welcome") {
    return (
      <div
        className="flex items-center justify-center min-h-screen p-4"
        style={{ background: "var(--bg)" }}
      >
        <div style={{ maxWidth: 480, width: "100%" }}>
          {/* Brand */}
          <div className="text-center mb-8">
            <div className="text-2xl font-bold mb-2">
              <span style={{ color: "var(--brand)" }}>JL</span>Mirror
            </div>
            <p style={{ color: "var(--text-muted)", fontSize: 15 }}>
              Plataforma de operações para MSPs e equipes de TI
            </p>
          </div>

          {/* Feature cards */}
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

          <Button className="w-full" onClick={() => setStep("name")}>
            Criar meu workspace
          </Button>

          <form method="post" action="/auth/logout" className="mt-3">
            <button
              type="submit"
              className="w-full text-xs py-1"
              style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
            >
              Sair
            </button>
          </form>
        </div>
      </div>
    );
  }

  // Name step
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
          onClick={() => setStep("welcome")}
          className="text-xs mb-5 flex items-center gap-1"
          style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
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
              onKeyDown={(e) => e.key === "Enter" && submit()}
              placeholder="Ex: Acme Corp Operações"
              maxLength={120}
              autoFocus
              style={{
                width: "100%",
                fontSize: 14,
                background: "var(--surface-2)",
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: "8px 12px",
                color: "var(--text)",
                outline: "none",
                boxSizing: "border-box",
              }}
              onFocus={(e) => (e.target.style.borderColor = "var(--brand)")}
              onBlur={(e) => (e.target.style.borderColor = "var(--border)")}
            />
          </div>

          {err && <p className="text-xs" style={{ color: "var(--red)" }}>{err}</p>}

          <Button
            className="w-full"
            onClick={submit}
            disabled={!tenantName.trim() || register.isPending}
          >
            {register.isPending ? <Spinner className="w-4 h-4 mr-2" /> : null}
            Criar workspace
          </Button>
        </div>
      </div>
    </div>
  );
}
