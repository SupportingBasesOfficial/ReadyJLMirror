"""G33 Scheduled Reports worker.

_process_pending(conn) is called on every tick by run_all.py.
Picks up due report schedules, generates a text/HTML summary from DB,
and sends via the email adapter (SMTP or dev-log if SMTP_HOST unset).
"""

from __future__ import annotations

import logging
import secrets
import smtplib
import uuid
from datetime import datetime, timedelta, timezone
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

import psycopg

from shared.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Data collection helpers
# ---------------------------------------------------------------------------

def _collect_alert_summary(conn: psycopg.Connection,
                            tenant_id: str,
                            period_start: datetime,
                            period_end: datetime) -> tuple[list[dict], int]:
    cur = conn.execute(
        """
        SELECT severity, COUNT(*) AS cnt,
               COUNT(*) FILTER (WHERE lifecycle_state IN ('resolved', 'closed')) AS resolved
          FROM alerting.alert
         WHERE tenant_id = %s
           AND opened_at >= %s AND opened_at < %s
         GROUP BY severity
         ORDER BY cnt DESC
        """,
        (tenant_id, period_start, period_end),
    )
    rows = [{"severity": r[0], "count": r[1], "resolved": r[2]}
            for r in cur.fetchall()]
    total = sum(r["count"] for r in rows)
    return rows, total


def _collect_sla_summary(conn: psycopg.Connection,
                          tenant_id: str,
                          period_start: datetime,
                          period_end: datetime) -> tuple[list[dict], int]:
    cur = conn.execute(
        """
        SELECT breach_type, COUNT(*) AS cnt
          FROM g1.sla_breach
         WHERE tenant_id = %s
           AND breached_at >= %s AND breached_at < %s
         GROUP BY breach_type
        """,
        (tenant_id, period_start, period_end),
    )
    rows = [{"breach_type": r[0], "count": r[1]} for r in cur.fetchall()]
    total = sum(r["count"] for r in rows)
    return rows, total


def _collect_incident_summary(conn: psycopg.Connection,
                               tenant_id: str,
                               period_start: datetime,
                               period_end: datetime) -> tuple[list[dict], int]:
    cur = conn.execute(
        """
        SELECT state, COUNT(*) AS cnt
          FROM itsm.incident
         WHERE tenant_id = %s
           AND created_at >= %s AND created_at < %s
         GROUP BY state
        """,
        (tenant_id, period_start, period_end),
    )
    rows = [{"state": r[0], "count": r[1]} for r in cur.fetchall()]
    total = sum(r["count"] for r in rows)
    return rows, total


# ---------------------------------------------------------------------------
# Email rendering
# ---------------------------------------------------------------------------

def _build_email(report_type: str, name: str, tenant_id: str,
                 period_start: datetime, period_end: datetime,
                 rows: list[dict], total: int) -> tuple[str, str, str]:
    """Returns (subject, text_body, html_body)."""
    period = (f"{period_start.strftime('%Y-%m-%d %H:%M')} — "
              f"{period_end.strftime('%Y-%m-%d %H:%M')} UTC")

    type_labels = {
        "alert_summary": "Alert Summary",
        "sla_summary": "SLA Breach Summary",
        "incident_summary": "Incident Summary",
    }
    label = type_labels.get(report_type, report_type.replace("_", " ").title())
    subject = f"[JLMirror] {label} — {name}"

    if report_type == "alert_summary":
        lines = [f"  {r['severity']:12s}: {r['count']:4d} alerts "
                 f"({r['resolved']} resolved)"
                 for r in rows]
        detail = "\n".join(lines) if lines else "  No alerts in this period."
        text = (f"Report: {label}\n"
                f"Tenant: {tenant_id}\n"
                f"Period: {period}\n\n"
                f"Total alerts: {total}\n\n"
                f"{detail}\n")
    elif report_type == "sla_summary":
        lines = [f"  {r['breach_type']:10s}: {r['count']:4d} breaches"
                 for r in rows]
        detail = "\n".join(lines) if lines else "  No SLA breaches in this period."
        text = (f"Report: {label}\n"
                f"Tenant: {tenant_id}\n"
                f"Period: {period}\n\n"
                f"Total breaches: {total}\n\n"
                f"{detail}\n")
    else:
        lines = [f"  {r['state']:14s}: {r['count']:4d}" for r in rows]
        detail = "\n".join(lines) if lines else "  No incidents in this period."
        text = (f"Report: {label}\n"
                f"Tenant: {tenant_id}\n"
                f"Period: {period}\n\n"
                f"Total incidents: {total}\n\n"
                f"{detail}\n")

    html = (f"<html><body><pre style='font-family:monospace'>"
            f"{text}</pre></body></html>")
    return subject, text, html


