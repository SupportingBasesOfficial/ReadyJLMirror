import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
// api.get / api.put / api.post — object with named method calls
import { Settings2, Mail, Bell, Palette, Send, CheckCircle, XCircle } from "lucide-react";
import { PageInfoButton } from "@/components/PageInfoButton";

interface TenantSettings {
  smtp_host?: string | null;
  smtp_port?: number;
  smtp_user?: string | null;
  smtp_password?: string | null;
  smtp_from_name?: string | null;
  smtp_from_email?: string | null;
  smtp_tls?: boolean;
  notify_on_alert_critical?: boolean;
  notify_on_incident_open?: boolean;
  notify_on_sla_breach?: boolean;
  timezone?: string;
  date_format?: string;
}

const TIMEZONES = [
  "America/Sao_Paulo",
  "America/Manaus",
  "America/Belem",
  "America/Fortaleza",
  "America/Recife",
  "America/Bahia",
  "America/Noronha",
  "America/Rio_Branco",
  "UTC",
  "America/New_York",
  "America/Chicago",
  "America/Los_Angeles",
  "Europe/London",
  "Europe/Lisbon",
];

const DATE_FORMATS = ["DD/MM/YYYY", "MM/DD/YYYY", "YYYY-MM-DD"];

type Tab = "branding" | "smtp" | "preferences";

interface Props { tenantId: string }

