import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Monitor, AppWindow, KeyRound, Package, AlertTriangle, CheckCircle, Clock, XCircle, Plus, Pencil, Trash2 } from "lucide-react";

interface Asset {
  id: string;
  name: string;
  asset_type: "hardware" | "software" | "license";
  category?: string;
  status: "active" | "inactive" | "retired" | "disposed";
  manufacturer?: string;
  model?: string;
  serial_number?: string;
  location?: string;
  purchase_date?: string;
  warranty_expiry?: string;
  version?: string;
  installed_on?: string;
  vendor?: string;
  license_key?: string;
  seats_total?: number;
  seats_used?: number;
  expiry_date?: string;
  assigned_to?: string;
  assigned_to_name?: string;
  tags: string[];
  notes?: string;
  created_at: string;
}

interface Stats {
  total: number;
  hardware: number;
  software: number;
  licenses: number;
  expiring_soon: number;
  expired: number;
}

const EMPTY: Partial<Asset> = {
  name: "", asset_type: "hardware", status: "active",
  tags: [], metadata: {} as never,
};

const STATUS_COLOR: Record<string, string> = {
  active: "#22c55e", inactive: "#6b7280", retired: "#f97316", disposed: "#ef4444",
};

const TYPE_ICON: Record<string, typeof Monitor> = {
  hardware: Monitor, software: AppWindow, license: KeyRound,
};

