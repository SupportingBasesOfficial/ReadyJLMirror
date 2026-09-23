"""Prometheus text exposition (ADR-017) — /metrics on the API.

Two metric families, one render pass:

- **Durable state gauges** — `monitoring.ops_metrics()` aggregates
  pipeline state in PostgreSQL at scrape time: queue depth by op
  state, outbox dispatch, inbox receipts, alert lifecycle,
  notification intents, source evidence, resource presence, problems,
  and worker heartbeat staleness. Because the pipeline is
  DB-authoritative these gauges are exact — no in-process counter
  can drift from them, and a dead worker is visible as heartbeat
  staleness even though it cannot scrape itself.

- **HTTP observations** — the in-process SLO probe (`shared.slo`)
  exported as request counts, error counts, and p50/p95/p99 gauges
  per endpoint class.

The exposition format is emitted directly — it is a stable,
line-oriented format and hand-rolling keeps the dependency surface
at zero while staying wire-correct for any Prometheus-compatible
scraper.
"""

from __future__ import annotations

from shared import slo


def _esc(value: str) -> str:
    return value.replace("\\", "\\\\").replace('"', '\\"').replace(
        "\n", "\\n")


def _metric(name: str, value, labels: dict | None = None) -> str:
    if labels:
        inner = ",".join(f'{k}="{_esc(str(v))}"' for k, v in
                         sorted(labels.items()))
        return f"{name}{{{inner}}} {value}"
    return f"{name} {value}"


def _help_type(name: str, help_text: str, mtype: str) -> str:
    return f"# HELP {name} {help_text}\n# TYPE {name} {mtype}"


def _labeled(out: list, name: str, help_text: str, rows,
             label: str = "state") -> None:
    if not rows:
        return
    out.append(_help_type(name, help_text, "gauge"))
    for row in rows:
        out.append(_metric(name, row["n"], {label: row["state"]}))


def render(db: dict, http: dict | None = None) -> str:
    """Render the exposition body from an ops_metrics() result plus
    the SLO probe snapshot (defaults to the live probe)."""
    out: list[str] = []

    _labeled(out, "jlmirror_sync_operations",
             "Sync operations by lifecycle state.",
             db.get("sync_operations"))
    _labeled(out, "jlmirror_outbox_messages",
             "Outbox messages by dispatch state.", db.get("outbox"))
    _labeled(out, "jlmirror_inbox_receipts",
             "Alerting inbox receipts by processing state.",
             db.get("inbox_receipts"))
    _labeled(out, "jlmirror_alerts",
             "Alerts by lifecycle state.", db.get("alerts"))
    _labeled(out, "jlmirror_monitoring_sources",
             "Monitoring sources by operational evidence state.",
             db.get("sources"), label="evidence_state")
    _labeled(out, "jlmirror_monitoring_resources",
             "Inventory resources by presence state.",
             db.get("resources"), label="presence_state")
    _labeled(out, "jlmirror_problems",
             "Problems by lifecycle state.", db.get("problems"))

    scalars = (
        ("jlmirror_sync_op_oldest_pending_seconds",
         "Age of the oldest pending sync operation.",
         "oldest_pending_seconds"),
        ("jlmirror_outbox_oldest_pending_seconds",
         "Age of the oldest unpublished outbox message.",
         "outbox_oldest_pending_seconds"),
        ("jlmirror_outbox_attempts_total",
         "Total outbox delivery attempts.",
         "outbox_attempts_total"),
        ("jlmirror_notification_intents_total",
         "Notification intents recorded.",
         "notification_intents_total"),
        ("jlmirror_worker_heartbeat_staleness_seconds",
         "Seconds since the worker last completed a tick; -1 when no "
         "heartbeat exists.",
         "worker_heartbeat_staleness_seconds"),
    )
    for name, help_text, key in scalars:
        if key not in db:
            continue
        mtype = "counter" if name.endswith("_total") else "gauge"
        out.append(_help_type(name, help_text, mtype))
        out.append(_metric(name, db[key]))

    # HTTP request telemetry from the in-process SLO probe.
    http = http if http is not None else slo.snapshot()
    out.append(_help_type(
        "jlmirror_http_requests_total",
        "HTTP requests by endpoint class (recent window).", "counter"))
    out.append(_help_type(
        "jlmirror_http_errors_total",
        "HTTP 5xx responses by endpoint class (recent window).",
        "counter"))
    out.append(_help_type(
        "jlmirror_http_request_duration_seconds",
        "Request duration percentiles by endpoint class "
        "(recent window).", "gauge"))
    for key, s in http.items():
        labels = {"endpoint": key}
        n = s["requests"]
        out.append(_metric("jlmirror_http_requests_total", n, labels))
        out.append(_metric(
            "jlmirror_http_errors_total",
            round(s["error_rate"] * n), labels))
        for q, field in ((0.5, "p50_ms"), (0.95, "p95_ms"),
                         (0.99, "p99_ms")):
            out.append(_metric(
                "jlmirror_http_request_duration_seconds",
                round(s[field] / 1000.0, 6),
                {**labels, "quantile": str(q)}))

    return "\n".join(out) + "\n"


CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"