export function TenantSettingsPage({ tenantId }: Props) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("branding");
  const [toast, setToast] = useState<{ ok: boolean; msg: string } | null>(null);
  const [smtpTestEmail, setSmtpTestEmail] = useState("");
  const [smtpTestResult, setSmtpTestResult] = useState<{ success: boolean; error?: string } | null>(null);
  const [showSmtpTest, setShowSmtpTest] = useState(false);

  const showToast = (ok: boolean, msg: string) => {
    setToast({ ok, msg });
    setTimeout(() => setToast(null), 3000);
  };

  // --- Settings query ---
  const { data: settings, isLoading } = useQuery<TenantSettings>({
    queryKey: ["tenant-settings", tenantId],
    queryFn: () => api.get<TenantSettings>("/api/v1/tenant-settings"),
  });

  // --- Branding query ---
  const { data: branding } = useQuery<{ brand_name?: string; brand_color?: string; logo_url?: string }>({
    queryKey: ["branding", tenantId],
    queryFn: () => api.get<{ brand_name?: string; brand_color?: string; logo_url?: string }>(`/api/v1/platform/branding?tenant_id=${tenantId}`),
  });

  // --- Mutations ---
  const settingsMut = useMutation({
    mutationFn: (body: Partial<TenantSettings>) =>
      api.put<TenantSettings>("/api/v1/tenant-settings", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["tenant-settings"] }); showToast(true, t("tenantSettings.saved")); },
    onError: () => showToast(false, t("tenantSettings.saveError")),
  });

  const brandingMut = useMutation({
    mutationFn: (body: object) =>
      api.put("/api/v1/platform/branding", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["branding"] }); showToast(true, t("tenantSettings.saved")); },
    onError: () => showToast(false, t("tenantSettings.saveError")),
  });

  const smtpTestMut = useMutation({
    mutationFn: (to_email: string) =>
      api.post<{ success: boolean; error?: string }>("/api/v1/tenant-settings/smtp/test", { to_email }),
    onSuccess: (res: { success: boolean; error?: string }) => setSmtpTestResult(res),
  });

  // --- Local form state ---
  const [brandForm, setBrandForm] = useState({ brand_name: "", brand_color: "#6366f1", logo_url: "" });
  const [smtpForm, setSmtpForm] = useState<TenantSettings>({});
  const [prefForm, setPrefForm] = useState<TenantSettings>({});
  const [initialized, setInitialized] = useState(false);

  if (!initialized && settings && branding !== undefined) {
    setBrandForm({
      brand_name: branding?.brand_name ?? "",
      brand_color: branding?.brand_color ?? "#6366f1",
      logo_url: branding?.logo_url ?? "",
    });
    setSmtpForm({
      smtp_host: settings.smtp_host ?? "",
      smtp_port: settings.smtp_port ?? 587,
      smtp_user: settings.smtp_user ?? "",
      smtp_from_name: settings.smtp_from_name ?? "",
      smtp_from_email: settings.smtp_from_email ?? "",
      smtp_tls: settings.smtp_tls ?? true,
    });
    setPrefForm({
      notify_on_alert_critical: settings.notify_on_alert_critical ?? true,
      notify_on_incident_open: settings.notify_on_incident_open ?? true,
      notify_on_sla_breach: settings.notify_on_sla_breach ?? true,
      timezone: settings.timezone ?? "America/Sao_Paulo",
      date_format: settings.date_format ?? "DD/MM/YYYY",
    });
    setInitialized(true);
  }

  const tabs: { id: Tab; label: string; icon: React.ReactNode }[] = [
    { id: "branding", label: t("tenantSettings.tabs.branding"), icon: <Palette size={14} /> },
    { id: "smtp", label: t("tenantSettings.tabs.smtp"), icon: <Mail size={14} /> },
    { id: "preferences", label: t("tenantSettings.tabs.preferences"), icon: <Bell size={14} /> },
  ];

  if (isLoading) return <div className="p-8 text-sm text-[var(--text-muted)]">{t("common.loading")}</div>;

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Settings2 size={20} className="text-[var(--brand,#6366f1)]" />
          <h1 className="text-base font-semibold">{t("tenantSettings.title")}</h1>
        </div>
        <PageInfoButton screenId="tenant-settings" />
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-[var(--border)]">
        {tabs.map(tb => (
          <button
            key={tb.id}
            onClick={() => setTab(tb.id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-xs font-medium border-b-2 transition-colors ${
              tab === tb.id
                ? "border-[var(--brand,#6366f1)] text-[var(--brand,#6366f1)]"
                : "border-transparent text-[var(--text-muted)] hover:text-[var(--text)]"
            }`}
          >
            {tb.icon}{tb.label}
          </button>
        ))}
      </div>

      {/* Toast */}
      {toast && (
        <div className={`flex items-center gap-2 text-xs px-3 py-2 rounded-lg ${
          toast.ok ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"
        }`}>
          {toast.ok ? <CheckCircle size={13} /> : <XCircle size={13} />}
          {toast.msg}
        </div>
      )}

      {/* Branding Tab */}
      {tab === "branding" && (
        <div className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.branding.name")}</label>
            <input
              type="text"
              value={brandForm.brand_name}
              onChange={e => setBrandForm(f => ({ ...f, brand_name: e.target.value }))}
              placeholder="Ex: Acme Operations"
              className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.branding.logoUrl")}</label>
            <input
              type="url"
              value={brandForm.logo_url}
              onChange={e => setBrandForm(f => ({ ...f, logo_url: e.target.value }))}
              placeholder="https://exemplo.com/logo.png"
              className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]"
            />
            {brandForm.logo_url && (
              <img src={brandForm.logo_url} alt="logo preview" className="h-10 mt-2 object-contain rounded border border-[var(--border)] p-1" onError={e => (e.currentTarget.hidden = true)} />
            )}
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.branding.color")}</label>
            <div className="flex items-center gap-3">
              <input type="color" value={brandForm.brand_color} onChange={e => setBrandForm(f => ({ ...f, brand_color: e.target.value }))} className="w-10 h-8 rounded cursor-pointer border border-[var(--border)]" />
              <span className="text-xs font-mono text-[var(--text-muted)]">{brandForm.brand_color}</span>
              <span className="text-xs px-2 py-0.5 rounded-full text-white" style={{ backgroundColor: brandForm.brand_color }}>
                Preview
              </span>
            </div>
          </div>
          <button
            onClick={() => brandingMut.mutate(brandForm)}
            disabled={brandingMut.isPending}
            className="text-xs px-4 py-2 rounded bg-[var(--brand,#6366f1)] text-white hover:opacity-90 disabled:opacity-50"
          >
            {brandingMut.isPending ? t("common.saving") : t("tenantSettings.branding.save")}
          </button>
        </div>
      )}

      {/* SMTP Tab */}
      {tab === "smtp" && (
        <div className="space-y-4">
          <div className="text-xs text-amber-600 bg-amber-500/10 px-3 py-2 rounded-lg">
            ⚠️ {t("tenantSettings.smtp.warning")}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.smtp.host")}</label>
              <input type="text" value={smtpForm.smtp_host ?? ""} onChange={e => setSmtpForm(f => ({ ...f, smtp_host: e.target.value }))} placeholder="smtp.gmail.com" className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.smtp.port")}</label>
              <input type="number" value={smtpForm.smtp_port ?? 587} onChange={e => setSmtpForm(f => ({ ...f, smtp_port: +e.target.value }))} className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.smtp.user")}</label>
              <input type="text" value={smtpForm.smtp_user ?? ""} onChange={e => setSmtpForm(f => ({ ...f, smtp_user: e.target.value }))} placeholder="user@exemplo.com" className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.smtp.password")}</label>
              <input type="password" placeholder="••••••••" onChange={e => setSmtpForm(f => ({ ...f, smtp_password: e.target.value }))} className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.smtp.fromName")}</label>
              <input type="text" value={smtpForm.smtp_from_name ?? ""} onChange={e => setSmtpForm(f => ({ ...f, smtp_from_name: e.target.value }))} placeholder="Argos Ops" className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]" />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.smtp.fromEmail")}</label>
              <input type="email" value={smtpForm.smtp_from_email ?? ""} onChange={e => setSmtpForm(f => ({ ...f, smtp_from_email: e.target.value }))} placeholder="ops@empresa.com" className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]" />
            </div>
          </div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="checkbox" checked={smtpForm.smtp_tls ?? true} onChange={e => setSmtpForm(f => ({ ...f, smtp_tls: e.target.checked }))} className="w-4 h-4" />
            <span className="text-xs">{t("tenantSettings.smtp.tls")}</span>
          </label>
          <div className="flex gap-2">
            <button
              onClick={() => settingsMut.mutate(smtpForm)}
              disabled={settingsMut.isPending}
              className="text-xs px-4 py-2 rounded bg-[var(--brand,#6366f1)] text-white hover:opacity-90 disabled:opacity-50"
            >
              {settingsMut.isPending ? t("common.saving") : t("tenantSettings.smtp.save")}
            </button>
            <button
              onClick={() => { setShowSmtpTest(true); setSmtpTestResult(null); }}
              className="text-xs px-4 py-2 rounded border border-[var(--border)] hover:border-[var(--brand)] transition-colors"
            >
              <Send size={12} className="inline mr-1" />
              {t("tenantSettings.smtp.test")}
            </button>
          </div>

          {showSmtpTest && (
            <div className="border border-[var(--border)] rounded-lg p-4 space-y-3">
              <p className="text-xs font-medium">{t("tenantSettings.smtp.testTitle")}</p>
              <div className="flex gap-2">
                <input type="email" value={smtpTestEmail} onChange={e => setSmtpTestEmail(e.target.value)} placeholder="destino@exemplo.com" className="flex-1 text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 focus:outline-none focus:border-[var(--brand)]" />
                <button onClick={() => smtpTestMut.mutate(smtpTestEmail)} disabled={smtpTestMut.isPending || !smtpTestEmail} className="text-xs px-3 py-1.5 rounded bg-[var(--brand,#6366f1)] text-white hover:opacity-90 disabled:opacity-50">
                  {smtpTestMut.isPending ? "..." : t("tenantSettings.smtp.send")}
                </button>
              </div>
              {smtpTestResult && (
                <div className={`text-xs px-3 py-2 rounded flex items-center gap-2 ${smtpTestResult.success ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}>
                  {smtpTestResult.success ? <CheckCircle size={13} /> : <XCircle size={13} />}
                  {smtpTestResult.success ? t("tenantSettings.smtp.testOk") : smtpTestResult.error}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Preferences Tab */}
      {tab === "preferences" && (
        <div className="space-y-5">
          <div className="space-y-3">
            <p className="text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wide">{t("tenantSettings.prefs.notifications")}</p>
            {[
              { key: "notify_on_alert_critical", label: t("tenantSettings.prefs.alertCritical") },
              { key: "notify_on_incident_open", label: t("tenantSettings.prefs.incidentOpen") },
              { key: "notify_on_sla_breach", label: t("tenantSettings.prefs.slaBreach") },
            ].map(({ key, label }) => (
              <label key={key} className="flex items-center justify-between cursor-pointer group">
                <span className="text-sm">{label}</span>
                <input
                  type="checkbox"
                  checked={(prefForm as Record<string, boolean>)[key] ?? true}
                  onChange={e => setPrefForm(f => ({ ...f, [key]: e.target.checked }))}
                  className="w-4 h-4"
                />
              </label>
            ))}
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.prefs.timezone")}</label>
            <select value={prefForm.timezone ?? "America/Sao_Paulo"} onChange={e => setPrefForm(f => ({ ...f, timezone: e.target.value }))} className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]">
              {TIMEZONES.map(tz => <option key={tz} value={tz}>{tz}</option>)}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-[var(--text-muted)]">{t("tenantSettings.prefs.dateFormat")}</label>
            <select value={prefForm.date_format ?? "DD/MM/YYYY"} onChange={e => setPrefForm(f => ({ ...f, date_format: e.target.value }))} className="w-full text-sm rounded border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 focus:outline-none focus:border-[var(--brand)]">
              {DATE_FORMATS.map(f => <option key={f} value={f}>{f}</option>)}
            </select>
          </div>
          <button
            onClick={() => settingsMut.mutate(prefForm)}
            disabled={settingsMut.isPending}
            className="text-xs px-4 py-2 rounded bg-[var(--brand,#6366f1)] text-white hover:opacity-90 disabled:opacity-50"
          >
            {settingsMut.isPending ? t("common.saving") : t("tenantSettings.prefs.save")}
          </button>
        </div>
      )}
    </div>
  );
}
