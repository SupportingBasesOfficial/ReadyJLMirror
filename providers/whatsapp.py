"""WhatsApp Business adapter (channel class whatsapp_business@1).

Provider-neutral domain outside; this module is the ONLY place that
knows Meta's wire shape. Provider message IDs are evidence refs —
never platform identity.

Dev: WHATSAPP_API_URL may point at the internal dev sink; the
access token comes from env for dev — production resolves it via
credential binding like other providers (never hardcoded).
"""

from __future__ import annotations

import os

import httpx


class WhatsAppError(Exception):
    pass


def send_message(*, destination_ref: str, template_name: str,
                 correlation_id: str, timeout: float = 10.0) -> dict:
    """POST /{phone_number_id}/messages — returns
    {'provider_message_ref': ..., 'accepted': True} on HTTP 2xx.

    A 2xx means PROVIDER ACCEPTED — not delivered, not read."""
    base = os.environ.get("WHATSAPP_API_URL", "").rstrip("/")
    if not base:
        raise WhatsAppError("whatsapp_api_url_not_configured")
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"{base}/{destination_ref}/messages"
    payload = {
        "messaging_product": "whatsapp",
        "to": destination_ref,
        "type": "template",
        "template": {"name": template_name,
                     "language": {"code": "en"}},
    }
    try:
        resp = httpx.post(url, json=payload, headers=headers,
                          timeout=timeout)
    except httpx.HTTPError as exc:
        raise WhatsAppError(f"transport_error:{type(exc).__name__}")
    if resp.status_code // 100 != 2:
        raise WhatsAppError(f"provider_rejected:{resp.status_code}")
    data = resp.json() if resp.content else {}
    msgs = data.get("messages") or [{}]
    return {"provider_message_ref": msgs[0].get("id"),
            "accepted": True, "raw": {"provider_status": resp.status_code}}
