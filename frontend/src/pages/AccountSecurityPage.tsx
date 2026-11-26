import { useState, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import QRCode from "qrcode";
import {
  ShieldCheck,
  MonitorSmartphone,
  Lock,
  Trash2,
  Download,
  AlertTriangle,
  Bell,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/hooks/use-toast";
import { PageInfoButton } from "@/components/PageInfoButton";
import { usePushNotifications } from "@/hooks/usePushNotifications";

interface Props {
  tenantId: string;
}

type Tab = "sessions" | "mfa" | "privacy" | "push";

// ── API helpers ──────────────────────────────────────────────────────────────

function readCsrfCookie(): string {
  const match = document.cookie.match(/(?:^|;\s*)jl_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

async function apiFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const csrfHeaders: Record<string, string> =
    method !== "GET" && method !== "HEAD"
      ? { "x-csrf-token": readCsrfCookie() }
      : {};
  const r = await fetch(path, {
    credentials: "include",
    headers: {
      "Content-Type": "application/json",
      ...csrfHeaders,
      ...(init?.headers ?? {}),
    },
    ...init,
  });
  if (!r.ok) {
    const err = await r.json().catch(() => ({ detail: r.statusText }));
    throw new Error(err.detail ?? r.statusText);
  }
  return r.json() as Promise<T>;
}

// ── Sessions tab ─────────────────────────────────────────────────────────────

interface Session {
  id: string;
  ipAddress: string;
  start: number;
  lastAccess: number;
  clients: string[];
  current?: boolean;
}

function SessionsTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();

  const { data, isLoading, isError } = useQuery<{ sessions: Session[] }>({
    queryKey: ["account-sessions"],
    queryFn: () => apiFetch("/api/v1/account/sessions"),
  });

  const revoke = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/v1/account/sessions/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("accountSecurity.sessions.revokeSuccess") });
      qc.invalidateQueries({ queryKey: ["account-sessions"] });
    },
    onError: (e: Error) => {
      toast({
        title: t("accountSecurity.sessions.revokeError"),
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const fmt = (ms: number) =>
    ms ? new Date(ms).toLocaleString() : "—";

  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>;
  if (isError) return <p className="text-[var(--red)] text-sm py-4">Failed to load sessions.</p>;

  const sessions = data?.sessions ?? [];

  return (
    <div className="space-y-3">
      <p className="text-sm font-semibold text-[var(--text)]">{t("accountSecurity.sessions.heading")}</p>
      {sessions.length === 0 && (
        <p className="text-sm text-[var(--text-muted)] py-4">{t("accountSecurity.sessions.empty")}</p>
      )}
      {sessions.map((s) => (
        <div
          key={s.id}
          className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3"
        >
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-2">
              <MonitorSmartphone size={14} className="text-[var(--text-muted)] flex-shrink-0" />
              <span className="text-sm font-mono text-[var(--text)]">{s.ipAddress || "—"}</span>
              {s.current && (
                <Badge variant="default" className="text-[10px] px-1.5">
                  {t("accountSecurity.sessions.current")}
                </Badge>
              )}
            </div>
            <p className="text-xs text-[var(--text-muted)]">
              {t("accountSecurity.sessions.lastAccess")}: {fmt(s.lastAccess)} &middot;{" "}
              {t("accountSecurity.sessions.started")}: {fmt(s.start)}
            </p>
            {s.clients.length > 0 && (
              <p className="text-xs text-[var(--text-muted)] truncate">
                {t("accountSecurity.sessions.clients")}: {s.clients.join(", ")}
              </p>
            )}
          </div>
          {!s.current && (
            <Button
              variant="ghost"
              size="sm"
              className="text-[var(--red)] border-[var(--red)] hover:bg-[var(--red)]/10 flex-shrink-0"
              disabled={revoke.isPending}
              onClick={() => {
                if (window.confirm(t("accountSecurity.sessions.revokeConfirm"))) {
                  revoke.mutate(s.id);
                }
              }}
            >
              <Trash2 size={13} className="mr-1" />
              {t("accountSecurity.sessions.revoke")}
            </Button>
          )}
        </div>
      ))}
    </div>
  );
}

// ── MFA tab ───────────────────────────────────────────────────────────────────

interface MFAStatus {
  totp_enabled: boolean;
}

interface MFASetup {
  uri: string;
  email: string;
}

interface RecoveryCodesStatus {
  remaining: number;
}

interface RecoveryCodesGenerated {
  codes: string[];
  count: number;
}

function QRCodeCanvas({ uri }: { uri: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (canvasRef.current && uri) {
      QRCode.toCanvas(canvasRef.current, uri, { width: 180, margin: 2 });
    }
  }, [uri]);

  return (
    <canvas
      ref={canvasRef}
      className="rounded-lg border border-[var(--border)]"
    />
  );
}

function MFATab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [setup, setSetup] = useState<MFASetup | null>(null);
  const [code, setCode] = useState("");
  const [generatedCodes, setGeneratedCodes] = useState<string[] | null>(null);

  const { data, isLoading } = useQuery<MFAStatus>({
    queryKey: ["account-mfa-status"],
    queryFn: () => apiFetch("/api/v1/account/mfa/status"),
  });

  const { data: rcStatus } = useQuery<RecoveryCodesStatus>({
    queryKey: ["account-mfa-recovery-status"],
    queryFn: () => apiFetch("/api/v1/account/mfa/recovery-codes"),
    enabled: data?.totp_enabled ?? false,
  });

  const generateCodes = useMutation({
    mutationFn: () =>
      apiFetch<RecoveryCodesGenerated>("/api/v1/account/mfa/recovery-codes/generate", { method: "POST" }),
    onSuccess: (d) => {
      setGeneratedCodes(d.codes);
      qc.invalidateQueries({ queryKey: ["account-mfa-recovery-status"] });
    },
    onError: (e: Error) => {
      toast({ title: "Erro ao gerar recovery codes", description: e.message, variant: "destructive" });
    },
  });

  const beginSetup = useMutation({
    mutationFn: () => apiFetch<MFASetup>("/api/v1/account/mfa/setup", { method: "POST" }),
    onSuccess: (d) => { setSetup(d); setCode(""); },
  });

  const verify = useMutation({
    mutationFn: () =>
      apiFetch("/api/v1/account/mfa/verify", {
        method: "POST",
        body: JSON.stringify({ code }),
      }),
    onSuccess: () => {
      toast({ title: t("accountSecurity.mfa.verifySuccess") });
      setSetup(null);
      setCode("");
      qc.invalidateQueries({ queryKey: ["account-mfa-status"] });
    },
    onError: (e: Error) => {
      toast({ title: t("accountSecurity.mfa.verifyError"), description: e.message, variant: "destructive" });
    },
  });

  const disable = useMutation({
    mutationFn: () => apiFetch("/api/v1/account/mfa", { method: "DELETE" }),
    onSuccess: () => {
      toast({ title: t("accountSecurity.mfa.disableSuccess") });
      qc.invalidateQueries({ queryKey: ["account-mfa-status"] });
    },
    onError: (e: Error) => {
      toast({ title: t("accountSecurity.mfa.disableError"), description: e.message, variant: "destructive" });
    },
  });

  if (isLoading) return <div className="flex justify-center py-10"><Spinner /></div>;

  const enabled = data?.totp_enabled ?? false;

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${enabled ? "bg-green-500/10" : "bg-[var(--surface-2)]"}`}>
            <Lock size={18} className={enabled ? "text-green-500" : "text-[var(--text-muted)]"} />
          </div>
          <div>
            <p className="text-sm font-medium">
              {enabled ? t("accountSecurity.mfa.enabled") : t("accountSecurity.mfa.disabled")}
            </p>
            <p className="text-xs text-[var(--text-muted)]">TOTP (RFC 6238)</p>
          </div>
        </div>
        {enabled ? (
          <Button
            variant="ghost"
            size="sm"
            className="text-[var(--red)] border-[var(--red)] hover:bg-[var(--red)]/10"
            disabled={disable.isPending}
            onClick={() => {
              if (window.confirm(t("accountSecurity.mfa.disableConfirm"))) {
                disable.mutate();
              }
            }}
          >
            {t("accountSecurity.mfa.disable")}
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={beginSetup.isPending || !!setup}
            onClick={() => beginSetup.mutate()}
          >
            {t("accountSecurity.mfa.setup")}
          </Button>
        )}
      </div>

      {setup && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 space-y-5">
          <div className="space-y-3">
            <p className="text-sm text-[var(--text)]">{t("accountSecurity.mfa.setupStep1")}</p>
            <div className="flex justify-center">
              <QRCodeCanvas uri={setup.uri} />
            </div>
            <p className="text-xs text-[var(--text-muted)] text-center">
              {t("accountSecurity.mfa.scanWithApp")}
            </p>
          </div>

          <div className="space-y-3">
            <p className="text-sm text-[var(--text)]">{t("accountSecurity.mfa.setupStep2")}</p>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              placeholder="000000"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="w-36 px-3 py-2 rounded-md border border-[var(--border)] bg-[var(--surface-2)] text-sm font-mono text-center focus:outline-none focus:ring-2 focus:ring-[var(--brand)]"
            />
            <Button
              size="sm"
              disabled={code.length !== 6 || verify.isPending}
              onClick={() => verify.mutate()}
            >
              {verify.isPending ? <Spinner className="mr-2 h-3 w-3" /> : null}
              {t("accountSecurity.mfa.verify")}
            </Button>
          </div>
        </div>
      )}

      {/* Recovery codes — only shown when TOTP is enabled */}
      {enabled && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Códigos de recuperação</p>
              <p className="text-xs text-[var(--text-muted)] mt-0.5">
                {rcStatus !== undefined
                  ? `${rcStatus.remaining} código${rcStatus.remaining !== 1 ? "s" : ""} disponível${rcStatus.remaining !== 1 ? "s" : ""}`
                  : "Carregando…"}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={generateCodes.isPending}
              onClick={() => {
                if (
                  generatedCodes === null ||
                  window.confirm("Isso invalidará todos os códigos anteriores. Continuar?")
                ) {
                  generateCodes.mutate();
                }
              }}
            >
              {generateCodes.isPending ? <Spinner className="mr-2 h-3 w-3" /> : null}
              {generatedCodes ? "Gerar novos" : "Gerar códigos"}
            </Button>
          </div>

          {generatedCodes && (
            <div className="space-y-3">
              <div className="rounded-md bg-amber-500/10 border border-amber-500/30 p-3 flex gap-2">
                <AlertTriangle size={14} className="text-amber-500 mt-0.5 shrink-0" />
                <p className="text-xs text-amber-700 dark:text-amber-400">
                  Salve esses códigos em um local seguro. Eles são mostrados apenas uma vez.
                  Cada código só pode ser usado uma vez para remover o MFA caso você perca o dispositivo.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {generatedCodes.map((c) => (
                  <code
                    key={c}
                    className="text-xs font-mono px-3 py-1.5 rounded bg-[var(--surface-2)] border border-[var(--border)] text-center tracking-wider select-all"
                  >
                    {c}
                  </code>
                ))}
              </div>
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-[var(--text-muted)]"
                onClick={() => setGeneratedCodes(null)}
              >
                Fechar — confirmei que salvei os códigos
              </Button>
            </div>
          )}

          {!generatedCodes && rcStatus?.remaining === 0 && (
            <p className="text-xs text-[var(--text-muted)]">
              Nenhum código disponível. Gere códigos de recuperação para poder acessar sua conta se perder o dispositivo TOTP.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

// ── Privacy / LGPD tab ────────────────────────────────────────────────────────

function PrivacyTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const [deletionConfirmed, setDeletionConfirmed] = useState(false);
  const [deletionDone, setDeletionDone] = useState(false);

  const exportData = useMutation({
    mutationFn: () => apiFetch<{ data: Record<string, unknown> }>("/api/v1/account/lgpd/export"),
    onSuccess: ({ data }) => {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `jlmirror-data-export-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast({ title: t("accountSecurity.privacy.exportSuccess") });
    },
    onError: (e: Error) => {
      toast({ title: "Export failed", description: e.message, variant: "destructive" });
    },
  });

  const requestDeletion = useMutation({
    mutationFn: () =>
      apiFetch<{ ok: boolean; already_exists?: boolean }>("/api/v1/account/lgpd/deletion-request", {
        method: "POST",
        body: JSON.stringify({ confirm: true }),
      }),
    onSuccess: (d) => {
      if (d.already_exists) {
        toast({ title: t("accountSecurity.privacy.alreadyPending") });
      } else {
        toast({ title: t("accountSecurity.privacy.deletionSuccess") });
      }
      setDeletionDone(true);
    },
    onError: (e: Error) => {
      toast({ title: t("accountSecurity.privacy.deletionError"), description: e.message, variant: "destructive" });
    },
  });

  return (
    <div className="space-y-6">
      {/* Export */}
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 space-y-3">
        <p className="text-sm font-semibold">{t("accountSecurity.privacy.exportHeading")}</p>
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          {t("accountSecurity.privacy.exportDescription")}
        </p>
        <Button
          size="sm"
          variant="ghost"
          disabled={exportData.isPending}
          onClick={() => exportData.mutate()}
        >
          <Download size={14} className="mr-1.5" />
          {t("accountSecurity.privacy.exportButton")}
        </Button>
      </div>

      {/* Deletion */}
      <div className="rounded-lg border border-[var(--red)]/40 bg-[var(--red)]/5 p-5 space-y-4">
        <p className="text-sm font-semibold text-[var(--red)]">{t("accountSecurity.privacy.deletionHeading")}</p>
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          {t("accountSecurity.privacy.deletionDescription")}
        </p>
        <div className="rounded-md bg-[var(--red)]/10 border border-[var(--red)]/30 p-3 flex items-start gap-2">
          <AlertTriangle size={14} className="text-[var(--red)] mt-0.5 flex-shrink-0" />
          <p className="text-xs text-[var(--red)] leading-relaxed">
            {t("accountSecurity.privacy.deletionWarning")}
          </p>
        </div>
        {!deletionDone && (
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={deletionConfirmed}
              onChange={(e) => setDeletionConfirmed(e.target.checked)}
              className="accent-[var(--red)]"
            />
            <span className="text-xs text-[var(--text)]">
              {t("accountSecurity.privacy.deletionConfirmLabel")}
            </span>
          </label>
        )}
        <Button
          variant="danger"
          size="sm"
          disabled={!deletionConfirmed || requestDeletion.isPending || deletionDone}
          onClick={() => requestDeletion.mutate()}
        >
          <Trash2 size={14} className="mr-1.5" />
          {t("accountSecurity.privacy.deletionButton")}
        </Button>
      </div>
    </div>
  );
}

