import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";

// ── Types ──────────────────────────────────────────────────────────────────

interface Cert {
  cert_id: string;
  domain: string;
  port: number;
  expires_at: string | null;
  issuer: string | null;
  last_checked_at: string | null;
  state: "ok" | "warning" | "critical" | "error" | "unknown";
  error_detail: string | null;
  alert_days: number;
  check_enabled: boolean;
}

interface Asset {
  asset_id: string;
  name: string;
  asset_type: string;
  status: string;
  ip_address: string | null;
  location: string | null;
  owner: string | null;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────────

const STATE_COLOR: Record<string, string> = {
  ok: "var(--green, #22c55e)",
  warning: "#f59e0b",
  critical: "var(--red)",
  error: "var(--red)",
  unknown: "var(--text-muted)",
};

function StateBadge({ state }: { state: string }) {
  return (
    <span style={{ color: STATE_COLOR[state] ?? "var(--text-muted)", fontWeight: 600, fontSize: "0.75rem", textTransform: "uppercase" }}>
      {state}
    </span>
  );
}

function daysUntil(iso: string | null): string {
  if (!iso) return "—";
  const diff = (new Date(iso).getTime() - Date.now()) / 86400000;
  if (diff < 0) return "EXPIRED";
  return `${Math.floor(diff)}d`;
}

// ── Certificates tab ───────────────────────────────────────────────────────

function CertsTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [domain, setDomain] = useState("");
  const [port, setPort] = useState("443");
  const [alertDays, setAlertDays] = useState("30");

  const { data: certs = [], isLoading } = useQuery<Cert[]>({
    queryKey: ["infra-certs", tenantId],
    queryFn: () => api.get<Cert[]>("/api/v1/infra/certs"),
    refetchInterval: 60_000,
  });

