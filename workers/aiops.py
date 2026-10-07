"""G12 AIOps advisory analysis worker.

Runs per-tenant AI analysis every 30 minutes. Emits advisory findings only.
INVARIANT: findings are advisory. ALERT ≠ AIOPS FINDING — this worker
never creates, resolves, or transitions Alerts.
"""
from __future__ import annotations

import json
import logging
import os
import time
import uuid
from datetime import datetime, timezone

logger = logging.getLogger("workers.aiops")

_ANALYSIS_INTERVAL = 1800  # 30 minutes
_last_run: float = 0.0
_MODEL = "claude-sonnet-5-5"

_FINDING_TOOL = {
    "name": "emit_findings",
    "description": (
        "Emit advisory operational findings based on the evidence. "
        "Findings are advisory ONLY — they never create or resolve alerts."
    ),
    "input_schema": {
        "type": "object",
        "required": ["findings"],
        "properties": {
            "findings": {
                "type": "array",
                "maxItems": 8,
                "items": {
                    "type": "object",
                    "required": [
                        "finding_type", "severity_hint",
                        "title", "explanation", "confidence",
                    ],
                    "properties": {
                        "finding_type": {
                            "type": "string",
                            "enum": ["anomaly", "correlation", "root_cause", "prediction"],
                        },
                        "severity_hint": {
                            "type": "string",
                            "enum": ["low", "medium", "high"],
                        },
                        "title": {"type": "string", "maxLength": 120},
                        "explanation": {"type": "string", "maxLength": 2000},
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                        },
                        "evidence_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "Alert IDs or source IDs that support this finding",
                        },
                        "affected_resource_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "monitoring_resource_id values for affected hosts",
                        },
                        "recommended_action": {
                            "type": "string",
                            "maxLength": 400,
                            "description": "Concise operator action suggestion, if any",
                        },
                    },
                },
            },
        },
    },
}

_SYSTEM_PROMPT = (
    "You are an expert Site Reliability Engineer embedded in a monitoring platform. "
    "You receive a rich operational snapshot of a tenant's infrastructure and emit "
    "concise advisory findings.\n\n"
    "ANALYSIS GUIDELINES:\n"
    "- Consider metric deviations, problem correlations across hosts, severity escalation "
    "patterns, and capacity trends.\n"
    "- Look for root causes that explain multiple symptoms simultaneously "
    "(e.g. a network link causing cascade failures across several hosts).\n"
    "- Use 7-day metric baselines to distinguish genuine anomalies from normal operating "
    "ranges. A metric at 95% that has been at 95% for 7 days is not an anomaly.\n"
    "- Distinguish isolated incidents from systemic patterns affecting multiple hosts "
    "in the same group.\n"
    "- If a problem is already acknowledged or snoozed with a known operator reason, "
    "factor that context in — do not re-flag what operators already know.\n"
    "- Consider the duration a host has been in its current health state.\n\n"
    "CONSTRAINTS:\n"
    "1. Findings are advisory ONLY — you cannot create alerts or take actions.\n"
    "2. If the environment looks healthy or all problems are routine/acknowledged, "
    "emit 0 findings.\n"
    "3. Be conservative: only emit findings with genuine operational signal.\n"
    "4. confidence must reflect genuine uncertainty: 0.4–0.7 is typical; "
    "exceed 0.8 only for very clear, well-supported patterns.\n"
    "5. Cite specific alert IDs or resource IDs from the evidence in every finding.\n"
    "6. Explanations must reference actual metric values and trends, not generic statements.\n"
    "7. recommended_action should be specific and actionable, not generic advice."
)


def _process_pending(conn) -> int:
    """Called each tick. Runs analysis at most every 30 minutes."""
    global _last_run

    api_key = os.environ.get("ANTHROPIC_API_KEY", "").strip()
    if not api_key:
        return 0

    now = time.time()
    if now - _last_run < _ANALYSIS_INTERVAL:
        return 0

    try:
        count = _run_all_tenants(conn, api_key)
        _last_run = time.time()
        return count
    except Exception:
        conn.rollback()
        logger.exception("aiops: analysis run failed")
        return 0