// ── Push Notifications tab ────────────────────────────────────────────────────

function PushTab() {
  const { t } = useTranslation();
  const { toast } = useToast();
  const { state, error, subscribe, unsubscribe } = usePushNotifications();

  const sendTest = useMutation({
    mutationFn: () =>
      apiFetch<{ sent: number; failed: number; total: number }>(
        "/api/v1/push/send-test",
        { method: "POST" }
      ),
    onSuccess: ({ sent }) => {
      toast({ title: t("accountSecurity.push.testSent", { count: sent }) });
    },
    onError: (e: Error) => {
      toast({
        title: t("accountSecurity.push.testError"),
        description: e.message,
        variant: "destructive",
      });
    },
  });

  const isSubscribed = state === "subscribed";
  const iconColor = isSubscribed ? "text-green-500" : "text-[var(--text-muted)]";
  const iconBg = isSubscribed ? "bg-green-500/10" : "bg-[var(--surface-2)]";

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-[var(--border)] bg-[var(--surface)] p-5 flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className={`p-2 rounded-full ${iconBg}`}>
            <Bell size={18} className={iconColor} />
          </div>
          <div>
            <p className="text-sm font-medium">
              {state === "subscribed"
                ? t("accountSecurity.push.active")
                : state === "unsupported"
                ? t("accountSecurity.push.unsupported")
                : state === "denied"
                ? t("accountSecurity.push.denied")
                : t("accountSecurity.push.inactive")}
            </p>
            <p className="text-xs text-[var(--text-muted)]">
              {t("accountSecurity.push.description")}
            </p>
          </div>
        </div>
        {state !== "unsupported" && (
          isSubscribed ? (
            <div className="flex gap-2 flex-shrink-0">
              <Button
                size="sm"
                variant="ghost"
                disabled={sendTest.isPending}
                onClick={() => sendTest.mutate()}
              >
                {sendTest.isPending ? <Spinner className="mr-1.5 h-3 w-3" /> : null}
                {t("accountSecurity.push.sendTest")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-[var(--red)] border-[var(--red)] hover:bg-[var(--red)]/10"
                onClick={unsubscribe}
              >
                {t("accountSecurity.push.unsubscribe")}
              </Button>
            </div>
          ) : (
            <Button
              size="sm"
              disabled={state === "loading" || state === "denied"}
              onClick={subscribe}
            >
              {state === "loading" ? <Spinner className="mr-1.5 h-3 w-3" /> : null}
              {t("accountSecurity.push.subscribe")}
            </Button>
          )
        )}
      </div>

      {error && (
        <p className="text-xs text-[var(--red)]">{error}</p>
      )}

      {state === "denied" && (
        <div className="rounded-md bg-[var(--red)]/10 border border-[var(--red)]/30 p-3 flex items-start gap-2">
          <AlertTriangle size={14} className="text-[var(--red)] mt-0.5 flex-shrink-0" />
          <p className="text-xs text-[var(--red)] leading-relaxed">
            {t("accountSecurity.push.deniedNote")}
          </p>
        </div>
      )}

      {state === "unsupported" && (
        <p className="text-xs text-[var(--text-muted)]">
          {t("accountSecurity.push.unsupportedNote")}
        </p>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

const TABS: { id: Tab; labelKey: string }[] = [
  { id: "sessions", labelKey: "accountSecurity.tabs.sessions" },
  { id: "mfa", labelKey: "accountSecurity.tabs.mfa" },
  { id: "privacy", labelKey: "accountSecurity.tabs.privacy" },
  { id: "push", labelKey: "accountSecurity.tabs.push" },
];

export function AccountSecurityPage({ tenantId: _tenantId }: Props) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>("sessions");

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <ShieldCheck size={22} className="text-[var(--brand)]" />
          <h1 className="text-lg font-semibold">{t("accountSecurity.title")}</h1>
        </div>
        <PageInfoButton screenId="account-security" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        {TABS.map(({ id, labelKey }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === id
                ? "border-[var(--brand)] text-[var(--brand)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {t(labelKey)}
          </button>
        ))}
      </div>

      {/* Tab content */}
      {tab === "sessions" && <SessionsTab />}
      {tab === "mfa" && <MFATab />}
      {tab === "privacy" && <PrivacyTab />}
      {tab === "push" && <PushTab />}
    </div>
  );
}
