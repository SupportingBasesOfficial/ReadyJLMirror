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

logger = logging.getLogger("workers.aiops")

_ANALYSIS_INTERVAL = 1800  # 30 minutes
_last_run: float = 0.0

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
                "maxItems": 5,
                "items": {
                    "type": "object",
                    "required": [
                        "finding_type", "severity_hint",
                        "title", "explanation", "confidence",
                    ],
                    "properties": {
                        "finding_type": {
                            "type": "string",
                            "enum": ["anomaly", "correlation",
                                     "root_cause", "prediction"],
                        },
                        "severity_hint": {
                            "type": "string",
                            "enum": ["low", "medium", "high"],
                        },
                        "title": {"type": "string", "maxLength": 120},
                        "explanation": {"type": "string", "maxLength": 800},
                        "confidence": {
                            "type": "number",
                            "minimum": 0,
                            "maximum": 1,
                        },
                        "evidence_ids": {
                            "type": "array",
                            "items": {"type": "string"},
                        },
                    },
                },
            },
        },
    },
}

_SYSTEM_PROMPT = (
    "You are an expert SRE analyzing operational evidence for a monitoring platform. "
    "Your role is to emit concise advisory findings that help operators understand "
    "their environment. "
    "CRITICAL CONSTRAINTS: "
    "1. Findings are advisory ONLY — you cannot and do not create alerts or take actions. "
    "2. If the environment looks healthy, emit 0 findings. "
    "3. Be conservative: only emit findings with genuine signal, not noise. "
    "4. confidence must reflect genuine uncertainty: 0.4–0.7 is typical; "
    "only exceed 0.8 for very clear patterns. "
    "5. Each finding must cite specific alert IDs or source IDs from the evidence."
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


def _gather_evidence(conn, tenant_id: str) -> dict:
    cur = conn.execute(
        """
        SELECT alert_id, lifecycle_state, source_kind,
               monitoring_source_id, monitoring_resource_id,
               source_evidence_summary, opened_at
          FROM alerting.alert
         WHERE tenant_id = %s
           AND lifecycle_state = 'active'
           AND opened_at > now() - interval '24 hours'
         ORDER BY opened_at DESC
         LIMIT 20
        """,
        (tenant_id,),
    )
    alerts = [
        {
            "alert_id": r[0],
            "lifecycle_state": r[1],
            "source_kind": r[2],
            "monitoring_source_id": r[3],
            "monitoring_resource_id": r[4],
            "evidence_summary": r[5] or {},
            "opened_at": r[6].isoformat() if r[6] else None,
        }
        for r in cur.fetchall()
    ]

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
        {"source_id": r[0], "display_name": r[1], "state": r[2]}
        for r in cur.fetchall()
    ]

    return {
        "tenant_id": tenant_id,
        "alert_count": len(alerts),
        "alerts": alerts,
        "sources": sources,
    }


def _call_claude(client, tenant_id: str, evidence: dict) -> list[dict]:
    alert_lines = "\n".join(
        "- Alert {}: {} on {} (sev={}, opened={})".format(
            a["alert_id"][:20],
            a["source_kind"],
            a["monitoring_resource_id"] or "unknown",
            (a["evidence_summary"] or {}).get("severity_class", "?"),
            a["opened_at"],
        )
        for a in evidence["alerts"]
    )
    source_lines = "\n".join(
        "- Source {}: {} [{}]".format(s["source_id"][:20], s["display_name"], s["state"])
        for s in evidence["sources"]
    ) or "No sources."

    prompt = (
        f"Tenant: {tenant_id}\n\n"
        f"Active alerts (last 24 h):\n{alert_lines}\n\n"
        f"Monitoring sources:\n{source_lines}\n\n"
        "Analyze this evidence and emit advisory findings. "
        "Emit zero findings if the situation is routine."
    )

    try:
        response = client.messages.create(
            model="claude-sonnet-5",
            max_tokens=1024,
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
                "aiops: tenant %s → %d findings (model=%s)",
                tenant_id, len(findings), "claude-sonnet-5",
            )
            return findings

    return []


def _store_run(conn, tenant_id: str, evidence: dict, findings: list[dict]) -> int:
    run_id = f"run-{uuid.uuid4().hex[:16]}"

    conn.execute(
        """
        INSERT INTO aiops.analysis_run
            (run_id, tenant_id, evidence_window_start, evidence_window_end,
             evidence_alert_count, findings_count, model_id, status)
        VALUES (%s, %s, now() - interval '24 hours', now(), %s, %s, %s, 'completed')
        """,
        (run_id, tenant_id, evidence["alert_count"], len(findings), "claude-sonnet-5"),
    )

    count = 0
    for f in findings:
        finding_id = f"find-{uuid.uuid4().hex[:16]}"
        conn.execute(
            """
            INSERT INTO aiops.finding
                (tenant_id, finding_id, analysis_run_id, finding_type,
                 severity_hint, title, explanation, evidence_refs,
                 confidence, model_id, expires_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s, %s,
                    now() + interval '7 days')
            """,
            (
                tenant_id,
                finding_id,
                run_id,
                f.get("finding_type", "anomaly"),
                f.get("severity_hint", "medium"),
                (f.get("title") or "Untitled finding")[:120],
                (f.get("explanation") or "")[:800],
                json.dumps(f.get("evidence_ids", [])),
                f.get("confidence"),
                "claude-sonnet-5",
            ),
        )
        count += 1

    conn.commit()
    return count