def _run_all_tenants(conn, api_key: str) -> int:
    import anthropic

    cur = conn.execute("SELECT tenant_id FROM g1.tenants LIMIT 20")
    tenants = [row[0] for row in cur.fetchall()]
    if not tenants:
        return 0

    client = anthropic.Anthropic(api_key=api_key)
    total = 0
    for tenant_id in tenants:
        try:
            total += _analyze_tenant(conn, client, tenant_id)
        except Exception:
            conn.rollback()
            logger.exception("aiops: tenant %s failed", tenant_id)

    return total


def _analyze_tenant(conn, client, tenant_id: str) -> int:
    evidence = _gather_evidence(conn, tenant_id)
    if evidence["alert_count"] == 0:
        return 0

    findings_raw = _call_claude(client, tenant_id, evidence)
    return _store_run(conn, tenant_id, evidence, findings_raw)


# ---------------------------------------------------------------------------
# Evidence gathering
# ---------------------------------------------------------------------------

def _to_float(canonical_value) -> float | None:
    """Convert a psycopg3-deserialized JSONB canonical_value to float."""
    if canonical_value is None:
        return None
    try:
        if isinstance(canonical_value, (int, float)):
            return float(canonical_value)
        if isinstance(canonical_value, str):
            return float(canonical_value)
        return None
    except (TypeError, ValueError):
        return None


_NUMERIC_CAST_EXPR = """
    CASE
        WHEN jsonb_typeof({col}) = 'number' THEN {col}::numeric
        WHEN jsonb_typeof({col}) = 'string' THEN ({col} #>> '{{}}')::numeric
        ELSE NULL
    END
""".strip()


