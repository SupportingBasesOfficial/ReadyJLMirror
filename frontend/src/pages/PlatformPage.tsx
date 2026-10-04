import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Card, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

interface BrandingCfg {
  configured: boolean;
  brand_name?: string;
  brand_color?: string;
  logo_url?: string;
}

function BrandingCard({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [color, setColor] = useState("#6366f1");
  const [logoUrl, setLogoUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["branding", tenantId],
    queryFn: () => api.get<BrandingCfg>("/api/v1/platform/branding"),
  });

  const mut = useMutation({
    mutationFn: () =>
      api.put("/api/v1/platform/branding", {
        brand_name: name.trim() || null,
        brand_color: color || null,
        logo_url: logoUrl.trim() || null,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["branding", tenantId] });
      setEditing(false);
    },
    onError: (e: unknown) => setErr((e as Error)?.message ?? "Save failed."),
  });

  const cfg = q.data;

  function startEdit() {
    setName(cfg?.brand_name ?? "");
    setColor(cfg?.brand_color ?? "#6366f1");
    setLogoUrl(cfg?.logo_url ?? "");
    setErr(null);
    setEditing(true);
  }

  return (
    <Card className="flex flex-col gap-3">
      <CardHeader>
        <span className="text-sm font-medium">White-label Branding</span>
        {cfg?.configured && <Badge variant="success">configured</Badge>}
      </CardHeader>

      {q.isLoading ? (
        <Spinner className="w-4 h-4" />
      ) : !editing ? (
        <div className="space-y-2">
          {cfg?.configured ? (
            <dl className="space-y-1.5">
              {cfg.brand_name && (
                <div className="flex justify-between text-xs">
                  <dt className="text-[var(--text-muted)]">Name</dt>
                  <dd className="text-[var(--text)]">{cfg.brand_name}</dd>
                </div>
              )}
              {cfg.brand_color && (
                <div className="flex justify-between text-xs items-center">
                  <dt className="text-[var(--text-muted)]">Color</dt>
                  <dd className="flex items-center gap-1.5">
                    <span
                      className="w-3 h-3 rounded-full inline-block border border-[var(--border)]"
                      style={{ background: cfg.brand_color }}
                    />
                    <span className="font-mono text-[var(--text)]">{cfg.brand_color}</span>
                  </dd>
                </div>
              )}
              {cfg.logo_url && (
                <div className="flex justify-between text-xs">
                  <dt className="text-[var(--text-muted)]">Logo</dt>
                  <dd className="text-[var(--text-muted)] font-mono text-[10px] truncate max-w-[160px]">
                    {cfg.logo_url}
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">
              Not configured. Set a brand name, color, and logo for white-label deployments.
            </p>
          )}
          <Button size="sm" variant="secondary" onClick={startEdit}>
            {cfg?.configured ? "Edit" : "Configure"}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <label className="text-[10px] text-[var(--text-muted)]">Platform name</label>
            <input type="text" value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Operations"
              maxLength={80}
              className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
            />
          </div>
          <div className="space-y-0.5">
            <label className="text-[10px] text-[var(--text-muted)]">Brand color (hex)</label>
            <div className="flex gap-2 items-center">
              <input type="color" value={color}
                onChange={(e) => setColor(e.target.value)}
                className="w-8 h-7 rounded border border-[var(--border)] cursor-pointer bg-transparent"
              />
              <input type="text" value={color}
                onChange={(e) => setColor(e.target.value)}
                placeholder="#6366f1"
                maxLength={7}
                className="flex-1 text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] font-mono focus:outline-none focus:border-[var(--brand)]"
              />
            </div>
          </div>
          <div className="space-y-0.5">
            <label className="text-[10px] text-[var(--text-muted)]">Logo URL (optional)</label>
            <input type="text" value={logoUrl}
              onChange={(e) => setLogoUrl(e.target.value)}
              placeholder="https://cdn.example.com/logo.svg"
              maxLength={2048}
              className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
            />
          </div>
          {err && <p className="text-[10px] text-[var(--red)]">{err}</p>}
          <div className="flex gap-2">
            <Button size="sm" onClick={() => { setErr(null); mut.mutate(); }}
              disabled={mut.isPending}>
              {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

interface HealthReady {
  status: "ready" | "degraded" | "not_ready";
  environment: string;
  dependencies: {
    database?: { state: string; mode: string };
    workers?: { state: string; mode: string; seconds_stale?: number };
  };
}

interface Health {
  status: string;
  environment: string;
}

function stateVariant(state: string): "success" | "warning" | "danger" | "muted" {
  if (state === "ok" || state === "ready") return "success";
  if (state === "degraded" || state === "stale") return "warning";
  if (state === "unavailable" || state === "not_ready" || state === "failed") return "danger";
  return "muted";
}

function OutcomeList({ outcomes }: { outcomes: string[] }) {
  const descriptions: Record<string, string> = {
    safe_recoverable: "Safe to deploy — rollback available and all evidence current",
    safe_forward_only: "Safe to deploy — no rollback path, forward-only migration",
    unsafe: "Deployment blocked — evidence gaps or security concerns",
    ambiguous: "Classification inconclusive — human review required",
  };

  return (
    <ul className="space-y-2">
      {outcomes.map((o) => (
        <li key={o} className="flex items-start gap-2">
          <span className="font-mono text-xs text-[var(--brand)] mt-0.5">{o}</span>
          <span className="text-xs text-[var(--text-muted)]">{descriptions[o] ?? ""}</span>
        </li>
      ))}
    </ul>
  );
}

interface StatusPageCfg {
  configured: boolean;
  status_slug?: string;
  public_name?: string;
  enabled?: boolean;
  public_url?: string;
}

function StatusPageCard({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery({
    queryKey: ["status-page-cfg", tenantId],
    queryFn: () => api.get<StatusPageCfg>("/api/v1/platform/status-page"),
  });

  const mut = useMutation({
    mutationFn: () =>
      api.put("/api/v1/platform/status-page", {
        status_slug: slug.trim(),
        public_name: name.trim(),
        enabled,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["status-page-cfg", tenantId] });
      setEditing(false);
    },
    onError: (e: unknown) => {
      setErr((e as { detail?: string })?.detail ?? "Failed to save.");
    },
  });

  const cfg = q.data;

  function startEdit() {
    setSlug(cfg?.status_slug ?? "");
    setName(cfg?.public_name ?? "");
    setEnabled(cfg?.enabled ?? true);
    setErr(null);
    setEditing(true);
  }

  return (
    <Card className="flex flex-col gap-3">
      <CardHeader>
        <span className="text-sm font-medium">Public Status Page</span>
        {cfg?.configured && (
          <Badge variant={cfg.enabled ? "success" : "muted"}>
            {cfg.enabled ? "enabled" : "disabled"}
          </Badge>
        )}
      </CardHeader>

      {q.isLoading ? (
        <Spinner className="w-4 h-4" />
      ) : !editing ? (
        <div className="space-y-2">
          {cfg?.configured ? (
            <>
              <div className="flex justify-between text-xs">
                <span className="text-[var(--text-muted)]">URL</span>
                <a
                  href={cfg.public_url}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[var(--brand)] hover:underline"
                >
                  {cfg.public_url}
                </a>
              </div>
              <div className="flex justify-between text-xs">
                <span className="text-[var(--text-muted)]">Name</span>
                <span className="text-[var(--text)]">{cfg.public_name}</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-[var(--text-muted)]">
              Not configured. Set up a public URL for customers to check service status.
            </p>
          )}
          <Button size="sm" variant="secondary" onClick={startEdit}>
            {cfg?.configured ? "Edit" : "Configure"}
          </Button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="space-y-0.5">
            <label className="text-[10px] text-[var(--text-muted)]">Slug (URL)</label>
            <input
              type="text"
              value={slug}
              onChange={(e) => setSlug(e.target.value.toLowerCase())}
              placeholder="my-company"
              className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
            />
            {slug && (
              <p className="text-[10px] text-[var(--text-muted)]">
                /status/{slug}
              </p>
            )}
          </div>
          <div className="space-y-0.5">
            <label className="text-[10px] text-[var(--text-muted)]">Public name</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Acme Corp"
              className="w-full text-xs bg-[var(--surface-2)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text)] focus:outline-none focus:border-[var(--brand)]"
            />
          </div>
          <label className="flex items-center gap-2 text-xs cursor-pointer">
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
              className="w-3 h-3"
            />
            Enabled (publicly accessible)
          </label>
          {err && <p className="text-[10px] text-[var(--red)]">{err}</p>}
          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => { setErr(null); mut.mutate(); }}
              disabled={mut.isPending || !slug.trim() || !name.trim()}
            >
              {mut.isPending ? <Spinner className="w-3 h-3 mr-1" /> : null}Save
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

export function PlatformPage({ tenantId: _tenantId }: { tenantId: string }) {
  const tenantId = _tenantId;
  const healthQ = useQuery({
    queryKey: ["health-ready"],
    queryFn: () => api.get<HealthReady>("/health/ready"),
    refetchInterval: 30_000,
    retry: false,
  });

  const healthLiveQ = useQuery({
    queryKey: ["health-live"],
    queryFn: () => api.get<Health>("/health"),
    retry: false,
  });

  const outcomesQ = useQuery({
    queryKey: ["release-outcomes"],
    queryFn: () => api.get<string[]>("/api/v1/release/outcomes"),
  });

  const h = healthQ.data;
  const env = healthLiveQ.data?.environment ?? h?.environment ?? "unknown";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold">Platform</h2>
          <p className="text-[10px] text-[var(--text-muted)] mt-0.5">
            System health · release classification vocabulary
          </p>
        </div>
        {(healthQ.isFetching) && <Spinner className="w-3 h-3" />}
      </div>

      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
        {/* System health */}
        <Card className="flex flex-col gap-3">
          <CardHeader>
            <span className="text-sm font-medium">System health</span>
            {h && (
              <Badge variant={stateVariant(h.status)}>
                {h.status.replace("_", " ")}
              </Badge>
            )}
          </CardHeader>

          {healthQ.isLoading ? (
            <Spinner className="w-4 h-4" />
          ) : healthQ.isError ? (
            <p className="text-xs text-[var(--red)]">Health check unavailable.</p>
          ) : h ? (
            <dl className="space-y-2">
              <div className="flex justify-between text-xs">
                <dt className="text-[var(--text-muted)]">Environment</dt>
                <dd className="font-mono text-[var(--text)]">{env}</dd>
              </div>
              {h.dependencies?.database && (
                <div className="flex justify-between text-xs">
                  <dt className="text-[var(--text-muted)]">Database</dt>
                  <dd>
                    <Badge variant={stateVariant(h.dependencies.database.state)}>
                      {h.dependencies.database.state}
                    </Badge>
                  </dd>
                </div>
              )}
              {h.dependencies?.workers && (
                <div className="flex justify-between text-xs">
                  <dt className="text-[var(--text-muted)]">Workers</dt>
                  <dd>
                    <Badge variant={stateVariant(h.dependencies.workers.state)}>
                      {h.dependencies.workers.state}
                      {h.dependencies.workers.seconds_stale !== undefined
                        ? ` (${Math.round(h.dependencies.workers.seconds_stale)}s)`
                        : ""}
                    </Badge>
                  </dd>
                </div>
              )}
            </dl>
          ) : null}
        </Card>

        {/* Production readiness */}
        <Card className="flex flex-col gap-3">
          <CardHeader>
            <span className="text-sm font-medium">Production gate</span>
            <Badge variant={env === "production" ? "success" : "warning"}>
              {env === "production" ? "production" : "not production"}
            </Badge>
          </CardHeader>
          <div className="space-y-1.5 text-xs text-[var(--text-muted)]">
            <p>Run the preflight script before promoting to production:</p>
            <pre className="text-[10px] bg-[var(--surface-2)] border border-[var(--border)] rounded p-2 overflow-x-auto whitespace-pre">
              python -m scripts.production_preflight
            </pre>
            <p className="mt-2">
              The script validates environment, TLS, secrets, DB connectivity,
              worker heartbeat, and migration state. Exit 0 = authorized.
            </p>
          </div>
        </Card>

        {/* Status Page */}
        <StatusPageCard tenantId={tenantId} />

        {/* Branding */}
        <BrandingCard tenantId={tenantId} />

        {/* Release outcomes */}
        <Card className="flex flex-col gap-3">
          <CardHeader>
            <span className="text-sm font-medium">Release outcome classes</span>
            {outcomesQ.isFetching && <Spinner className="w-3 h-3" />}
          </CardHeader>
          {outcomesQ.isLoading ? (
            <Spinner className="w-4 h-4" />
          ) : outcomesQ.isError ? (
            <p className="text-xs text-[var(--red)]">Unavailable.</p>
          ) : outcomesQ.data ? (
            <OutcomeList outcomes={outcomesQ.data} />
          ) : null}
        </Card>
      </div>
    </div>
  );
}
