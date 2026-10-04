"""Generic HTTP webhook ITSM adapter.

Configured via environment variables:

  ITSM_WEBHOOK_URL   — full URL to POST ticket payloads to.
                       If unset, open_ticket falls back to skipped.
  ITSM_WEBHOOK_TOKEN — Bearer token sent in Authorization header.
                       Optional; omit for unauthenticated endpoints.
  ITSM_TIMEOUT       — request timeout in seconds (default: 15).

The endpoint must accept POST with Content-Type: application/json
and return JSON.  The adapter extracts the ticket ref from the
response using the first found key in:
  ref, ticket_id, id, number, sys_id, key, issue_id

Compatible with: ServiceNow (sys_id/number), Jira (id/key),
Freshdesk (id), Linear (id), custom webhooks (ref).
"""

from __future__ import annotations

import json
import logging
import os
import urllib.error
import urllib.request

logger = logging.getLogger(__name__)

_REF_KEYS = ("ref", "ticket_id", "id", "number", "sys_id", "key", "issue_id")
_TIMEOUT = int(os.environ.get("ITSM_TIMEOUT", "15"))


def _extract_ref(body: dict) -> str | None:
    for key in _REF_KEYS:
        val = body.get(key)
        if val:
            return str(val)
    # nested result object (some APIs wrap in {result: {...}})
    result = body.get("result")
    if isinstance(result, dict):
        return _extract_ref(result)
    return None


def open_ticket(
    tenant_id: str,
    request_id: str,
    event_id: str | None,
    metadata: dict | None = None,
) -> str | None:
    """POST an open_ticket payload to the configured webhook.

    Returns the provider ticket ref string on success, or None if
    the endpoint is not configured (caller should mark as skipped).

    Raises on HTTP or connection error (caller marks as failed).
    """
    url = os.environ.get("ITSM_WEBHOOK_URL", "").strip()
    if not url:
        return None

    token = os.environ.get("ITSM_WEBHOOK_TOKEN", "").strip()

    payload = json.dumps({
        "action": "open_ticket",
        "tenant_id": tenant_id,
        "request_id": request_id,
        "event_id": event_id,
        "metadata": metadata or {},
    }).encode()

    req = urllib.request.Request(
        url,
        data=payload,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    if token:
        req.add_header("Authorization", f"Bearer {token}")

    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            body = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"ITSM webhook HTTP {exc.code}: {exc.reason}"
        ) from exc
    except Exception as exc:
        raise RuntimeError(f"ITSM webhook error: {exc}") from exc

    ref = _extract_ref(body)
    if not ref:
        logger.warning(
            "itsm_adapter: no ref found in response keys=%s",
            list(body.keys())[:10],
        )
    return ref