def _gather_evidence(conn, tenant_id: str) -> dict:
    # ------------------------------------------------------------------
    # 1. Active alerts with full host context and snooze info
    # ------------------------------------------------------------------
    cur = conn.execute(
        """
        SELECT a.alert_id, a.source_kind, a.source_subject_id,
               a.monitoring_source_id, a.monitoring_resource_id,
               a.source_evidence_summary, a.opened_at, a.updated_at,
               r.display_name,
               r.host_groups,
               sn.reason     AS snooze_reason,
               sn.expires_at AS snoozed_until
          FROM alerting.alert a
          LEFT JOIN monitoring.monitoring_resource r
            ON r.tenant_id = a.tenant_id
           AND r.monitoring_resource_id = a.monitoring_resource_id
          LEFT JOIN alerting.alert_snooze sn
            ON sn.alert_id = a.alert_id
           AND sn.cancelled_at IS NULL
           AND sn.expires_at > now()
         WHERE a.tenant_id = %s
           AND a.lifecycle_state = 'active'
           AND a.opened_at > now() - interval '24 hours'
         ORDER BY a.opened_at DESC
         LIMIT 30
        """,
        (tenant_id,),
    )
    alerts = []
    for row in cur.fetchall():
        ev_summary = row[5] or {}
        groups = row[9] or []
        group_names = (
            [g.get("name", g.get("ref", "")) for g in groups]
            if isinstance(groups, list) else []
        )
        alerts.append({
            "alert_id":              row[0],
            "source_kind":           row[1],
            "source_subject_id":     row[2],
            "monitoring_source_id":  row[3],
            "monitoring_resource_id": row[4],
            "evidence_summary":      ev_summary,
            "severity_class":        ev_summary.get("severity_class", "unknown"),
            "opened_at":             row[6].isoformat() if row[6] else None,
            "updated_at":            row[7].isoformat() if row[7] else None,
            "display_name":          row[8] or row[4] or "unknown",
            "host_groups":           group_names,
            "snooze_reason":         row[10],
            "snoozed_until":         row[11].isoformat() if row[11] else None,
        })

    if not alerts:
        return {
            "tenant_id": tenant_id, "alert_count": 0,
            "alerts": [], "sources": [], "problems": [],
            "health": [], "health_summary": {}, "metrics": [], "trends": [],
        }

    alerted_rids = list({a["monitoring_resource_id"] for a in alerts if a["monitoring_resource_id"]})

    # ------------------------------------------------------------------
    # 2. Active problems for alerting hosts (with escalation history)
    # ------------------------------------------------------------------
    cur = conn.execute(
        """
        SELECT p.problem_id, p.monitoring_resource_id,
               p.severity_class, p.summary, p.opened_at,
               p.last_confirmed_at, p.provider_acknowledged,
               round(extract(epoch from (now() - p.opened_at)) / 3600, 1) AS open_hours,
               t.from_severity_class, t.to_severity_class, t.occurred_at AS escalated_at
          FROM monitoring.monitoring_problem p
          LEFT JOIN LATERAL (
              SELECT from_severity_class, to_severity_class, occurred_at
                FROM monitoring.monitoring_problem_transition
               WHERE problem_id = p.problem_id
                 AND transition_reason = 'severity_change'
               ORDER BY occurred_at DESC
               LIMIT 1
          ) t ON true
         WHERE p.tenant_id = %s
           AND p.problem_state = 'active'
           AND p.monitoring_resource_id = ANY(%s)
         ORDER BY p.severity_class DESC, p.opened_at DESC
         LIMIT 60
        """,
        (tenant_id, alerted_rids),
    )
    problems = [
        {
            "problem_id":             row[0],
            "monitoring_resource_id": row[1],
            "severity_class":         row[2],
            "summary":                row[3] or "",
            "opened_at":              row[4].isoformat() if row[4] else None,
            "last_confirmed_at":      row[5].isoformat() if row[5] else None,
            "acknowledged":           bool(row[6]),
            "open_hours":             float(row[7]) if row[7] is not None else None,
            "escalated_from":         row[8],
            "escalated_to":           row[9],
            "escalated_at":           row[10].isoformat() if row[10] else None,
        }
        for row in cur.fetchall()
    ]

    # ------------------------------------------------------------------
    # 3. Health projections for alerting hosts
    # ------------------------------------------------------------------
    cur = conn.execute(
        """
        SELECT h.monitoring_resource_id, h.health_class, h.last_changed_at,
               round(extract(epoch from (now() - h.last_changed_at)) / 3600, 1) AS hours_in_state
          FROM monitoring.health_projection h
         WHERE h.tenant_id = %s
           AND h.monitoring_resource_id = ANY(%s)
        """,
        (tenant_id, alerted_rids),
    )
    health = [
        {
            "monitoring_resource_id": row[0],
            "health_class":           row[1],
            "last_changed_at":        row[2].isoformat() if row[2] else None,
            "hours_in_state":         float(row[3]) if row[3] is not None else None,
        }
        for row in cur.fetchall()
    ]

    # ------------------------------------------------------------------
    # 4. Current metric snapshot — all numeric metrics for alerting hosts
    # ------------------------------------------------------------------
    cur = conn.execute(
        """
        SELECT c.monitoring_resource_id, d.name, d.unit,
               c.value_kind, c.canonical_value, c.observed_at
          FROM monitoring.metric_current_state c
          JOIN monitoring.metric_definition d
            ON d.tenant_id = c.tenant_id
           AND d.metric_definition_id = c.metric_definition_id
         WHERE c.tenant_id = %s
           AND c.monitoring_resource_id = ANY(%s)
           AND c.value_kind IN ('number', 'integer')
           AND d.definition_state = 'active'
           AND d.scope_state = 'in_scope'
         ORDER BY c.monitoring_resource_id, d.name
         LIMIT 400
        """,
        (tenant_id, alerted_rids),
    )
    metrics = []
    for row in cur.fetchall():
        val = _to_float(row[4])
        if val is None:
            continue
        metrics.append({
            "monitoring_resource_id": row[0],
            "name":       row[1],
            "unit":       (row[2] or "").lstrip("!"),
            "value":      val,
            "observed_at": row[5].isoformat() if row[5] else None,
        })

    # ------------------------------------------------------------------
    # 5. 7-day baseline averages for significant-deviation detection
    # ------------------------------------------------------------------
    numeric_cast = _NUMERIC_CAST_EXPR.format(col="o.canonical_value")
    cur = conn.execute(
        f"""
        SELECT o.monitoring_resource_id, d.name, d.unit,
               round(AVG({numeric_cast})::numeric, 4)    AS avg_7d,
               round(STDDEV({numeric_cast})::numeric, 4) AS stddev_7d,
               COUNT(*)                                   AS samples
          FROM monitoring.metric_observation o
          JOIN monitoring.metric_definition d
            ON d.tenant_id = o.tenant_id
           AND d.metric_definition_id = o.metric_definition_id
         WHERE o.tenant_id = %s
           AND o.monitoring_resource_id = ANY(%s)
           AND o.value_kind IN ('number', 'integer')
           AND o.observed_at > now() - interval '7 days'
           AND o.observed_at < now() - interval '30 minutes'
           AND d.definition_state = 'active'
         GROUP BY o.monitoring_resource_id, d.name, d.unit
        HAVING COUNT(*) >= 10
         ORDER BY o.monitoring_resource_id, d.name
         LIMIT 400
        """,
        (tenant_id, alerted_rids),
    )
    baselines: dict[tuple[str, str], dict] = {}
    for row in cur.fetchall():
        baselines[(row[0], row[1])] = {
            "avg_7d":    float(row[3]) if row[3] is not None else None,
            "stddev_7d": float(row[4]) if row[4] is not None else None,
            "samples":   int(row[5]),
            "unit":      (row[2] or "").lstrip("!"),
        }

    # Compute deviations — surface only those exceeding 30% or 2 std-deviations
    trends = []
    for m in metrics:
        key = (m["monitoring_resource_id"], m["name"])
        b = baselines.get(key)
        if not b or b["avg_7d"] is None or b["avg_7d"] == 0:
            continue
        avg = b["avg_7d"]
        stddev = b["stddev_7d"] or 0.0
        current = m["value"]
        pct_change = (current - avg) / abs(avg) * 100
        z_score = (current - avg) / stddev if stddev > 1e-9 else 0.0

        if abs(pct_change) >= 30 or abs(z_score) >= 2.0:
            trends.append({
                "monitoring_resource_id": m["monitoring_resource_id"],
                "name":       m["name"],
                "unit":       m["unit"],
                "current":    current,
                "avg_7d":     avg,
                "stddev_7d":  stddev if stddev else None,
                "pct_change": round(pct_change, 1),
                "z_score":    round(z_score, 2),
                "samples":    b["samples"],
            })

    trends.sort(key=lambda t: abs(t["pct_change"]), reverse=True)

    # ------------------------------------------------------------------
    # 6. Monitoring sources
    # ------------------------------------------------------------------
    cur = conn.execute(
        """
        SELECT monitoring_source_id, display_name, operational_evidence_state
          FROM monitoring.monitoring_source
         WHERE tenant_id = %s
         LIMIT 10
        """,
        (tenant_id,),
    )
    sources = [
        {"source_id": row[0], "display_name": row[1], "state": row[2]}
        for row in cur.fetchall()
    ]

    # ------------------------------------------------------------------
    # 7. Environment-wide health distribution
    # ------------------------------------------------------------------
    cur = conn.execute(
        """
        SELECT health_class, COUNT(*) AS cnt
          FROM monitoring.health_projection
         WHERE tenant_id = %s
         GROUP BY health_class
        """,
        (tenant_id,),
    )
    health_summary = {row[0]: int(row[1]) for row in cur.fetchall()}

    return {
        "tenant_id":      tenant_id,
        "alert_count":    len(alerts),
        "alerts":         alerts,
        "problems":       problems,
        "health":         health,
        "health_summary": health_summary,
        "metrics":        metrics,
        "trends":         trends[:40],
        "sources":        sources,
    }


