import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";

const AVAILABLE_SCOPES = ["read", "write", "admin"] as const;

interface ApiKey {
  key_id: string;
  label: string;
  scopes: string[];
  state: "active" | "revoked";
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
}

function fmtTs(iso?: string | null) {
  if (!iso) return "never";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function fmtDate(iso?: string | null) {
  if (!iso) return "—";
  try { return new Date(iso).toLocaleDateString(); } catch { return iso; }
}

function NewKeyModal({
  rawKey,
  onClose,
}: {
  rawKey: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);

  function copy() {
    navigator.clipboard.writeText(rawKey).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  return (
    <div className="fixed inset-0 flex items-center justify-center z-50 bg-black/60 p-4">
      <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl p-6 max-w-lg w-full shadow-2xl">
        <h3 className="text-sm font-semibold mb-1">API key created</h3>
        <p className="text-xs text-[var(--text-muted)] mb-4">
          Copy this key now — it will not be shown again.
        </p>
        <div className="flex gap-2 items-center bg-[var(--surface-2)] border border-[var(--border)] rounded-lg px-3 py-2 mb-4">
          <code className="text-xs text-[var(--brand)] flex-1 break-all select-all">
            {rawKey}
          </code>
          <button
            onClick={copy}
            className="text-xs text-[var(--text-muted)] hover:text-[var(--text)] shrink-0 px-2 py-1 rounded border border-[var(--border)] hover:border-[var(--brand)]"
          >
            {copied ? "Copied!" : "Copy"}
          </button>
        </div>
        <p className="text-[10px] text-[var(--red)] mb-4">
          Store it in a secrets manager. This is the only time it will be displayed.
        </p>
        <Button className="w-full" onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

function CreateKeyForm({
  onCreated,
}: {
  onCreated: (rawKey: string) => void;
}) {
  const [label, setLabel] = useState("");
  const [scopes, setScopes] = useState<string[]>(["read"]);
  const [expiresAt, setExpiresAt] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const qc = useQueryClient();
  const { toast } = useToast();

  function toggleScope(s: string) {
    setScopes((prev) =>
      prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s],
    );
  }

  const mut = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { label, scopes };
      if (expiresAt) body.expires_at = new Date(expiresAt).toISOString();
      return api.post<{ raw_key: string }>("/api/v1/api-keys", body);
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      setLabel("");
      setScopes(["read"]);
      setExpiresAt("");
      toast("Chave criada", "success");
      onCreated(data.raw_key);
    },
    onError: (e: unknown) => {
      const msg = (e as Error)?.message ?? "Failed to create key.";
      setErr(msg);
      toast(msg, "error");
    },
  });

  return (
    <div className="space-y-3">
      <div className="flex gap-2 items-end flex-wrap">
        <div className="flex-1 min-w-[160px] space-y-0.5">
          <label className="text-[10px] text-[var(--text-muted)]">Label</label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && label.trim() && scopes.length > 0 && mut.mutate()}
            placeholder="CI pipeline"
            maxLength={80}
            className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
          />
        </div>
        <div className="space-y-0.5">
          <label className="text-[10px] text-[var(--text-muted)]">Expira em (opcional)</label>
          <input
            type="date"
            value={expiresAt}
            onChange={(e) => setExpiresAt(e.target.value)}
            className="text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1.5 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
          />
        </div>
        <Button
          size="sm"
          onClick={() => { setErr(null); mut.mutate(); }}
          disabled={!label.trim() || scopes.length === 0 || mut.isPending}
        >
          {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}
          Create
        </Button>
      </div>

      <div className="flex gap-4 items-center">
        <span className="text-[10px] text-[var(--text-muted)]">Scopes:</span>
        {AVAILABLE_SCOPES.map((s) => (
          <label key={s} className="flex items-center gap-1 cursor-pointer text-xs">
            <input
              type="checkbox"
              checked={scopes.includes(s)}
              onChange={() => toggleScope(s)}
              className="cursor-pointer"
            />
            {s}
          </label>
        ))}
      </div>

      {err && <p className="text-[10px] text-[var(--red)]">{err}</p>}
    </div>
  );
}