# ---------------------------------------------------------------------------
# SMTP send (reuses email provider env vars)
# ---------------------------------------------------------------------------

def _send_email(recipient: str, subject: str, text: str, html: str) -> None:
    import os, smtplib
    host = os.environ.get("SMTP_HOST", "")
    if not host:
        logger.info("DEV report → %s  subject=%s  (SMTP not configured)",
                    recipient, subject)
        return

    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASSWORD", "")
    from_addr = os.environ.get("SMTP_FROM", user or "noreply@jlmirror.com")
    tls_mode = os.environ.get("SMTP_TLS", "starttls")

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = recipient
    msg.attach(MIMEText(text, "plain", "utf-8"))
    msg.attach(MIMEText(html, "html", "utf-8"))

    if tls_mode == "ssl":
        server = smtplib.SMTP_SSL(host, port, timeout=10)
    elif tls_mode == "starttls":
        server = smtplib.SMTP(host, port, timeout=10)
        server.starttls()
    else:
        logger.warning("SMTP_TLS=%r is not recognized; using plaintext SMTP", tls_mode)
        server = smtplib.SMTP(host, port, timeout=10)
    if user and password:
        server.login(user, password)
    server.sendmail(from_addr, [recipient], msg.as_string())
    server.quit()


# ---------------------------------------------------------------------------
# Worker entry
# ---------------------------------------------------------------------------

def _process_pending(conn: psycopg.Connection) -> int:
    processed = 0
    now = datetime.now(timezone.utc)

    cur = conn.execute(
        """
        SELECT s.report_schedule_id, s.tenant_id, s.template_id, s.interval_secs,
               t.name, t.report_type, t.delivery_email, t.enabled
          FROM g1.report_schedule s
          JOIN g1.report_template t ON t.template_id = s.template_id
         WHERE s.enabled = true
           AND s.next_send_at <= %s
         LIMIT 10
        """,
        (now,),
    )
    due = cur.fetchall()

    for (schedule_id, tenant_id, template_id, interval_secs,
         name, report_type, recipient, tmpl_enabled) in due:

        if not tmpl_enabled:
            conn.execute(
                "UPDATE g1.report_schedule SET enabled=false "
                "WHERE report_schedule_id=%s",
                (schedule_id,))
            conn.commit()
            continue

        conn.execute(
            "SELECT set_config('jlmirror.tenant_id', %s, false)", (tenant_id,))

        period_end = now
        period_start = now - timedelta(seconds=interval_secs)
        delivery_id = f"rdel:{secrets.token_urlsafe(16)}"
        next_send = datetime.fromtimestamp(
            now.timestamp() + interval_secs, tz=timezone.utc)

        # Create delivery record
        conn.execute(
            """
            INSERT INTO g1.report_delivery
                (delivery_id, tenant_id, template_id, report_type, recipient,
                 outcome, period_start, period_end)
            VALUES (%s, %s, %s, %s, %s, 'pending', %s, %s)
            """,
            (delivery_id, tenant_id, template_id, report_type,
             recipient, period_start, period_end),
        )
        # Advance schedule
        conn.execute(
            "UPDATE g1.report_schedule SET last_sent_at=%s, next_send_at=%s "
            "WHERE report_schedule_id=%s",
            (now, next_send, schedule_id),
        )
        conn.commit()

        # Collect data
        try:
            if report_type == "alert_summary":
                rows, total = _collect_alert_summary(
                    conn, tenant_id, period_start, period_end)
            elif report_type == "sla_summary":
                rows, total = _collect_sla_summary(
                    conn, tenant_id, period_start, period_end)
            else:
                rows, total = _collect_incident_summary(
                    conn, tenant_id, period_start, period_end)

            subject, text, html = _build_email(
                report_type, name, tenant_id, period_start, period_end, rows, total)
            _send_email(recipient, subject, text, html)

            conn.execute(
                "UPDATE g1.report_delivery "
                "SET outcome='sent', row_count=%s, delivered_at=now() "
                "WHERE delivery_id=%s",
                (total, delivery_id),
            )
            conn.commit()
            logger.info("report sent: template=%s tenant=%s type=%s rows=%s",
                        name, tenant_id, report_type, total)
        except Exception as exc:
            conn.rollback()
            err = str(exc)[:512]
            try:
                conn.execute(
                    "UPDATE g1.report_delivery SET outcome='failed', error_detail=%s "
                    "WHERE delivery_id=%s",
                    (err, delivery_id),
                )
                conn.commit()
            except Exception:
                conn.rollback()
            logger.exception("report delivery %s failed", delivery_id)

        processed += 1

    return processed
