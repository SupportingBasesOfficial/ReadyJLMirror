"""G37 Synthetic monitoring worker — periodic HTTP health checks.

On consecutive failures (>= ALERT_THRESHOLD), sends an email alert
to the on-call person (if any) or to tenant admins via SMTP.
Clears the alert when the check recovers.
"""

from __future__ import annotations

import ipaddress
import logging
import os
import secrets
import smtplib
import socket
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from urllib.parse import urlparse

import httpx
import psycopg

logger = logging.getLogger("workers.synthetic_checker")

_ALERT_THRESHOLD = 2  # consecutive failures before alerting

_BATCH = 20


def _is_private_host(host: str) -> bool:
    """Return True if host resolves to a private/loopback/link-local address."""
    if not host or "." not in host:
        return True  # single-label = Docker service name
    try:
        addr = ipaddress.ip_address(host)
        return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        for info in infos:
            addr = ipaddress.ip_address(info[4][0])
            if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
                return True
    except Exception:
        return True  # fail-closed: DNS failure → block
    return False


def _run_check(url: str, method: str, expected_status: int,
               timeout: int, headers: dict) -> tuple[bool, int | None, int, str | None]:
    # Defense-in-depth: block private-network URLs at execution time.
    # Redirects disabled — a redirect to a private host bypasses the
    # up-front validation done at check creation time.
    try:
        host = urlparse(url).hostname or ""
        if _is_private_host(host):
            return False, None, 0, "url blocked by security policy"
    except Exception:
        return False, None, 0, "url is malformed"

    t0 = time.monotonic()
    ok = False
    status_code: int | None = None
    error: str | None = None
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            resp = client.request(method, url, headers=headers)
        status_code = resp.status_code
        ok = (status_code == expected_status)
    except Exception as exc:
        error = str(exc)[:500]
    response_ms = int((time.monotonic() - t0) * 1000)
    return ok, status_code, response_ms, error


def _smtp_config(conn: psycopg.Connection, tenant_id: str) -> dict:
    """Return SMTP config: tenant settings > env vars."""
    try:
        cur = conn.execute(
            """
            SELECT smtp_host, smtp_port, smtp_user, smtp_password,
                   smtp_from_email, smtp_tls
              FROM g1.tenant_settings WHERE tenant_id = %s
            """,
            (tenant_id,),
        )
        row = cur.fetchone()
        conn.rollback()
        if row and row[0]:
            host, port, user, pwd, from_email, use_tls = row
            return {
                "host": host or "", "port": int(port or 587),
                "user": user or "", "password": pwd or "",
                "from_addr": from_email or user or "",
                "tls_mode": "starttls" if use_tls else "plain",
            }
    except Exception:
        conn.rollback()
    return {
        "host":      os.environ.get("SMTP_HOST", ""),
        "port":      int(os.environ.get("SMTP_PORT", "587")),
        "user":      os.environ.get("SMTP_USER", ""),
        "password":  os.environ.get("SMTP_PASSWORD", ""),
        "from_addr": os.environ.get("SMTP_FROM",
                                    os.environ.get("SMTP_USER", "")),
        "tls_mode":  os.environ.get("SMTP_TLS", "starttls"),
    }


def _admin_emails(conn: psycopg.Connection, tenant_id: str) -> list[str]:
    """Return emails of all tenant admins (for synthetic alert delivery)."""
    try:
        cur = conn.execute(
            """
            SELECT DISTINCT p.email
              FROM g1.principals p
              JOIN g1.tenant_memberships tm
                ON tm.principal_id = p.principal_id
             WHERE tm.tenant_id = %s
               AND tm.role IN ('admin', 'tenant_admin')
               AND p.email IS NOT NULL
            """,
            (tenant_id,),
        )
        rows = cur.fetchall()
        conn.rollback()
        return [r[0] for r in rows if r[0]]
    except Exception:
        conn.rollback()
        return []


def _send_alert_email(smtp: dict, recipients: list[str],
                      subject: str, body: str) -> None:
    host = smtp.get("host", "")
    if not host:
        logger.info("DEV synthetic alert (SMTP not configured): %s → %s",
                    subject, recipients)
        return
    port = smtp["port"]
    user = smtp.get("user", "")
    password = smtp.get("password", "")
    from_addr = smtp.get("from_addr", user)
    tls_mode = smtp.get("tls_mode", "starttls")

    msg = MIMEMultipart()
    msg["From"] = from_addr
    msg["To"] = ", ".join(recipients)
    msg["Subject"] = subject
    msg.attach(MIMEText(body, "plain", "utf-8"))

    if tls_mode == "ssl":
        srv = smtplib.SMTP_SSL(host, port, timeout=10)
    else:
        srv = smtplib.SMTP(host, port, timeout=10)
        if tls_mode == "starttls":
            srv.starttls()
    with srv:
        if user and password:
            srv.login(user, password)
        srv.sendmail(from_addr, recipients, msg.as_string())