# ---------------------------------------------------------------------------
# Prompt construction
# ---------------------------------------------------------------------------

def _fmt_duration(hours: float | None) -> str:
    if hours is None:
        return "?"
    if hours < 1:
        return f"{int(hours * 60)}m"
    if hours < 24:
        return f"{hours:.1f}h"
    return f"{hours / 24:.1f}d"


def _build_prompt(tenant_id: str, evidence: dict) -> str:
    now_iso = datetime.now(tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    # Index helpers
    host_name: dict[str, str] = {
        a["monitoring_resource_id"]: a["display_name"]
        for a in evidence["alerts"]
        if a["monitoring_resource_id"]
    }
    host_health: dict[str, str] = {
        h["monitoring_resource_id"]: h["health_class"]
        for h in evidence["health"]
    }
    host_health_hours: dict[str, float | None] = {
        h["monitoring_resource_id"]: h["hours_in_state"]
        for h in evidence["health"]
    }

    lines: list[str] = []

    # --- Header ---------------------------------------------------------------
    lines += [
        f"=== OPERATIONAL SNAPSHOT: {tenant_id} ===",
        f"Generated: {now_iso}",
        "",
    ]

    # --- Environment overview -------------------------------------------------
    hs = evidence.get("health_summary", {})
    total_resources = sum(hs.values())
    health_dist = "  ".join(
        f"{cnt} {cls}" for cls, cnt in sorted(hs.items(), key=lambda x: x[1], reverse=True)
    ) or "unknown"
    lines += [
        "=== ENVIRONMENT OVERVIEW ===",
        f"Monitored resources: {total_resources}  |  Health: {health_dist}",
        f"Active alerts (24h): {evidence['alert_count']}  "
        f"|  Active problems on alerting hosts: {len(evidence['problems'])}",
        "",
    ]

    # --- Active alerts --------------------------------------------------------
    lines.append(f"=== ACTIVE ALERTS ({len(evidence['alerts'])}) ===")
    for a in evidence["alerts"]:
        rid = a["monitoring_resource_id"] or "unknown"
        hcls = host_health.get(rid, "unknown")
        hh = _fmt_duration(host_health_hours.get(rid))
        grps = ", ".join(a["host_groups"]) if a["host_groups"] else "—"
        ev = a["evidence_summary"]

        # Emit useful fields from evidence_summary
        ev_fields = []
        for key in ("trigger_name", "problem_name", "name", "description", "message"):
            if ev.get(key):
                ev_fields.append(f"{key}={ev[key]!r}")
        ev_str = "  ".join(ev_fields[:4]) or "—"

        lines.append(f"ALERT {a['alert_id']}")
        lines.append(f"  Host: {a['display_name']} [{rid}]")
        lines.append(f"  Groups: {grps}")
        lines.append(f"  Severity: {a['severity_class']}  |  "
                     f"Health: {hcls} for {hh}  |  Type: {a['source_kind']}")
        lines.append(f"  Opened: {a['opened_at']}")
        if ev_str != "—":
            lines.append(f"  Evidence: {ev_str}")
        if a["snooze_reason"]:
            lines.append(f"  SNOOZED until {a['snoozed_until']}: {a['snooze_reason']!r}")
        lines.append("")

    # --- Active problems grouped by host -------------------------------------
    if evidence["problems"]:
        lines.append(f"=== ACTIVE PROBLEMS ({len(evidence['problems'])}) ===")
        by_resource: dict[str, list] = {}
        for p in evidence["problems"]:
            by_resource.setdefault(p["monitoring_resource_id"], []).append(p)

        for rid, probs in by_resource.items():
            hname = host_name.get(rid, rid)
            lines.append(f"HOST: {hname} [{rid}]")
            for p in probs:
                ack_label = "ACK" if p["acknowledged"] else "unack"
                dur = _fmt_duration(p["open_hours"])
                esc = ""
                if p.get("escalated_from") and p.get("escalated_to"):
                    esc = (
                        f"  [escalated {p['escalated_from']}→{p['escalated_to']}"
                        f" at {p['escalated_at']}]"
                    )
                lines.append(
                    f"  [{p['severity_class'].upper()}] {p['summary']!r} "
                    f"({ack_label}, open {dur}){esc}"
                )
            lines.append("")

    # --- Current metric snapshot per host ------------------------------------
    if evidence["metrics"]:
        lines.append("=== CURRENT METRIC SNAPSHOT (alerting hosts) ===")
        by_res: dict[str, list] = {}
        for m in evidence["metrics"]:
            by_res.setdefault(m["monitoring_resource_id"], []).append(m)

        for rid, mlist in by_res.items():
            hname = host_name.get(rid, rid)
            hcls = host_health.get(rid, "unknown")
            lines.append(f"HOST: {hname} [{hcls}]")
            for m in mlist[:40]:
                unit = f" {m['unit']}" if m["unit"] else ""
                # Compact value formatting
                v = m["value"]
                val_str = f"{v:.4g}" if v != int(v) else str(int(v))
                lines.append(f"  {m['name']}: {val_str}{unit}")
            lines.append("")

    # --- Significant deviations from 7-day baseline --------------------------
    if evidence["trends"]:
        lines.append("=== METRIC DEVIATIONS vs 7-DAY BASELINE ===")
        lines.append("(threshold: ≥30% change or z-score ≥2.0)")
        for t in evidence["trends"][:20]:
            hname = host_name.get(t["monitoring_resource_id"], t["monitoring_resource_id"])
            unit = f" {t['unit']}" if t["unit"] else ""
            direction = "▲" if t["pct_change"] > 0 else "▼"
            std_str = f", σ={t['stddev_7d']:.3g}" if t.get("stddev_7d") else ""
            lines.append(
                f"  {hname} — {t['name']}: "
                f"now={t['current']:.4g}{unit}  "
                f"7d_avg={t['avg_7d']:.4g}{unit}{std_str}  "
                f"{direction}{abs(t['pct_change']):.0f}%  z={t['z_score']:+.1f}  "
                f"(n={t['samples']})"
            )
        lines.append("")

    # --- Monitoring sources ---------------------------------------------------
    lines.append("=== MONITORING SOURCES ===")
    for s in evidence["sources"]:
        lines.append(f"  {s['display_name']} [{s['state']}] (id={s['source_id'][:20]})")
    lines.append("")

    lines.append(
        "Analyze the evidence above and emit advisory findings. "
        "Focus on genuine operational concerns with specific metric evidence. "
        "Emit 0 findings if the situation is routine or already well-understood by operators."
    )

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Claude call
# ---------------------------------------------------------------------------

def _call_claude(client, tenant_id: str, evidence: dict) -> list[dict]:
    prompt = _build_prompt(tenant_id, evidence)
    logger.debug(
        "aiops: prompt for tenant %s — %d chars, %d alerts, %d problems, "
        "%d metrics, %d trend deviations",
        tenant_id, len(prompt), evidence["alert_count"],
        len(evidence["problems"]), len(evidence["metrics"]),
        len(evidence["trends"]),
    )

    try:
        response = client.messages.create(
            model=_MODEL,
            max_tokens=4096,
            system=_SYSTEM_PROMPT,
            tools=[_FINDING_TOOL],
            tool_choice={"type": "any"},
            messages=[{"role": "user", "content": prompt}],
        )
    except Exception:
        logger.exception("aiops: Claude API call failed for tenant %s", tenant_id)
        return []

    for block in response.content:
        if block.type == "tool_use" and block.name == "emit_findings":
            findings = block.input.get("findings", [])
            logger.info(
                "aiops: tenant %s → %d findings (model=%s, in=%s out=%s tokens)",
                tenant_id, len(findings), _MODEL,
                getattr(response.usage, "input_tokens", "?"),
                getattr(response.usage, "output_tokens", "?"),
            )
            return findings

    return []


# ---------------------------------------------------------------------------
# Persistence
# ---------------------------------------------------------------------------

def _store_run(conn, tenant_id: str, evidence: dict, findings: list[dict]) -> int:
    run_id = f"run-{uuid.uuid4().hex[:16]}"

    conn.execute(
        """
        INSERT INTO aiops.analysis_run
            (run_id, tenant_id, evidence_window_start, evidence_window_end,
             evidence_alert_count, findings_count, model_id, status)
        VALUES (%s, %s, now() - interval '24 hours', now(), %s, %s, %s, 'completed')
        """,
        (run_id, tenant_id, evidence["alert_count"], len(findings), _MODEL),
    )

    count = 0
    for f in findings:
        finding_id = f"find-{uuid.uuid4().hex[:16]}"
        # Merge all cited IDs into evidence_refs
        refs = list(f.get("evidence_ids") or []) + list(f.get("affected_resource_ids") or [])

        conn.execute(
            """
            INSERT INTO aiops.finding
                (tenant_id, finding_id, analysis_run_id, finding_type,
                 severity_hint, title, explanation, evidence_refs,
                 confidence, model_id, recommended_action, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s, %s,
                    now() + interval '7 days')
            """,
            (
                tenant_id,
                finding_id,
                run_id,
                f.get("finding_type", "anomaly"),
                f.get("severity_hint", "medium"),
                (f.get("title") or "Untitled finding")[:120],
                (f.get("explanation") or "")[:2000],
                json.dumps(refs),
                f.get("confidence"),
                _MODEL,
                (f.get("recommended_action") or None),
            ),
        )
        count += 1

    conn.commit()
    return count