function StatusBadge({ status }: { status: string }) {
  return (
    <span style={{ background: STATUS_COLOR[status] + "22", color: STATUS_COLOR[status], padding: "2px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600 }}>
      {status}
    </span>
  );
}

function ExpiryBadge({ date }: { date?: string }) {
  if (!date) return null;
  const d = new Date(date);
  const now = new Date();
  const diff = Math.ceil((d.getTime() - now.getTime()) / 86400000);
  if (diff < 0) return <span style={{ background: "#ef444422", color: "#ef4444", padding: "2px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600 }}>Expirado</span>;
  if (diff <= 30) return <span style={{ background: "#eab30822", color: "#eab308", padding: "2px 8px", borderRadius: 4, fontSize: 12, fontWeight: 600 }}>Vence em {diff}d</span>;
  return <span style={{ color: "#6b7280", fontSize: 12 }}>{d.toLocaleDateString("pt-BR")}</span>;
}

function StatCard({ label, value, color, icon: Icon }: { label: string; value: number; color: string; icon: typeof Package }) {
  return (
    <div style={{ background: "var(--card-bg)", border: "1px solid var(--border)", borderRadius: 8, padding: "16px 20px", display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ background: color + "22", borderRadius: 8, padding: 10 }}>
        <Icon size={20} color={color} />
      </div>
      <div>
        <div style={{ fontSize: 24, fontWeight: 700, color: "var(--fg)" }}>{value}</div>
        <div style={{ fontSize: 12, color: "var(--fg-muted)" }}>{label}</div>
      </div>
    </div>
  );
}

type Tab = "all" | "hardware" | "software" | "license";

export function AssetsPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("all");
  const [search, setSearch] = useState("");
  const [modal, setModal] = useState<Partial<Asset> | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const statsQ = useQuery<Stats>({
    queryKey: ["assets-stats", tenantId],
    queryFn: () => api.get(`/assets/stats`).then(r => r.data),
  });

  const assetsQ = useQuery<Asset[]>({
    queryKey: ["assets", tenantId, tab, search],
    queryFn: () => api.get(`/assets/`, {
      params: {
        asset_type: tab === "all" ? undefined : tab,
        search: search || undefined,
        limit: 300,
      },
    }).then(r => r.data),
  });

  const saveMut = useMutation({
    mutationFn: (data: Partial<Asset>) =>
      data.id
        ? api.put(`/assets/${data.id}`, data).then(r => r.data)
        : api.post(`/assets/`, data).then(r => r.data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["assets"] }); qc.invalidateQueries({ queryKey: ["assets-stats"] }); setModal(null); },
  });

  const delMut = useMutation({
    mutationFn: (id: string) => api.delete(`/assets/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["assets"] }); qc.invalidateQueries({ queryKey: ["assets-stats"] }); setDeleting(null); },
  });

  const stats = statsQ.data;
  const assets = assetsQ.data ?? [];

  const tabs: { id: Tab; label: string }[] = [
    { id: "all", label: "Todos" },
    { id: "hardware", label: "Hardware" },
    { id: "software", label: "Software" },
    { id: "license", label: "Licenças" },
  ];

  return (
    <div style={{ padding: 24, display: "flex", flexDirection: "column", gap: 24 }}>
      {/* stat cards */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 12 }}>
        <StatCard label="Total" value={stats?.total ?? 0} color="#6b7280" icon={Package} />
        <StatCard label="Hardware" value={stats?.hardware ?? 0} color="#3b82f6" icon={Monitor} />
        <StatCard label="Software" value={stats?.software ?? 0} color="#8b5cf6" icon={AppWindow} />
        <StatCard label="Licenças" value={stats?.licenses ?? 0} color="#06b6d4" icon={KeyRound} />
        <StatCard label="A vencer (30d)" value={stats?.expiring_soon ?? 0} color="#eab308" icon={Clock} />
        <StatCard label="Expiradas" value={stats?.expired ?? 0} color="#ef4444" icon={XCircle} />
      </div>

      {/* toolbar */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 0, border: "1px solid var(--border)", borderRadius: 6, overflow: "hidden" }}>
          {tabs.map(t => (
            <button key={t.id} onClick={() => setTab(t.id)} style={{
              padding: "6px 14px", border: "none", cursor: "pointer", fontSize: 13, fontWeight: 500,
              background: tab === t.id ? "var(--accent)" : "transparent",
              color: tab === t.id ? "#fff" : "var(--fg)",
            }}>{t.label}</button>
          ))}
        </div>
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Buscar nome, serial, chave..."
          style={{ flex: 1, minWidth: 200, padding: "6px 12px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", fontSize: 13 }}
        />
        <button
          onClick={() => setModal({ ...EMPTY })}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: 600, fontSize: 13 }}
        >
          <Plus size={14} /> Novo ativo
        </button>
      </div>

      {/* table */}
      <div style={{ overflow: "auto", border: "1px solid var(--border)", borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
          <thead>
            <tr style={{ background: "var(--table-head-bg)", borderBottom: "1px solid var(--border)" }}>
              {["Tipo", "Nome", "Categoria", "Fabricante / Vendor", "Serial / Chave", "Status", "Validade", "Responsável", ""].map(h => (
                <th key={h} style={{ padding: "10px 12px", textAlign: "left", fontWeight: 600, color: "var(--fg-muted)", whiteSpace: "nowrap" }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {assets.length === 0 && (
              <tr><td colSpan={9} style={{ padding: 32, textAlign: "center", color: "var(--fg-muted)" }}>Nenhum ativo encontrado</td></tr>
            )}
            {assets.map(a => {
              const Icon = TYPE_ICON[a.asset_type] ?? Package;
              const keyDisplay = a.asset_type === "license"
                ? (a.license_key ? a.license_key.slice(0, 8) + "••••" : "—")
                : (a.serial_number || "—");
              const vendorMfg = a.asset_type === "license" ? (a.vendor || "—") : (a.manufacturer || "—");
              return (
                <tr key={a.id} style={{ borderBottom: "1px solid var(--border)" }}>
                  <td style={{ padding: "10px 12px" }}>
                    <Icon size={16} color={a.asset_type === "hardware" ? "#3b82f6" : a.asset_type === "software" ? "#8b5cf6" : "#06b6d4"} />
                  </td>
                  <td style={{ padding: "10px 12px", fontWeight: 500, color: "var(--fg)" }}>
                    {a.name}
                    {a.model && <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>{a.model}</div>}
                    {a.asset_type === "software" && a.version && <div style={{ fontSize: 11, color: "var(--fg-muted)" }}>v{a.version}</div>}
                  </td>
                  <td style={{ padding: "10px 12px", color: "var(--fg-muted)" }}>{a.category || "—"}</td>
                  <td style={{ padding: "10px 12px", color: "var(--fg-muted)" }}>{vendorMfg}</td>
                  <td style={{ padding: "10px 12px", fontFamily: "monospace", fontSize: 12, color: "var(--fg-muted)" }}>{keyDisplay}</td>
                  <td style={{ padding: "10px 12px" }}><StatusBadge status={a.status} /></td>
                  <td style={{ padding: "10px 12px" }}>
                    {a.asset_type === "license" ? <ExpiryBadge date={a.expiry_date} /> : (a.warranty_expiry ? <ExpiryBadge date={a.warranty_expiry} /> : <span style={{ color: "var(--fg-muted)" }}>—</span>)}
                  </td>
                  <td style={{ padding: "10px 12px", color: "var(--fg-muted)" }}>{a.assigned_to_name || "—"}</td>
                  <td style={{ padding: "10px 12px" }}>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => setModal(a)} style={{ background: "none", border: "none", cursor: "pointer", color: "var(--fg-muted)", padding: 4, borderRadius: 4 }} title="Editar"><Pencil size={14} /></button>
                      <button onClick={() => setDeleting(a.id)} style={{ background: "none", border: "none", cursor: "pointer", color: "#ef4444", padding: 4, borderRadius: 4 }} title="Excluir"><Trash2 size={14} /></button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* modal add/edit */}
      {modal && (
        <div style={{ position: "fixed", inset: 0, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }} onClick={() => setModal(null)}>
          <div style={{ background: "var(--card-bg)", borderRadius: 12, padding: 28, width: 560, maxHeight: "90vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 16 }} onClick={e => e.stopPropagation()}>
            <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "var(--fg)" }}>{modal.id ? "Editar ativo" : "Novo ativo"}</h2>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <div style={{ gridColumn: "1/-1" }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Nome *</label>
                <input value={modal.name ?? ""} onChange={e => setModal(m => ({ ...m!, name: e.target.value }))}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", boxSizing: "border-box" }} />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Tipo *</label>
                <select value={modal.asset_type ?? "hardware"} onChange={e => setModal(m => ({ ...m!, asset_type: e.target.value as Asset["asset_type"] }))}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }}>
                  <option value="hardware">Hardware</option>
                  <option value="software">Software</option>
                  <option value="license">Licença</option>
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Status</label>
                <select value={modal.status ?? "active"} onChange={e => setModal(m => ({ ...m!, status: e.target.value as Asset["status"] }))}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }}>
                  <option value="active">Ativo</option>
                  <option value="inactive">Inativo</option>
                  <option value="retired">Aposentado</option>
                  <option value="disposed">Descartado</option>
                </select>
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Categoria</label>
                <input value={modal.category ?? ""} onChange={e => setModal(m => ({ ...m!, category: e.target.value }))}
                  placeholder={modal.asset_type === "hardware" ? "server, desktop, switch..." : modal.asset_type === "software" ? "antivirus, erp, os..." : "saas, perpetual..."}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
              </div>

              <div>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Localização</label>
                <input value={modal.location ?? ""} onChange={e => setModal(m => ({ ...m!, location: e.target.value }))}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
              </div>

              {/* hardware fields */}
              {modal.asset_type === "hardware" && (<>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Fabricante</label>
                  <input value={modal.manufacturer ?? ""} onChange={e => setModal(m => ({ ...m!, manufacturer: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Modelo</label>
                  <input value={modal.model ?? ""} onChange={e => setModal(m => ({ ...m!, model: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Número de série</label>
                  <input value={modal.serial_number ?? ""} onChange={e => setModal(m => ({ ...m!, serial_number: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Garantia até</label>
                  <input type="date" value={modal.warranty_expiry ?? ""} onChange={e => setModal(m => ({ ...m!, warranty_expiry: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Data de compra</label>
                  <input type="date" value={modal.purchase_date ?? ""} onChange={e => setModal(m => ({ ...m!, purchase_date: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
              </>)}

              {/* software fields */}
              {modal.asset_type === "software" && (<>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Versão</label>
                  <input value={modal.version ?? ""} onChange={e => setModal(m => ({ ...m!, version: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Host instalado</label>
                  <input value={modal.installed_on ?? ""} onChange={e => setModal(m => ({ ...m!, installed_on: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
              </>)}

              {/* license fields */}
              {modal.asset_type === "license" && (<>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Vendor</label>
                  <input value={modal.vendor ?? ""} onChange={e => setModal(m => ({ ...m!, vendor: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Chave de licença</label>
                  <input value={modal.license_key ?? ""} onChange={e => setModal(m => ({ ...m!, license_key: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Seats total</label>
                  <input type="number" value={modal.seats_total ?? ""} onChange={e => setModal(m => ({ ...m!, seats_total: parseInt(e.target.value) || undefined }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Seats em uso</label>
                  <input type="number" value={modal.seats_used ?? ""} onChange={e => setModal(m => ({ ...m!, seats_used: parseInt(e.target.value) || undefined }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
                <div>
                  <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Validade</label>
                  <input type="date" value={modal.expiry_date ?? ""} onChange={e => setModal(m => ({ ...m!, expiry_date: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)" }} />
                </div>
              </>)}

              <div style={{ gridColumn: "1/-1" }}>
                <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--fg-muted)", marginBottom: 4 }}>Observações</label>
                <textarea value={modal.notes ?? ""} onChange={e => setModal(m => ({ ...m!, notes: e.target.value }))} rows={2}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 6, border: "1px solid var(--border)", background: "var(--input-bg)", color: "var(--fg)", resize: "vertical", boxSizing: "border-box" }} />
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10, marginTop: 4 }}>
              <button onClick={() => setModal(null)} style={{ padding: "7px 16px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--fg)", cursor: "pointer" }}>Cancelar</button>
              <button
                onClick={() => saveMut.mutate(modal)}
                disabled={saveMut.isPending || !modal.name}
                style={{ padding: "7px 16px", borderRadius: 6, border: "none", background: "var(--accent)", color: "#fff", cursor: "pointer", fontWeight: 600 }}
              >
                {saveMut.isPending ? "Salvando..." : "Salvar"}
              </button>
            </div>
            {saveMut.isError && <p style={{ color: "#ef4444", fontSize: 13, margin: 0 }}>Erro ao salvar. Verifique os dados.</p>}
          </div>
        </div>
      )}

      {/* confirm delete */}
      {deleting && (
        <div style={{ position: "fixed", inset: 0, background: "#0008", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 }}>
          <div style={{ background: "var(--card-bg)", borderRadius: 12, padding: 28, width: 360, display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <AlertTriangle size={20} color="#ef4444" />
              <h3 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--fg)" }}>Excluir ativo?</h3>
            </div>
            <p style={{ margin: 0, fontSize: 14, color: "var(--fg-muted)" }}>Esta ação não pode ser desfeita.</p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
              <button onClick={() => setDeleting(null)} style={{ padding: "7px 16px", borderRadius: 6, border: "1px solid var(--border)", background: "transparent", color: "var(--fg)", cursor: "pointer" }}>Cancelar</button>
              <button onClick={() => delMut.mutate(deleting!)} disabled={delMut.isPending}
                style={{ padding: "7px 16px", borderRadius: 6, border: "none", background: "#ef4444", color: "#fff", cursor: "pointer", fontWeight: 600 }}>
                {delMut.isPending ? "Excluindo..." : "Excluir"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
