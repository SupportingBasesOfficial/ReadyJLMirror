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

import io
import json
import logging
import secrets
import urllib.error
import urllib.request
from datetime import datetime, timezone

import psycopg

from shared.ssrf import validate_outbound_url

logger = logging.getLogger(__name__)

_WEBHOOK_TIMEOUT = 10.0


def _render(template: str, ctx: dict) -> str:
    for k, v in ctx.items():
        template = template.replace(f"{{{{{k}}}}}", str(v))
    return template


def _execute_webhook(config: dict, ctx: dict) -> tuple[str, int | None, str | None]:
    url = config.get("url", "").strip()
    ssrf_err = validate_outbound_url(url)
    if ssrf_err:
        return "failed", None, f"ssrf_blocked:{ssrf_err}"

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


def _execute_ssh_command(config: dict, ctx: dict,
                         conn: psycopg.Connection) -> tuple[str, str | None]:
    """Execute an SSH command on a remote host. Returns (outcome, error_detail)."""
    try:
        import paramiko  # noqa: PLC0415 — optional dep, only loaded for ssh_command
    except ImportError:
        return "failed", "paramiko not installed — add paramiko>=3.4 to dependencies"

    credential_id = config.get("credential_id", "").strip()
    host = config.get("host", "").strip()
    port = int(config.get("port", 22))
    command_template = config.get("command", "").strip()
    command = _render(command_template, ctx)
    timeout = int(config.get("timeout_secs", 30))

    # Fetch credential from DB
    cur = conn.execute(
        "SELECT username, key_pem, known_hosts "
        "FROM g1.automation_credential "
        "WHERE credential_id=%s AND tenant_id=%s",
        (credential_id, ctx["tenant_id"]),
    )
    cred_row = cur.fetchone()
    if cred_row is None:
        return "failed", f"credential not found: {credential_id}"

    username, key_pem, known_hosts_text = cred_row

    # Load private key
    try:
        pkey = paramiko.RSAKey.from_private_key(io.StringIO(key_pem))
    except paramiko.SSHException:
        try:
            pkey = paramiko.Ed25519Key.from_private_key(io.StringIO(key_pem))
        except paramiko.SSHException:
            try:
                pkey = paramiko.ECDSAKey.from_private_key(io.StringIO(key_pem))
            except paramiko.SSHException as exc:
                return "failed", f"cannot load private key: {exc}"

    client = paramiko.SSHClient()
    if known_hosts_text:
        host_keys = paramiko.HostKeys()
        host_keys.load(io.StringIO(known_hosts_text))  # type: ignore[arg-type]
        client._host_keys = host_keys  # noqa: SLF001
        client.set_missing_host_key_policy(paramiko.RejectPolicy())
    else:
        # No known_hosts — accept and log fingerprint (not silently trusting)
        client.set_missing_host_key_policy(paramiko.WarningPolicy())

    try:
        client.connect(host, port=port, username=username, pkey=pkey,
                       timeout=timeout, allow_agent=False, look_for_keys=False)
        _stdin, stdout, stderr = client.exec_command(command, timeout=timeout)
        exit_status = stdout.channel.recv_exit_status()
        stdout_text = stdout.read(4096).decode("utf-8", errors="replace").strip()
        stderr_text = stderr.read(1024).decode("utf-8", errors="replace").strip()
    except Exception as exc:
        return "failed", f"ssh:{type(exc).__name__}:{exc}"
    finally:
        client.close()

    if exit_status != 0:
        detail = f"exit:{exit_status}"
        if stderr_text:
            detail += f" stderr:{stderr_text[:256]}"
        return "failed", detail

    logger.info(
        "automation ssh run=%s host=%s cmd=%r exit=0 out=%r",
        ctx["run_id"], host, command, stdout_text[:120],
    )
    return "success", None


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
    elif script_type == "ssh_command":
        outcome, error = _execute_ssh_command(config, ctx, conn)
        http_status = None
        logger.info(
            "automation ssh run=%s script=%s outcome=%s",
            run_id, script_name, outcome)
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
