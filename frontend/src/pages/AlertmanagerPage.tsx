import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ConfirmModal } from "@/components/ui/confirm-modal";

interface Source {
  source_id: string;
  display_name: string;
  enabled: boolean;
  created_at: string;
}

interface AlertEvent {
  event_id: string;
  fingerprint: string;
  alert_name: string;
  severity: string;
  status: string;
  labels: Record<string, string>;
  annotations: Record<string, string>;
  starts_at: string | null;
  received_at: string;
}

const SEV_COLOR: Record<string, string> = {
  critical: "var(--red)",
  warning: "#f59e0b",
  info: "var(--brand)",
  ok: "var(--green, #22c55e)",
};

function SevBadge({ sev }: { sev: string }) {
  return (
    <span
      style={{
        color: SEV_COLOR[sev] ?? "var(--text-muted)",
        fontWeight: 600,
        textTransform: "uppercase",
        fontSize: "0.7rem",
      }}
    >
      {sev}
    </span>
  );
}

function StatusBadge({ status }: { status: string }) {
  const color = status === "firing" ? "var(--red)" : "var(--text-muted)";
  return (
    <span style={{ color, fontWeight: 500, fontSize: "0.7rem" }}>
      {status === "firing" ? "● FIRING" : "✓ RESOLVED"}
    </span>
  );
}

