"""G32 Automation Runtime worker.

_process_pending(conn) is called on every tick by run_all.py.
Picks up due automation schedules, creates run records, and executes
the script (webhook POST or noop).

Webhook body_template substitutions: {{tenant_id}}, {{script_id}},
{{run_id}}, {{timestamp}}.

At-least-once: if the process dies mid-run, the run row stays in 'pending'
and is retried on the next cycle.
"""

from __future__ import annotations

import json
import logging
import secrets
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

import psycopg

logger = logging.getLogger(__name__)

_WEBHOOK_TIMEOUT = 10.0


def _render(template: str, ctx: dict) -> str:
    for k, v in ctx.items():
        template = template.replace(f"{{{{{k}}}}}", str(v))
    return template


def _execute_webhook(config: dict, ctx: dict) -> tuple[str, int | None, str | None]:
    url = config.get("url", "").strip()
    if not url or not url.startswith("https://"):
        return "failed", None, "invalid webhook URL"

    method = config.get("method", "POST").upper()
    headers = {str(k): str(v) for k, v in config.get("headers", {}).items()}
    body_template = config.get("body_template", json.dumps(ctx))
    body = _render(body_template, ctx).encode()

    if "Content-Type" not in headers:
        headers["Content-Type"] = "application/json"

    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=_WEBHOOK_TIMEOUT) as resp:
            status = resp.status
    except urllib.error.HTTPError as exc:
        return "failed", exc.code, f"http_error:{exc.code}"
    except OSError as exc:
        return "failed", None, f"transport:{type(exc).__name__}"

    if status >= 400:
        return "failed", status, f"http:{status}"
    return "success", status, None


def _execute_run(conn: psycopg.Connection, run_id: str, tenant_id: str,
                 script_id: str) -> None:
    """Execute one pending run (schedule or manual). Commits the result."""
    conn.execute(
        "SELECT set_config('jlmirror.tenant_id', %s, false)", (tenant_id,))

    scur = conn.execute(
        "SELECT script_type, config, name FROM g1.automation_script "
        "WHERE script_id=%s",
        (script_id,),
    )
    script_row = scur.fetchone()
    if script_row is None:
        conn.execute(
            "UPDATE g1.automation_run SET outcome='skipped', "
            "error_detail='script not found', finished_at=now() "
            "WHERE run_id=%s",
            (run_id,))
        conn.commit()
        return

    script_type, config_raw, script_name = script_row
    config = config_raw if isinstance(config_raw, dict) else json.loads(config_raw)
    ctx = {
        "tenant_id": tenant_id,
        "script_id": script_id,
        "run_id": run_id,
        "timestamp": datetime.now(timezone.utc).isoformat(),
    }

    if script_type == "noop":
        outcome, http_status, error = "success", None, None
        logger.info("automation noop run=%s script=%s", run_id, script_name)
    elif script_type == "webhook":
        outcome, http_status, error = _execute_webhook(config, ctx)
        logger.info(
            "automation webhook run=%s script=%s outcome=%s status=%s",
            run_id, script_name, outcome, http_status)
    else:
        outcome, http_status, error = "skipped", None, f"unknown type: {script_type}"

    conn.execute(
        "UPDATE g1.automation_run "
        "SET outcome=%s, http_status=%s, error_detail=%s, finished_at=now() "
        "WHERE run_id=%s",
        (outcome, http_status,
         error[:512] if error else None,
         run_id),
    )
    conn.commit()


def _process_pending(conn: psycopg.Connection) -> int:
    processed = 0
    now = datetime.now(timezone.utc)

    # Execute pending manual and incident_response triggered runs
    manual_cur = conn.execute(
        "SELECT run_id, tenant_id, script_id FROM g1.automation_run "
        "WHERE outcome='pending' AND trigger_type IN ('manual','incident_response') LIMIT 10"
    )
    for run_id, tenant_id, script_id in manual_cur.fetchall():
        try:
            _execute_run(conn, run_id, tenant_id, script_id)
            processed += 1
        except Exception:
            conn.rollback()
            logger.exception("Manual run %s failed", run_id)

    # Claim due schedules
    cur = conn.execute(
        """
        SELECT s.schedule_id, s.tenant_id, s.script_id,
               s.interval_secs
          FROM g1.automation_schedule s
         WHERE s.enabled = true
           AND s.next_run_at <= %s
         LIMIT 20
        """,
        (now,),
    )
    due = cur.fetchall()

    for schedule_id, tenant_id, script_id, interval_secs in due:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id', %s, false)",
            (tenant_id,))

        # Check script still enabled
        scur = conn.execute(
            "SELECT enabled FROM g1.automation_script WHERE script_id=%s",
            (script_id,),
        )
        script_row = scur.fetchone()
        if script_row is None or not script_row[0]:
            conn.execute(
                "UPDATE g1.automation_schedule SET enabled=false "
                "WHERE schedule_id=%s",
                (schedule_id,))
            conn.commit()
            continue

        run_id = f"arun:{secrets.token_urlsafe(16)}"
        next_run = datetime.fromtimestamp(
            now.timestamp() + interval_secs, tz=timezone.utc)

        # Create run record
        conn.execute(
            """
            INSERT INTO g1.automation_run
                (run_id, tenant_id, script_id, trigger_type, schedule_id,
                 outcome, started_at)
            VALUES (%s, %s, %s, 'schedule', %s, 'pending', %s)
            """,
            (run_id, tenant_id, script_id, schedule_id, now),
        )
        # Advance schedule
        conn.execute(
            """
            UPDATE g1.automation_schedule
               SET last_run_at=%s, next_run_at=%s
             WHERE schedule_id=%s
            """,
            (now, next_run, schedule_id),
        )
        conn.commit()

        try:
            _execute_run(conn, run_id, tenant_id, script_id)
        except Exception:
            conn.rollback()
            logger.exception("Schedule run %s failed", run_id)

        processed += 1

    return processed
