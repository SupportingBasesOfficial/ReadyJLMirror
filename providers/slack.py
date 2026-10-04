"""G29 Slack incoming-webhook notification adapter.

send_message() matches the WhatsApp/email adapter interface so
notification_dispatch can route by channel_class with a single elif branch.

Dev mode: if SLACK_DEV_MODE=1 (or destination_ref is a dev-placeholder),
messages are logged to stderr — no HTTP call made — so the full dispatch
pipeline can be exercised without a real Slack workspace.

Env var:
  SLACK_DEV_MODE — set to "1" to force dev-logging regardless of webhook URL
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request
import uuid

logger = logging.getLogger(__name__)


class SlackError(Exception):
    pass


_TEMPLATES: dict[str, str] = {
    "alert_notification": (
        ":warning: *Alert requires attention*\n"
        "An alert on your monitored infrastructure requires your attention. "
        "Log in to the NOC dashboard to review and acknowledge."
    ),
    "alert_critical": (
        ":rotating_light: *CRITICAL alert*\n"
        "A CRITICAL severity alert has been raised on your monitored infrastructure. "
        "Immediate action may be required."
    ),
    "alert_resolved": (
        ":white_check_mark: *Alert resolved*\n"
        "A previously raised alert has been resolved."
    ),
    "incident_notification": (
        ":fire: *Incident requires attention*\n"
        "An incident on your monitored infrastructure requires your attention. "
        "Please log in to the NOC dashboard to review."
    ),
    "maintenance_scheduled": (
        ":tools: *Maintenance window scheduled*\n"
        "A maintenance window has been scheduled. "
        "Notifications for affected sources will be suppressed during this window."
    ),
}

_DEFAULT_TEXT = (
    ":bell: *JLMirror notification*\n"
    "You have received a notification. Log in to review."
)


def send_message(
    *,
    destination_ref: str,
    template_name: str,
    correlation_id: str,
    timeout: float = 10.0,
) -> dict:
    """Post an alert notification to a Slack incoming-webhook URL.

    destination_ref — the full https://hooks.slack.com/... webhook URL.
    template_name   — maps to a canned Slack message text.
    correlation_id  — attached as a footer field for tracing.
    """
    dev_mode = os.environ.get("SLACK_DEV_MODE", "").strip() == "1"
    is_placeholder = not destination_ref.startswith("https://")

    if dev_mode or is_placeholder:
        logger.info(
            "DEV slack → %s  template=%s  corr=%s  (dev mode)",
            destination_ref, template_name, correlation_id,
        )
        return {
            "provider_message_ref": f"dev-slack-{uuid.uuid4().hex[:12]}",
            "accepted": True,
            "raw": {"provider_status": "dev_logged"},
        }

    text = _TEMPLATES.get(template_name, _DEFAULT_TEXT)
    payload = {
        "blocks": [
            {
                "type": "section",
                "text": {"type": "mrkdwn", "text": text},
            },
            {
                "type": "context",
                "elements": [
                    {
                        "type": "mrkdwn",
                        "text": f"Correlation ID: `{correlation_id}`",
                    }
                ],
            },
        ]
    }
    body = json.dumps(payload).encode()
    req = urllib.request.Request(
        destination_ref,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            status = resp.status
            resp_body = resp.read().decode(errors="replace")
    except urllib.error.HTTPError as exc:
        raise SlackError(f"slack_http:{exc.code}") from exc
    except OSError as exc:
        raise SlackError(f"transport:{type(exc).__name__}") from exc

    if status != 200 or resp_body != "ok":
        raise SlackError(f"slack_rejected:{status}:{resp_body[:64]}")

    ref = f"slack-{uuid.uuid4().hex[:12]}"
    return {
        "provider_message_ref": ref,
        "accepted": True,
        "raw": {"provider_status": str(status)},
    }
