"""WhatsApp adapter for Z-PRO gateway (channel class whatsapp_business@1).

Z-PRO (api.2ktecnologia.com) is a Z-API-compatible Brazilian WhatsApp
gateway. Sends plain text — no Meta template registry required.

Configure via env:
  WHATSAPP_API_URL      = https://api.2ktecnologia.com/v2/api/external/{instanceId}
  WHATSAPP_ACCESS_TOKEN = your Z-PRO Client-Token (omit if the UUID is the only key)

Dev: set WHATSAPP_API_URL to the internal dev sink to discard sends silently.
"""

from __future__ import annotations

import os

import httpx

# Simple human-readable templates keyed by template_name.
# Variables are interpolated positionally as {0}, {1}, ...
_TEMPLATES: dict[str, str] = {
    "ir_error_event": "🚨 *Incidente detectado*\nTenant: {0}\nCorrelação: {1}",
}


class WhatsAppError(Exception):
    pass


def _compose(template_name: str, variables: list[str] | None) -> str:
    """Build message text from template_name + optional variables."""
    tpl = _TEMPLATES.get(template_name)
    if tpl and variables:
        try:
            return tpl.format(*variables)
        except (IndexError, KeyError):
            pass
    if variables:
        return f"{template_name}\n" + "\n".join(str(v) for v in variables)
    return template_name


def send_message(*, destination_ref: str, template_name: str,
                 correlation_id: str, timeout: float = 10.0,
                 template_variables: list[str] | None = None,
                 language_code: str = "en") -> dict:
    """POST {base}/send-text — returns
    {'provider_message_ref': ..., 'accepted': True} on HTTP 2xx.

    Z-PRO/Z-API wire shape: {"phone": "55119...", "message": "text"}
    Auth: Client-Token header.
    A 2xx means PROVIDER ACCEPTED — not delivered, not read."""
    base = os.environ.get("WHATSAPP_API_URL", "").rstrip("/")
    if not base:
        raise WhatsAppError("whatsapp_api_url_not_configured")
    token = os.environ.get("WHATSAPP_ACCESS_TOKEN", "")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Client-Token"] = token
    url = f"{base}/send-text"
    payload = {
        "phone": destination_ref,
        "message": _compose(template_name, template_variables),
    }
    try:
        resp = httpx.post(url, json=payload, headers=headers,
                          timeout=timeout)
    except httpx.HTTPError as exc:
        raise WhatsAppError(f"transport_error:{type(exc).__name__}")
    if resp.status_code // 100 != 2:
        raise WhatsAppError(f"provider_rejected:{resp.status_code}")
    data = resp.json() if resp.content else {}
    # Z-PRO/Z-API returns {"zaapId": "...", "messageId": "...", "id": "..."}
    msg_id = data.get("messageId") or data.get("zaapId") or data.get("id")
    return {"provider_message_ref": msg_id,
            "accepted": True, "raw": {"provider_status": resp.status_code}}