  const add = useMutation({
    mutationFn: () =>
      api.post<Cert>("/api/v1/infra/certs", {
        domain: domain.trim(),
        port: parseInt(port, 10),
        alert_days: parseInt(alertDays, 10),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["infra-certs"] });
      setDomain("");
    },
  });

  const remove = useMutation({
    mutationFn: (certId: string) =>
      api.delete(`/api/v1/infra/certs/${certId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["infra-certs"] }),
  });

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (domain.trim()) add.mutate();
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}
      >
        <input
          value={domain}
          onChange={(e) => setDomain(e.target.value)}
          placeholder="domain (e.g. api.example.com)"
          style={{ flex: 2, minWidth: 180, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }}
        />
        <input
          value={port}
          onChange={(e) => setPort(e.target.value)}
          placeholder="port"
          type="number"
          min={1}
          max={65535}
          style={{ width: 70, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }}
        />
        <input
          value={alertDays}
          onChange={(e) => setAlertDays(e.target.value)}
          placeholder="alert days"
          type="number"
          min={1}
          max={365}
          style={{ width: 90, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }}
        />
        <Button type="submit" size="sm" disabled={!domain.trim() || add.isPending}>
          {add.isPending ? "Adding…" : "Track certificate"}
        </Button>
      </form>

      {isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>Loading…</div>
      ) : certs.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>No certificates tracked.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Domain", "Port", "State", "Expires", "Days left", "Issuer", "Last check", ""].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600, color: "var(--text-muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {certs.map((c) => (
                <tr key={c.cert_id} style={{ borderBottom: "1px solid var(--border)", opacity: c.check_enabled ? 1 : 0.5 }}>
                  <td style={{ padding: "5px 8px", fontWeight: 500 }}>{c.domain}</td>
                  <td style={{ padding: "5px 8px", color: "var(--text-muted)" }}>{c.port}</td>
                  <td style={{ padding: "5px 8px" }}><StateBadge state={c.state} /></td>
                  <td style={{ padding: "5px 8px", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>
                    {c.expires_at ? new Date(c.expires_at).toLocaleDateString() : "—"}
                  </td>
                  <td style={{ padding: "5px 8px", fontVariantNumeric: "tabular-nums", color: c.state === "critical" ? "var(--red)" : c.state === "warning" ? "#f59e0b" : "var(--text)" }}>
                    {daysUntil(c.expires_at)}
                  </td>
                  <td style={{ padding: "5px 8px", color: "var(--text-muted)", maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.issuer ?? "—"}</td>
                  <td style={{ padding: "5px 8px", color: "var(--text-muted)" }}>
                    {c.last_checked_at ? new Date(c.last_checked_at).toLocaleString() : "pending"}
                  </td>
                  <td style={{ padding: "5px 8px" }}>
                    <button
                      onClick={() => remove.mutate(c.cert_id)}
                      style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem" }}
                    >
                      remove
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Assets tab ─────────────────────────────────────────────────────────────

const ASSET_TYPES = ["server","vm","container","network","storage","database","service","other"];
const STATUSES = ["active","inactive","decommissioned","maintenance"];

const STATUS_COLOR: Record<string, string> = {
  active: "var(--green, #22c55e)",
  inactive: "var(--text-muted)",
  decommissioned: "var(--red)",
  maintenance: "#f59e0b",
};

function AssetsTab({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [form, setForm] = useState({ name: "", asset_type: "server", status: "active", ip_address: "", location: "", owner: "" });
  const [filterType, setFilterType] = useState("all");
  const [filterStatus, setFilterStatus] = useState("all");
  const [editing, setEditing] = useState<Asset | null>(null);

  const { data: assets = [], isLoading } = useQuery<Asset[]>({
    queryKey: ["infra-assets", tenantId],
    queryFn: () => api.get<Asset[]>("/api/v1/infra/assets"),
  });

  const create = useMutation({
    mutationFn: () => api.post<Asset>("/api/v1/infra/assets", { ...form, ip_address: form.ip_address || null, location: form.location || null, owner: form.owner || null }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["infra-assets"] }); setForm({ name: "", asset_type: "server", status: "active", ip_address: "", location: "", owner: "" }); },
  });

  const update = useMutation({
    mutationFn: ({ assetId, data }: { assetId: string; data: Partial<Asset> }) =>
      api.put<Asset>(`/api/v1/infra/assets/${assetId}`, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["infra-assets"] }); setEditing(null); },
  });

  const remove = useMutation({
    mutationFn: (assetId: string) => api.delete(`/api/v1/infra/assets/${assetId}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["infra-assets"] }),
  });

  const displayed = assets.filter((a) =>
    (filterType === "all" || a.asset_type === filterType) &&
    (filterStatus === "all" || a.status === filterStatus)
  );

  const sel = (field: string) => (e: React.ChangeEvent<HTMLSelectElement | HTMLInputElement>) =>
    setForm((f) => ({ ...f, [field]: e.target.value }));

  return (
    <div>
      {/* Create form */}
      <form onSubmit={(e) => { e.preventDefault(); if (form.name.trim()) create.mutate(); }} style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
        <input value={form.name} onChange={sel("name")} placeholder="Name" style={{ flex: 2, minWidth: 140, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }} />
        <select value={form.asset_type} onChange={sel("asset_type")} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }}>
          {ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <input value={form.ip_address} onChange={sel("ip_address")} placeholder="IP (optional)" style={{ width: 130, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }} />
        <input value={form.location} onChange={sel("location")} placeholder="Location" style={{ width: 110, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }} />
        <input value={form.owner} onChange={sel("owner")} placeholder="Owner" style={{ width: 100, border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.82rem" }} />
        <Button type="submit" size="sm" disabled={!form.name.trim() || create.isPending}>
          {create.isPending ? "Adding…" : "Add asset"}
        </Button>
      </form>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
        <select value={filterType} onChange={(e) => setFilterType(e.target.value)} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.8rem" }}>
          <option value="all">All types</option>
          {ASSET_TYPES.map((t) => <option key={t}>{t}</option>)}
        </select>
        <select value={filterStatus} onChange={(e) => setFilterStatus(e.target.value)} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: "4px 8px", background: "var(--surface-2)", color: "var(--text)", fontSize: "0.8rem" }}>
          <option value="all">All statuses</option>
          {STATUSES.map((s) => <option key={s}>{s}</option>)}
        </select>
      </div>

      {isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>Loading…</div>
      ) : displayed.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>No assets found.</div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.82rem" }}>
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Name", "Type", "Status", "IP", "Location", "Owner", ""].map((h) => (
                  <th key={h} style={{ textAlign: "left", padding: "4px 8px", fontWeight: 600, color: "var(--text-muted)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {displayed.map((a) => (
                <tr key={a.asset_id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "5px 8px", fontWeight: 500 }}>{a.name}</td>
                  <td style={{ padding: "5px 8px", color: "var(--text-muted)" }}>{a.asset_type}</td>
                  <td style={{ padding: "5px 8px" }}>
                    <span style={{ color: STATUS_COLOR[a.status] ?? "var(--text-muted)", fontWeight: 500, fontSize: "0.75rem", textTransform: "uppercase" }}>{a.status}</span>
                  </td>
                  <td style={{ padding: "5px 8px", color: "var(--text-muted)", fontVariantNumeric: "tabular-nums" }}>{a.ip_address ?? "—"}</td>
                  <td style={{ padding: "5px 8px", color: "var(--text-muted)" }}>{a.location ?? "—"}</td>
                  <td style={{ padding: "5px 8px", color: "var(--text-muted)" }}>{a.owner ?? "—"}</td>
                  <td style={{ padding: "5px 8px", display: "flex", gap: 8 }}>
                    <button onClick={() => setEditing(a)} style={{ color: "var(--brand)", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem" }}>edit</button>
                    <button onClick={() => { if (window.confirm(`Delete "${a.name}"?`)) remove.mutate(a.asset_id); }} style={{ color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer", fontSize: "0.75rem" }}>delete</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Edit modal */}
      {editing && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, padding: 24, maxWidth: 420, width: "100%", margin: "0 16px" }}>
            <h3 style={{ fontWeight: 600, marginBottom: 14 }}>Edit asset</h3>
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {[
                { label: "Name", key: "name", type: "text" },
                { label: "IP address", key: "ip_address", type: "text" },
                { label: "Location", key: "location", type: "text" },
                { label: "Owner", key: "owner", type: "text" },
              ].map(({ label, key, type }) => (
                <label key={key} style={{ fontSize: "0.82rem" }}>
                  {label}
                  <input
                    type={type}
                    defaultValue={(editing as unknown as Record<string, string | null>)[key] ?? ""}
                    onChange={(e) => setEditing((prev) => prev ? { ...prev, [key]: e.target.value } : null)}
                    style={{ display: "block", width: "100%", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 10px", background: "var(--surface-2)", color: "var(--text)", marginTop: 4, fontSize: "0.82rem", boxSizing: "border-box" }}
                  />
                </label>
              ))}
              <label style={{ fontSize: "0.82rem" }}>
                Status
                <select defaultValue={editing.status} onChange={(e) => setEditing((prev) => prev ? { ...prev, status: e.target.value } : null)} style={{ display: "block", width: "100%", border: "1px solid var(--border)", borderRadius: 6, padding: "6px 8px", background: "var(--surface-2)", color: "var(--text)", marginTop: 4, fontSize: "0.82rem" }}>
                  {STATUSES.map((s) => <option key={s}>{s}</option>)}
                </select>
              </label>
            </div>
            <div style={{ display: "flex", gap: 8, marginTop: 16 }}>
              <Button size="sm" onClick={() => update.mutate({ assetId: editing.asset_id, data: { name: editing.name, status: editing.status, ip_address: editing.ip_address ?? undefined, location: editing.location ?? undefined, owner: editing.owner ?? undefined } })} disabled={update.isPending}>
                {update.isPending ? "Saving…" : "Save"}
              </Button>
              <Button variant="secondary" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────

type Tab = "certs" | "assets";

function loadInfraTab(tenantId: string): Tab {
  try {
    const v = localStorage.getItem(`jlm_infra_tab_${tenantId}`);
    return (v === "assets" ? "assets" : "certs");
  } catch { return "certs"; }
}

export function InfraPage({ tenantId }: { tenantId: string }) {
  const [tab, setTab] = useState<Tab>(() => loadInfraTab(tenantId));

  const setAndSaveTab = (t: Tab) => {
    setTab(t);
    try { localStorage.setItem(`jlm_infra_tab_${tenantId}`, t); } catch { /* */ }
  };

  return (
    <div>
      <h2 style={{ fontWeight: 600, marginBottom: 14 }}>Infrastructure Governance</h2>

      <div style={{ display: "flex", gap: 2, marginBottom: 20, borderBottom: "1px solid var(--border)" }}>
        {(["certs", "assets"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setAndSaveTab(t)}
            style={{
              padding: "6px 14px",
              fontSize: "0.82rem",
              fontWeight: tab === t ? 600 : 400,
              color: tab === t ? "var(--brand)" : "var(--text-muted)",
              background: "none",
              border: "none",
              borderBottom: tab === t ? "2px solid var(--brand)" : "2px solid transparent",
              cursor: "pointer",
              marginBottom: -1,
            }}
          >
            {t === "certs" ? "Certificates" : "Asset Inventory"}
          </button>
        ))}
      </div>

      {tab === "certs" && <CertsTab tenantId={tenantId} />}
      {tab === "assets" && <AssetsTab tenantId={tenantId} />}
    </div>
  );
}
