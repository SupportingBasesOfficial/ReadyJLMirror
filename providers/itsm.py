"""G10 ITSM provider adapter — provider-neutral ticket linkage.

The adapter's job is exactly one: given an Incident + the durable
sync identity, create-or-link the external ticket and report the
normalized result. Provider ticket refs are evidence only — the
platform never treats them as Incident identity.

Dev default (`ITSM_PROVIDER_URL` unset): simulated provider that
returns a deterministic ticket ref — the outbox/attempt/link flow
is fully exercised without real credentials. Production: point the
URL at a governed ITSM bridge (ServiceNow/Jira/etc.) and put the
token behind a credential binding, same rule as Zabbix/WhatsApp.
"""

from __future__ import annotations

import hashlib
import json
import os
import urllib.request

ADAPTER_VERSION = "itsm-provider-neutral@1"


class ITSMError(Exception):
    """Transport/adapter failure — maps to outcome 'unknown' when
    it is a transport error, 'failed' otherwise."""


def _dev_ticket_ref(incident_id: str, sync_identity: str) -> str:
    return "dev-ticket-" + hashlib.sha256(
        f"{incident_id}:{sync_identity}".encode()).hexdigest()[:16]


def create_or_link(*, incident: dict, sync_identity: str) -> dict:
    """Return {'state': 'linked'|'failed'|'unknown',
               'provider_ticket_ref', 'provider_status',
               'failure_class'}."""
    url = os.environ.get("ITSM_PROVIDER_URL", "").rstrip("/")
    if not url:
        # Dev simulated provider — deterministic link evidence.
        return {
            "state": "linked",
            "provider_ticket_ref": _dev_ticket_ref(
                incident["incident_id"], sync_identity),
            "provider_status": "dev_linked",
            "failure_class": None,
        }
    body = json.dumps({
        "incident_id": incident["incident_id"],
        "alert_id": incident.get("alert_id"),
        "title": incident.get("title"),
        "description": incident.get("description"),
        "lifecycle_state": incident.get("lifecycle_state"),
        "sync_identity": sync_identity,
    }).encode()
    req = urllib.request.Request(
        f"{url}/tickets", data=body,
        headers={"Content-Type": "application/json"},
        method="POST")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            payload = json.loads(resp.read().decode())
        return {
            "state": payload.get("state", "linked"),
            "provider_ticket_ref": payload.get("provider_ticket_ref"),
            "provider_status": payload.get("provider_status",
                                          "provider_2xx"),
            "failure_class": payload.get("failure_class"),
        }
    except urllib.error.URLError as exc:
        raise ITSMError(f"itsm_transport:{exc}") from exc