def _process_pending(conn: psycopg.Connection) -> int:
    cur = conn.execute(
        """
        SELECT check_id, tenant_id, url, method,
               expected_status, timeout_seconds, headers,
               consecutive_failures, alert_fired,
               name
          FROM monitoring.synthetic_check
         WHERE enabled = true
           AND (
               last_checked_at IS NULL
               OR last_checked_at + (interval_seconds || ' seconds')::INTERVAL
                  <= now()
           )
         ORDER BY last_checked_at NULLS FIRST
         LIMIT %s
        """,
        (_BATCH,))
    rows = cur.fetchall()
    processed = 0

    for (check_id, tenant_id, url, method,
         exp_status, timeout, headers_obj,
         consecutive_failures, alert_fired, check_name) in rows:
        headers: dict = headers_obj or {}
        ok, status_code, response_ms, error = _run_check(
            url, method, exp_status, timeout, headers)

        consecutive_failures = consecutive_failures or 0
        alert_fired = bool(alert_fired)

        if ok:
            new_failures = 0
        else:
            new_failures = consecutive_failures + 1

        result_id = f"synres_{secrets.token_urlsafe(10)}"
        try:
            conn.execute(
                """
                INSERT INTO monitoring.synthetic_result
                    (result_id, check_id, tenant_id, ok,
                     status_code, response_ms, error)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                """,
                (result_id, check_id, tenant_id, ok,
                 status_code, response_ms, error))

            new_alert_fired = alert_fired
            if ok and alert_fired:
                new_alert_fired = False  # recovery
            elif not ok and new_failures > _ALERT_THRESHOLD and not alert_fired:
                new_alert_fired = True

            conn.execute(
                """
                UPDATE monitoring.synthetic_check
                   SET last_checked_at = now(), last_ok = %s,
                       last_status_code = %s, last_response_ms = %s,
                       last_error = %s,
                       consecutive_failures = %s,
                       alert_fired = %s
                 WHERE check_id = %s
                """,
                (ok, status_code, response_ms, error,
                 new_failures, new_alert_fired, check_id))
            conn.commit()
            processed += 1

            if not ok:
                logger.warning(
                    "synthetic check FAIL check_id=%s url=%s "
                    "status=%s error=%s consecutive=%s",
                    check_id, url, status_code, error, new_failures)

            # Send alert when threshold crossed for the first time
            if not ok and new_alert_fired and not alert_fired:
                try:
                    smtp = _smtp_config(conn, tenant_id)
                    recipients = _admin_emails(conn, tenant_id)
                    if recipients:
                        label = check_name or check_id
                        subject = f"[JLMirror] Alerta Sintético — {label} FALHOU"
                        body = (
                            f"O monitoramento sintético '{label}' "
                            f"falhou {new_failures} vezes consecutivas.\n\n"
                            f"URL: {url}\n"
                            f"Status recebido: {status_code}\n"
                            f"Erro: {error or 'N/A'}\n\n"
                            f"Verifique o painel JLMirror para mais detalhes."
                        )
                        _send_alert_email(smtp, recipients, subject, body)
                        logger.warning(
                            "synthetic alert sent check_id=%s url=%s "
                            "recipients=%s", check_id, url, recipients)
                except Exception:
                    logger.exception(
                        "failed to send synthetic alert check_id=%s", check_id)

            # Send recovery email when check recovers after an alert
            if ok and alert_fired:
                try:
                    smtp = _smtp_config(conn, tenant_id)
                    recipients = _admin_emails(conn, tenant_id)
                    if recipients:
                        label = check_name or check_id
                        subject = f"[JLMirror] Recuperado — {label}"
                        body = (
                            f"O monitoramento sintético '{label}' "
                            f"foi recuperado com sucesso.\n\n"
                            f"URL: {url}\n"
                            f"Status: {status_code}\n"
                            f"Tempo de resposta: {response_ms}ms\n"
                        )
                        _send_alert_email(smtp, recipients, subject, body)
                        logger.info(
                            "synthetic recovery email sent check_id=%s url=%s",
                            check_id, url)
                except Exception:
                    logger.exception(
                        "failed to send synthetic recovery email check_id=%s",
                        check_id)

        except Exception:
            conn.rollback()
            logger.exception("synthetic_checker failed check_id=%s", check_id)

        # Prune old results — keep last 200 per check
        try:
            conn.execute(
                """
                DELETE FROM monitoring.synthetic_result
                 WHERE check_id = %s
                   AND result_id NOT IN (
                       SELECT result_id
                         FROM monitoring.synthetic_result
                        WHERE check_id = %s
                        ORDER BY checked_at DESC
                        LIMIT 200
                   )
                """,
                (check_id, check_id))
            conn.commit()
        except Exception:
            conn.rollback()

    return processed