function EventsPanel({
  source,
  tenantId: _tenantId,
}: {
  source: Source;
  tenantId: string;
}) {
  const { data: events = [], isLoading } = useQuery<AlertEvent[]>({
    queryKey: ["amgr-events", source.source_id],
    queryFn: () =>
      api.get<AlertEvent[]>(`/api/v1/sources/alertmanager/${source.source_id}/events`),
    refetchInterval: 30_000,
  });

  const baseUrl =
    typeof window !== "undefined"
      ? `${window.location.protocol}//${window.location.hostname}${
          window.location.port ? `:${window.location.port}` : ""
        }`
      : "";

  const webhookUrl = `${baseUrl}/api/v1/sources/alertmanager/${source.source_id}/ingest`;

  return (
    <div>
      <div
        style={{
          background: "var(--surface-2)",
          border: "1px solid var(--border)",
          borderRadius: 8,
          padding: "10px 14px",
          marginBottom: 16,
          fontSize: "0.82rem",
        }}
      >
        <div style={{ color: "var(--text-muted)", marginBottom: 4 }}>
          Alertmanager webhook URL
        </div>
        <code
          style={{
            wordBreak: "break-all",
            color: "var(--text)",
            userSelect: "all",
          }}
        >
          {webhookUrl}
        </code>
        <div
          style={{ color: "var(--text-muted)", marginTop: 6, fontSize: "0.75rem" }}
        >
          Set{" "}
          <code style={{ color: "var(--text)" }}>X-JLM-Webhook-Secret</code>{" "}
          header to the token shown at source creation.
        </div>
      </div>

      {isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          Loading events…
        </div>
      ) : events.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          No events received yet.
        </div>
      ) : (
        <div style={{ overflowX: "auto" }}>
          <table
            style={{
              width: "100%",
              borderCollapse: "collapse",
              fontSize: "0.82rem",
            }}
          >
            <thead>
              <tr style={{ borderBottom: "1px solid var(--border)" }}>
                {["Alert", "Severity", "Status", "Received"].map((h) => (
                  <th
                    key={h}
                    style={{
                      textAlign: "left",
                      padding: "4px 8px",
                      fontWeight: 600,
                      color: "var(--text-muted)",
                    }}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {events.map((e) => (
                <tr
                  key={e.event_id}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <td style={{ padding: "5px 8px", fontWeight: 500 }}>
                    {e.alert_name}
                  </td>
                  <td style={{ padding: "5px 8px" }}>
                    <SevBadge sev={e.severity} />
                  </td>
                  <td style={{ padding: "5px 8px" }}>
                    <StatusBadge status={e.status} />
                  </td>
                  <td
                    style={{
                      padding: "5px 8px",
                      color: "var(--text-muted)",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {new Date(e.received_at).toLocaleString()}
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

function CreateSourceForm({
  tenantId: _tenantId,
  onCreated,
}: {
  tenantId: string;
  onCreated: (token: string, sourceId: string, name: string) => void;
}) {
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: (displayName: string) =>
      api.post<{ token: string; source_id: string; display_name: string }>(
        "/api/v1/sources/alertmanager", { display_name: displayName }),
    onSuccess: (data) => {
      onCreated(data.token, data.source_id, data.display_name);
      setName("");
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) create.mutate(name.trim());
      }}
      style={{ display: "flex", gap: 8, marginBottom: 16 }}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Source name (e.g. prod-cluster)"
        style={{
          flex: 1,
          border: "1px solid var(--border)",
          borderRadius: 6,
          padding: "6px 10px",
          background: "var(--surface-2)",
          color: "var(--text)",
          fontSize: "0.82rem",
        }}
      />
      <Button
        type="submit"
        disabled={!name.trim() || create.isPending}
        size="sm"
      >
        {create.isPending ? "Creating…" : "Add source"}
      </Button>
    </form>
  );
}

function TokenModal({
  token,
  sourceId: _sourceId,
  name: _name,
  onClose,
}: {
  token: string;
  sourceId: string;
  name: string;
  onClose: () => void;
}) {
  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.5)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 50,
      }}
    >
      <div
        style={{
          background: "var(--surface)",
          border: "1px solid var(--border)",
          borderRadius: 12,
          padding: 24,
          maxWidth: 520,
          width: "100%",
          margin: "0 16px",
        }}
      >
        <h3 style={{ fontWeight: 600, marginBottom: 4 }}>
          Source created — save your token
        </h3>
        <p
          style={{
            color: "var(--text-muted)",
            fontSize: "0.82rem",
            marginBottom: 16,
          }}
        >
          This is the only time the token is shown. Copy it now and configure
          Alertmanager to send it as{" "}
          <code style={{ color: "var(--text)" }}>X-JLM-Webhook-Secret</code>.
        </p>
        <div
          style={{
            background: "var(--surface-2)",
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: "10px 14px",
            fontFamily: "monospace",
            wordBreak: "break-all",
            userSelect: "all",
            marginBottom: 16,
            fontSize: "0.85rem",
          }}
        >
          {token}
        </div>
        <Button onClick={onClose}>Done</Button>
      </div>
    </div>
  );
}

export function AlertmanagerPage({ tenantId }: { tenantId: string }) {
  const qc = useQueryClient();
  const { toast } = useToast();
  const [selectedSource, setSelectedSource] = useState<Source | null>(null);
  const [newToken, setNewToken] = useState<{
    token: string;
    sourceId: string;
    name: string;
  } | null>(null);
  const [confirmDisableId, setConfirmDisableId] = useState<string | null>(null);

  const { data: sources = [], isLoading } = useQuery<Source[]>({
    queryKey: ["amgr-sources", tenantId],
    queryFn: () =>
      api.get<Source[]>("/api/v1/sources/alertmanager"),
  });

  const disable = useMutation({
    mutationFn: (sourceId: string) =>
      api.delete(`/api/v1/sources/alertmanager/${sourceId}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["amgr-sources"] });
      if (selectedSource) setSelectedSource(null);
      setConfirmDisableId(null);
      toast("Fonte desabilitada", "success");
    },
    onError: () => toast("Erro ao desabilitar", "error"),
  });

  const rotate = useMutation({
    mutationFn: (sourceId: string) =>
      api.post<{ token: string; source_id: string }>(
        `/api/v1/sources/alertmanager/${sourceId}/rotate-token`),
    onSuccess: (data) => {
      setNewToken({ token: data.token, sourceId: data.source_id, name: "" });
      toast("Token rotacionado", "success");
    },
    onError: () => toast("Erro ao rotacionar", "error"),
  });

  return (
    <div>
      {newToken && (
        <TokenModal
          token={newToken.token}
          sourceId={newToken.sourceId}
          name={newToken.name}
          onClose={() => setNewToken(null)}
        />
      )}

      {confirmDisableId && (
        <ConfirmModal
          title="Desabilitar fonte"
          description={`Desabilitar "${sources.find((s) => s.source_id === confirmDisableId)?.display_name ?? confirmDisableId}"? O ingest vai parar de aceitar eventos.`}
          confirmLabel="Desabilitar"
          destructive
          isPending={disable.isPending}
          onConfirm={() => disable.mutate(confirmDisableId)}
          onCancel={() => setConfirmDisableId(null)}
        />
      )}

      <h2 style={{ fontWeight: 600, marginBottom: 4 }}>Alertmanager Sources</h2>
      <p
        style={{
          color: "var(--text-muted)",
          fontSize: "0.82rem",
          marginBottom: 16,
        }}
      >
        Each source gets a unique webhook URL and pre-shared token. Configure
        Alertmanager's webhook receiver to POST to the URL with the token as the{" "}
        <code style={{ color: "var(--text)" }}>X-JLM-Webhook-Secret</code>{" "}
        header.
      </p>

      <CreateSourceForm
        tenantId={tenantId}
        onCreated={(token, sourceId, name) => {
          qc.invalidateQueries({ queryKey: ["amgr-sources"] });
          setNewToken({ token, sourceId, name });
        }}
      />

      {isLoading ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          Loading…
        </div>
      ) : sources.length === 0 ? (
        <div style={{ color: "var(--text-muted)", fontSize: "0.82rem" }}>
          No sources configured.
        </div>
      ) : (
        <div style={{ display: "flex", gap: 16 }}>
          {/* Source list */}
          <div style={{ width: 220, flexShrink: 0 }}>
            {sources.map((s) => (
              <div
                key={s.source_id}
                onClick={() => setSelectedSource(s)}
                style={{
                  padding: "8px 12px",
                  borderRadius: 8,
                  border: "1px solid var(--border)",
                  marginBottom: 6,
                  cursor: "pointer",
                  background:
                    selectedSource?.source_id === s.source_id
                      ? "var(--surface-2)"
                      : "transparent",
                  opacity: s.enabled ? 1 : 0.5,
                }}
              >
                <div style={{ fontWeight: 500, fontSize: "0.85rem" }}>
                  {s.display_name}
                </div>
                {!s.enabled && (
                  <div
                    style={{ fontSize: "0.7rem", color: "var(--text-muted)" }}
                  >
                    disabled
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* Source detail */}
          {selectedSource ? (
            <div
              style={{
                flex: 1,
                background: "var(--surface)",
                border: "1px solid var(--border)",
                borderRadius: 10,
                padding: 16,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 14,
                }}
              >
                <h3 style={{ fontWeight: 600 }}>{selectedSource.display_name}</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => rotate.mutate(selectedSource.source_id)}
                    disabled={rotate.isPending}
                  >
                    {rotate.isPending ? <Spinner className="w-3 h-3" /> : "Rotate token"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => setConfirmDisableId(selectedSource.source_id)}
                    disabled={disable.isPending}
                  >
                    {disable.isPending ? <Spinner className="w-3 h-3" /> : "Disable"}
                  </Button>
                </div>
              </div>

              <EventsPanel source={selectedSource} tenantId={tenantId} />
            </div>
          ) : (
            <div
              style={{
                flex: 1,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--text-muted)",
                fontSize: "0.82rem",
              }}
            >
              Select a source to view its webhook URL and recent events.
            </div>
          )}
        </div>
      )}
    </div>
  );
}
