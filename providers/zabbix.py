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

from jlmirror_monitoring.host_inventory import (
    ZabbixHostEvidence,
    ZabbixHostInterfaceEvidence,
    ZabbixHostSnapshot,
    ZabbixInventoryEvidence,
    ZabbixNamedRefEvidence,
    ZabbixTagEvidence,
)
from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
    ProviderAuthenticationError,
    ProviderProtocolError,
    ProviderUnavailableError,
    ResolvedZabbixCredential,
    ZabbixHostGroup,
)

_INTERFACE_TYPES = {1: "agent", 2: "snmp", 3: "ipmi", 4: "jmx"}

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

    def host_get(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        host_group_refs: Sequence[str],
        *,
        max_hosts: int,
    ) -> ZabbixHostSnapshot:
        """Fetch hosts for the configured groups as normalized evidence.

        Requests `max_hosts + 1` so truncation is detectable: more rows
        than max_hosts means the snapshot is incomplete (the domain
        requires `hosts <= MAX_HOSTS_PER_SNAPSHOT` for construction).
        """
        result = _rpc(
            endpoint.api_url,
            "host.get",
            {
                "output": ["hostid", "host", "name"],
                "groupids": list(host_group_refs),
                "selectInterfaces": [
                    "interfaceid", "type", "main", "useip", "ip", "dns", "port"
                ],
                "selectGroups": ["groupid", "name"],
                "selectParentTemplates": ["templateid", "name"],
                "selectTags": ["tag", "value"],
                "selectInventory": "extend",
                "limit": max_hosts + 1,
            },
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("host.get result is not a list")

        complete = len(result) <= max_hosts
        hosts = [self._map_host(item) for item in result[:max_hosts]]
        return ZabbixHostSnapshot(hosts=tuple(hosts), complete=complete)

    @staticmethod
    def _map_host(item: Any) -> ZabbixHostEvidence:
        if not isinstance(item, dict) or "hostid" not in item:
            raise ProviderProtocolError("host.get malformed entry")
        try:
            raw_inventory = item.get("inventory") or {}
            inventory = ZabbixInventoryEvidence(
                device_type=raw_inventory.get("type") or None,
                device_type_full=raw_inventory.get("type_full") or None,
                os=raw_inventory.get("os") or None,
                os_full=raw_inventory.get("os_full") or None,
                vendor=raw_inventory.get("vendor") or None,
                model=raw_inventory.get("model") or None,
                serial_primary=raw_inventory.get("serialno_a") or None,
                serial_secondary=raw_inventory.get("serialno_b") or None,
                asset_tag=raw_inventory.get("tag") or None,
                hardware=raw_inventory.get("hardware") or None,
                software=raw_inventory.get("software") or None,
                location=raw_inventory.get("location") or None,
            )
            interfaces = tuple(
                ZabbixHostInterfaceEvidence(
                    interfaceid=str(iface["interfaceid"]),
                    interface_type=_INTERFACE_TYPES.get(
                        int(iface.get("type", 0)), "unknown"
                    ),
                    main=str(iface.get("main", "0")) == "1",
                    use_ip=str(iface.get("useip", "0")) == "1",
                    ip=iface.get("ip") or None,
                    dns=iface.get("dns") or None,
                    port=iface.get("port") or None,
                )
                for iface in item.get("interfaces") or []
            )
            groups = tuple(
                ZabbixNamedRefEvidence(
                    ref=str(g["groupid"]), name=g.get("name")
                )
                for g in item.get("groups") or []
            )
            templates = tuple(
                ZabbixNamedRefEvidence(
                    ref=str(t["templateid"]), name=t.get("name")
                )
                for t in item.get("parentTemplates") or []
            )
            tags = tuple(
                ZabbixTagEvidence(
                    tag=str(t["tag"]), value=str(t.get("value", ""))
                )
                for t in item.get("tags") or []
            )
            return ZabbixHostEvidence(
                hostid=str(item["hostid"]),
                technical_name=str(item.get("host", "")),
                display_name=str(item.get("name", "")),
                inventory=inventory,
                interfaces=interfaces,
                groups=groups,
                templates=templates,
                tags=tags,
            )
        except (KeyError, AttributeError, TypeError, ValueError) as exc:
            raise ProviderProtocolError(
                f"host.get entry failed normalization: {exc}"
            ) from exc
