"""G22 email notification adapter.

send_message() matches the WhatsApp adapter interface exactly so
notification_dispatch can route by channel_class without any
adapter-specific branching beyond the import and the call.

Dev mode: if SMTP_HOST is unset, messages are logged to stderr
(no-op), allowing full end-to-end testing without a mail server.

Env vars:
  SMTP_HOST     — SMTP server hostname (required for real delivery)
  SMTP_PORT     — default 587
  SMTP_USER     — login username (optional if relay does not need auth)
  SMTP_PASSWORD — login password
  SMTP_FROM     — From address; defaults to SMTP_USER or noreply@jlmirror.com
  SMTP_TLS      — transport mode: starttls (default) | ssl | none
"""

from __future__ import annotations

import logging
import os
import smtplib
import uuid
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText

from shared.config import settings

logger = logging.getLogger(__name__)


class EmailError(Exception):
    pass


_TEMPLATES: dict[str, tuple[str, str]] = {
    "alert_notification": (
        "[JLMirror] Alert requires attention",
        "An alert on your monitored infrastructure requires your attention.\n\n"
        "Please log in to the JLMirror NOC dashboard to review and acknowledge.\n",
    ),
    "alert_critical": (
        "[JLMirror] CRITICAL alert",
        "A CRITICAL severity alert has been raised on your monitored infrastructure.\n\n"
        "Immediate action may be required. Log in to the JLMirror NOC dashboard now.\n",
    ),
    "alert_resolved": (
        "[JLMirror] Alert resolved",
        "A previously raised alert has been resolved.\n\n"
        "Log in to the JLMirror NOC dashboard to review the resolution.\n",
    ),
    "incident_notification": (
        "[JLMirror] Incident requires attention",
        "An incident on your monitored infrastructure requires your attention.\n\n"
        "Please log in to the JLMirror NOC dashboard to review.\n",
    ),
    "maintenance_scheduled": (
        "[JLMirror] Maintenance window scheduled",
        "A maintenance window has been scheduled for your monitored infrastructure.\n\n"
        "Notifications for affected sources will be suppressed during this window.\n",
    ),
}

_DEFAULT_SUBJECT = "[JLMirror] Notification"
_DEFAULT_BODY = (
    "You have received a notification from JLMirror.\n\n"
    "Log in to review: https://app.jlmirror.com\n"
)


def send_message(
    *,
    destination_ref: str,
    template_name: str,
    correlation_id: str,
    timeout: float = 10.0,
) -> dict:
    """Send an email notification.

    destination_ref — recipient e-mail address.
    template_name   — maps to a canned subject+body pair.
    correlation_id  — added as X-Correlation-ID header for tracing.
    Returns same shape as the WhatsApp adapter.
    """
    host = os.environ.get("SMTP_HOST", "")
    if not host:
        if settings.is_development:
            logger.info("DEV email → %s subject=%s", destination_ref, template_name)
            return {"provider_message_ref": f"dev-email-{uuid.uuid4()}", "accepted": True}
        raise RuntimeError("SMTP_HOST is not configured — cannot send email in production")

    port = int(os.environ.get("SMTP_PORT", "587"))
    user = os.environ.get("SMTP_USER", "")
    password = os.environ.get("SMTP_PASSWORD", "")
    from_addr = os.environ.get(
        "SMTP_FROM", user or "noreply@jlmirror.com"
    )
    tls_mode = os.environ.get("SMTP_TLS", "starttls")

    subject, body_text = _TEMPLATES.get(
        template_name, (_DEFAULT_SUBJECT, _DEFAULT_BODY)
    )
    message_id = f"<jlm-{uuid.uuid4().hex}@jlmirror>"

    msg = MIMEMultipart("alternative")
    msg["Subject"] = subject
    msg["From"] = from_addr
    msg["To"] = destination_ref
    msg["Message-ID"] = message_id
    msg["X-Correlation-ID"] = correlation_id
    msg.attach(MIMEText(body_text, "plain", "utf-8"))

    try:
        if tls_mode == "ssl":
            server = smtplib.SMTP_SSL(host, port, timeout=timeout)
        else:
            server = smtplib.SMTP(host, port, timeout=timeout)
            if tls_mode == "starttls":
                server.starttls()
        if user and password:
            server.login(user, password)
        server.sendmail(from_addr, [destination_ref], msg.as_string())
        server.quit()
    except smtplib.SMTPException as exc:
        raise EmailError(f"smtp:{type(exc).__name__}") from exc
    except OSError as exc:
        raise EmailError(f"transport:{type(exc).__name__}") from exc

    return {
        "provider_message_ref": message_id,
        "accepted": True,
        "raw": {"provider_status": "250"},
    }