export function ApiKeysPage({ tenantId }: { tenantId: string }) {
  const [pendingRawKey, setPendingRawKey] = useState<string | null>(null);
  const [locallyRemoved, setLocallyRemoved] = useState<Set<string>>(new Set());
  const qc = useQueryClient();
  const { toast } = useToast();

  const keysQ = useQuery({
    queryKey: ["api-keys", tenantId],
    queryFn: () => api.get<ApiKey[]>("/api/v1/api-keys"),
  });

  const revoke = useMutation({
    mutationFn: (key_id: string) => api.delete(`/api/v1/api-keys/${key_id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["api-keys"] });
      toast("Chave revogada", "success");
    },
    onError: (e: unknown) => {
      toast((e as Error)?.message ?? "Erro ao revogar chave.", "error");
    },
  });

  const keys = (keysQ.data ?? []).filter((k) => !locallyRemoved.has(k.key_id));
  const active = keys.filter((k) => k.state === "active");
  const revoked = keys.filter((k) => k.state === "revoked");

  return (
    <div className="space-y-4">
      {pendingRawKey && (
        <NewKeyModal
          rawKey={pendingRawKey}
          onClose={() => setPendingRawKey(null)}
        />
      )}

      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">API Keys</h2>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            Bearer tokens for programmatic read access · 60 req/min per key
          </p>
        </div>
        {keysQ.isFetching && <Spinner className="w-3 h-3" />}
      </div>

      <Card className="flex flex-col gap-3">
        <CardHeader>
          <span className="text-sm font-medium">Create API key</span>
        </CardHeader>
        <CreateKeyForm onCreated={setPendingRawKey} />
        <p className="text-[10px] text-[var(--text-muted)]">
          Use with:{" "}
          <code className="text-[var(--brand)]">
            Authorization: Bearer jlm_…
          </code>
        </p>
      </Card>

      {keysQ.isLoading ? (
        <div className="flex justify-center py-6"><Spinner /></div>
      ) : keysQ.isError ? (
        <p className="text-xs text-[var(--red)]">Failed to load keys.</p>
      ) : (
        <>
          {active.length === 0 && revoked.length === 0 ? (
            <p className="text-xs text-[var(--text-muted)]">No API keys yet.</p>
          ) : (
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-xs">
                <thead className="bg-[var(--surface-2)]">
                  <tr className="text-left text-[var(--text-muted)] uppercase tracking-wider text-[10px]">
                    <th className="px-4 py-2.5 font-medium">Label</th>
                    <th className="px-4 py-2.5 font-medium">Scopes</th>
                    <th className="px-4 py-2.5 font-medium">Last used</th>
                    <th className="px-4 py-2.5 font-medium">Created</th>
                    <th className="px-4 py-2.5 font-medium">State</th>
                    <th className="px-4 py-2.5 font-medium"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {keys.map((k) => (
                    <tr key={k.key_id}
                      className="hover:bg-[var(--surface-2)] transition-colors">
                      <td className="px-4 py-2.5 font-medium text-[var(--text)]">
                        {k.label}
                      </td>
                      <td className="px-4 py-2.5">
                        <div className="flex gap-1 flex-wrap">
                          {k.scopes.map((s) => (
                            <span key={s}
                              className="text-[10px] bg-[var(--surface-2)] border border-[var(--border)] px-1.5 py-0.5 rounded font-mono">
                              {s}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                        {fmtTs(k.last_used_at)}
                      </td>
                      <td className="px-4 py-2.5 text-[var(--text-muted)] whitespace-nowrap">
                        {fmtDate(k.created_at)}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge variant={k.state === "active" ? "success" : "muted"}>
                          {k.state}
                        </Badge>
                      </td>
                      <td className="px-4 py-2.5">
                        {k.state === "active" ? (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() => revoke.mutate(k.key_id)}
                            disabled={revoke.isPending}
                          >
                            Revoke
                          </Button>
                        ) : (
                          <Button
                            size="sm"
                            variant="secondary"
                            onClick={() =>
                              setLocallyRemoved((prev) => new Set([...prev, k.key_id]))
                            }
                          >
                            Remover da lista
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}
        </>
      )}
    </div>
  );
}
