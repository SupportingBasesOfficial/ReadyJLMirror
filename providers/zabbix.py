"""Zabbix provider adapter — JSON-RPC client.

Implements the domain ports:
  - `ZabbixHostGroupReader` — hostgroup.get
  - `ZabbixHostReader` — host.get (host inventory, next slice)

Provider payloads are translated here into domain evidence dataclasses;
Zabbix IDs/names stay external references.
"""

from __future__ import annotations

import logging
from typing import Any, Optional, Sequence

import httpx

from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
    ProviderAuthenticationError,
    ProviderProtocolError,
    ProviderUnavailableError,
    ResolvedZabbixCredential,
    ZabbixHostGroup,
)

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(connect=5.0, read=15.0, write=10.0, pool=5.0)


def _rpc(endpoint: str, method: str, params: dict, api_token: str) -> Any:
    """Execute a Zabbix JSON-RPC call. Raises the domain error classes."""
    payload = {
        "jsonrpc": "2.0",
        "method": method,
        "params": params,
        "id": 1,
    }
    try:
        with httpx.Client(timeout=_TIMEOUT, verify=True) as client:
            resp = client.post(
                endpoint,
                json=payload,
                headers={"Authorization": f"Bearer {api_token}"},
            )
    except httpx.TimeoutException as exc:
        raise ProviderUnavailableError(f"zabbix timeout: {exc}") from exc
    except httpx.HTTPError as exc:
        raise ProviderUnavailableError(f"zabbix unreachable: {exc}") from exc

    if resp.status_code == 401 or resp.status_code == 403:
        raise ProviderAuthenticationError("zabbix authentication rejected")
    if resp.status_code != 200:
        raise ProviderUnavailableError(f"zabbix HTTP {resp.status_code}")

    try:
        body = resp.json()
    except ValueError as exc:
        raise ProviderProtocolError("zabbix non-JSON response") from exc

    if "error" in body and body["error"]:
        err = body["error"]
        msg = str(err.get("data") or err.get("message") or "")
        if "not authorized" in msg.lower() or "session" in msg.lower():
            raise ProviderAuthenticationError(f"zabbix auth error: {msg}")
        raise ProviderProtocolError(f"zabbix rpc error: {msg}")
    if "result" not in body:
        raise ProviderProtocolError("zabbix response missing result")
    return body["result"]


class ZabbixClient:
    """Concrete Zabbix adapter implementing the reader ports."""

    def hostgroup_get(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        host_group_refs: Sequence[str],
    ) -> Sequence[ZabbixHostGroup]:
        """Fetch the configured host groups by ref (name or groupid)."""
        result = _rpc(
            endpoint.api_url,
            "hostgroup.get",
            {
                "output": ["groupid", "name"],
                # host_group_refs are the provider-visible group identifiers
                # the tenant bound as scope anchors; visibility is checked
                # by groupid membership in the domain worker.
                "filter": {"groupid": list(host_group_refs)},
            },
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("hostgroup.get result is not a list")
        groups: list[ZabbixHostGroup] = []
        for item in result:
            if not isinstance(item, dict) or "groupid" not in item:
                raise ProviderProtocolError("hostgroup.get malformed entry")
            groups.append(
                ZabbixHostGroup(groupid=str(item["groupid"]), name=item.get("name"))
            )
        return groups

    def api_version(self, endpoint: AdmittedProviderEndpoint) -> str:
        """Provider version probe (unauthenticated by design in Zabbix)."""
        result = _rpc(endpoint.api_url, "apiinfo.version", {}, "")
        return str(result)
