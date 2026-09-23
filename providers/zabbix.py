"""Zabbix provider adapter — JSON-RPC client.

Implements the domain ports:
  - `ZabbixHostGroupReader` — hostgroup.get
  - `ZabbixHostReader` — host.get (host inventory, next slice)

Provider payloads are translated here into domain evidence dataclasses;
Zabbix IDs/names stay external references.
"""

from __future__ import annotations

import logging
from typing import Any, Sequence
from urllib.parse import urlparse

import httpx

from jlmirror_monitoring.host_inventory import (
    ZabbixHostEvidence,
    ZabbixHostInterfaceEvidence,
    ZabbixHostSnapshot,
    ZabbixInventoryEvidence,
    ZabbixNamedRefEvidence,
    ZabbixTagEvidence,
)
from jlmirror_monitoring.metric_current_state import (
    ZabbixCurrentValueEvidence,
)
from jlmirror_monitoring.metric_history import ZabbixHistoryEvidence
from jlmirror_monitoring.problem_state import (
    ProviderTag,
    ZabbixProblemEvidence,
    ZabbixRecoveryEvidence,
)
from jlmirror_monitoring.metric_definitions import (
    ZabbixItemEvidence,
    ZabbixItemOperationalState,
    ZabbixItemSnapshot,
    ZabbixNativeValueType,
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

# Zabbix item value_type -> normalized native value type
_ITEM_VALUE_TYPES = {
    0: ZabbixNativeValueType.FLOAT,
    1: ZabbixNativeValueType.CHARACTER,
    2: ZabbixNativeValueType.LOG,
    3: ZabbixNativeValueType.UNSIGNED,
    4: ZabbixNativeValueType.TEXT,
}


def _item_operational_state(item: dict) -> ZabbixItemOperationalState:
    # Zabbix: status 0=enabled 1=disabled; state 0=normal 1=unsupported
    if str(item.get("status", "0")) == "1":
        return ZabbixItemOperationalState.DISABLED
    if str(item.get("state", "0")) == "1":
        return ZabbixItemOperationalState.UNSUPPORTED
    return ZabbixItemOperationalState.ENABLED

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
    headers = {"Authorization": f"Bearer {api_token}"}
    extensions: dict = {}
    url = endpoint

    # DNS pinning: the egress admission resolved once and pinned the
    # admitted IP. Connect to the IP with Host + SNI bound to the
    # hostname — TLS identity is preserved, no second lookup exists.
    from providers import pins
    pinned = pins.get(endpoint)
    if pinned is not None:
        host, ip = pinned
        parsed = urlparse(endpoint)
        port = f":{parsed.port}" if parsed.port else ""
        url = f"{parsed.scheme}://{ip}{port}{parsed.path}"
        headers["Host"] = host
        extensions["sni_hostname"] = host

    try:
        # PROVIDER_CA_FILE: enterprise CA for internal/provider TLS
        # endpoints (private CAs are the norm for intranet Zabbix).
        # It AUGMENTS the public trust store — never replaces it — so
        # private-CA providers and public-CA providers both work.
        import os
        import ssl
        verify: "ssl.SSLContext | bool" = True
        ca_file = os.environ.get("PROVIDER_CA_FILE")
        if ca_file:
            ctx = ssl.create_default_context()
            try:
                ctx.load_verify_locations(cafile=ca_file)
            except (OSError, ssl.SSLError) as exc:
                raise ProviderUnavailableError(
                    f"PROVIDER_CA_FILE unreadable: {exc}") from exc
            verify = ctx
        with httpx.Client(timeout=_TIMEOUT, verify=verify) as client:
            resp = client.post(
                url,
                json=payload,
                headers=headers,
                extensions=extensions,
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
    """Concrete Zabbix adapter implementing the reader ports.

    ``scope_group_ids`` narrows provider reads (problem.get,
    trigger.get) to the source's declared host groups — without it a
    shared Zabbix instance returns problems for out-of-scope hosts,
    which the canonical collector must fail closed on. Set by the
    worker from the claim's provider configuration; None = unscoped
    (previous behavior).
    """

    def __init__(self) -> None:
        self.scope_group_ids: list[str] | None = None
        self._v7_group_select: bool | None = None

    def _group_select_param(self, endpoint: AdmittedProviderEndpoint) -> list[str]:
        """host.get group sub-select name for the server version.

        Zabbix 7.0 renamed `selectGroups` -> `selectHostGroups` (the
        response key became `hostgroups`). Older servers keep the old
        name; the new name is silently ignored pre-7.0, so the choice
        must be version-aware. `apiinfo.version` is unauthenticated
        by design — probed once per client instance.
        """
        if self._v7_group_select is None:
            try:
                major = int(str(self.api_version(endpoint)).split(".")[0])
                self._v7_group_select = major >= 7
            except Exception:
                self._v7_group_select = "unknown"
        if self._v7_group_select is True:
            return ["selectHostGroups"]
        if self._v7_group_select is False:
            return ["selectGroups"]
        # Version undeterminable: request both names — servers ignore
        # the unknown one and the mapper merges either response key.
        return ["selectHostGroups", "selectGroups"]

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
        return self._parse_groups(result)

    def list_host_groups(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
    ) -> Sequence[ZabbixHostGroup]:
        """Discover every host group visible to the credential.

        Unfiltered ``hostgroup.get`` — used at onboarding so the tenant
        picks scope anchors from the provider's real group list instead
        of typing opaque groupids.
        """
        result = _rpc(
            endpoint.api_url,
            "hostgroup.get",
            {"output": ["groupid", "name"], "sortfield": "name"},
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("hostgroup.get result is not a list")
        return self._parse_groups(result)

    @staticmethod
    def _parse_groups(result: Sequence[Any]) -> list[ZabbixHostGroup]:
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
                **{sel: ["groupid", "name"]
                   for sel in self._group_select_param(endpoint)},
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
            # Zabbix >= 7.0 returns `hostgroups`; older returns `groups`.
            groups = tuple(
                ZabbixNamedRefEvidence(
                    ref=str(g["groupid"]), name=g.get("name")
                )
                for g in (item.get("hostgroups") or item.get("groups") or [])
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

    def item_get(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        host_group_refs: Sequence[str],
        *,
        max_items: int,
    ) -> ZabbixItemSnapshot:
        """Fetch items for the configured groups as normalized evidence.

        Same truncation contract as host_get: `limit: max_items + 1`
        detects an incomplete snapshot without constructing one.
        """
        result = _rpc(
            endpoint.api_url,
            "item.get",
            {
                "output": [
                    "itemid", "hostid", "name", "key_",
                    "units", "value_type", "state", "status",
                ],
                "groupids": list(host_group_refs),
                "limit": max_items + 1,
            },
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("item.get result is not a list")

        complete = len(result) <= max_items
        items = [self._map_item(item) for item in result[:max_items]]
        return ZabbixItemSnapshot(items=tuple(items), complete=complete)

    @staticmethod
    def _map_item(item: Any) -> ZabbixItemEvidence:
        if not isinstance(item, dict) or "itemid" not in item:
            raise ProviderProtocolError("item.get malformed entry")
        try:
            native = _ITEM_VALUE_TYPES.get(int(item.get("value_type", -1)))
            if native is None:
                raise ProviderProtocolError(
                    f"item.get unknown value_type {item.get('value_type')}"
                )
            return ZabbixItemEvidence(
                itemid=str(item["itemid"]),
                hostid=str(item["hostid"]),
                name=str(item.get("name", "")),
                key=str(item.get("key_", "")),
                unit=str(item.get("units", "")),
                native_value_type=native,
                operational_state=_item_operational_state(item),
            )
        except (KeyError, AttributeError, TypeError, ValueError) as exc:
            raise ProviderProtocolError(
                f"item.get entry failed normalization: {exc}"
            ) from exc

    def read_current_values(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        itemids: Sequence[str],
        *,
        max_items: int,
    ) -> Sequence[ZabbixCurrentValueEvidence]:
        """Read the latest value per item via item.get.

        Zabbix `lastvalue`/`lastclock`/`lastns` is the provider's newest
        sample per item. Items whose value has never been collected
        (lastclock = 0) carry no observation — they are skipped here so
        one never-sampled item cannot poison the whole batch; the
        domain simply records no observation for them.
        """
        result = _rpc(
            endpoint.api_url,
            "item.get",
            {
                "output": ["itemid", "lastvalue", "lastclock", "lastns"],
                "itemids": list(itemids),
                "limit": max_items,
            },
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("item.get result is not a list")

        rows: list[ZabbixCurrentValueEvidence] = []
        for item in result:
            if not isinstance(item, dict) or "itemid" not in item:
                raise ProviderProtocolError("item.get malformed entry")
            try:
                lastclock = int(item.get("lastclock", 0) or 0)
            except (TypeError, ValueError) as exc:
                raise ProviderProtocolError(
                    f"item.get current value failed normalization: {exc}"
                ) from exc
            if lastclock <= 0:
                continue
            try:
                rows.append(
                    ZabbixCurrentValueEvidence(
                        itemid=str(item["itemid"]),
                        raw_value=str(item.get("lastvalue", "")),
                        lastclock=lastclock,
                        lastns=int(item.get("lastns", 0)),
                    )
                )
            except (TypeError, ValueError) as exc:
                raise ProviderProtocolError(
                    f"item.get current value failed normalization: {exc}"
                ) from exc
        return rows

    def read_history(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        *,
        history_value_type: int,
        itemids: Sequence[str],
        time_from: int,
        time_till: int,
        max_rows: int,
    ) -> Sequence[ZabbixHistoryEvidence]:
        """Bounded history.get window read for one history value type."""
        result = _rpc(
            endpoint.api_url,
            "history.get",
            {
                "history": history_value_type,
                "itemids": list(itemids),
                "time_from": time_from,
                "time_till": time_till,
                "sortfield": ["clock", "ns"],
                "sortorder": "ASC",
                "limit": max_rows,
                "output": ["itemid", "clock", "ns", "value"],
            },
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("history.get result is not a list")

        rows: list[ZabbixHistoryEvidence] = []
        for item in result:
            if not isinstance(item, dict) or "itemid" not in item:
                raise ProviderProtocolError("history.get malformed entry")
            try:
                rows.append(
                    ZabbixHistoryEvidence(
                        itemid=str(item["itemid"]),
                        clock=int(item["clock"]),
                        ns=int(item.get("ns", 0)),
                        raw_value=str(item.get("value", "")),
                    )
                )
            except (TypeError, ValueError) as exc:
                raise ProviderProtocolError(
                    f"history.get entry failed normalization: {exc}"
                ) from exc
        return rows

    def read_active_problems(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        *,
        max_rows: int,
    ) -> tuple[Sequence[ZabbixProblemEvidence], bool]:
        """Active trigger problems (r_eventid='0') with explicit truncation
        detection — requests max_rows+1 so an over-bound response is provable."""
        result = _rpc(
            endpoint.api_url,
            "problem.get",
            {
                "source": 0,
                "object": 0,
                "output": ["eventid", "objectid", "clock", "name",
                           "severity", "acknowledged", "r_eventid"],
                "selectTags": "extend",
                "sortfield": "eventid",
                "limit": max_rows + 1,
                **({"groupids": list(self.scope_group_ids)}
                   if self.scope_group_ids else {}),
            },
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("problem.get result is not a list")

        complete = len(result) <= max_rows
        rows: list[ZabbixProblemEvidence] = []
        for item in result[:max_rows]:
            if not isinstance(item, dict) or "eventid" not in item:
                raise ProviderProtocolError("problem.get malformed entry")
            if str(item.get("r_eventid", "0")) != "0":
                continue  # resolved — recovery evidence handled separately
            try:
                tags = tuple(
                    ProviderTag(
                        key=str(t.get("tag", "")), value=str(t.get("value", ""))
                    )
                    for t in (item.get("tags") or [])
                    if isinstance(t, dict) and t.get("tag")
                )
                rows.append(
                    ZabbixProblemEvidence(
                        eventid=str(item["eventid"]),
                        objectid=str(item["objectid"]),
                        clock=int(item["clock"]),
                        name=str(item.get("name", "")),
                        severity=int(item.get("severity", 0)),
                        acknowledged=str(item.get("acknowledged", "0")) == "1",
                        tags=tags,
                    )
                )
            except (TypeError, ValueError) as exc:
                raise ProviderProtocolError(
                    f"problem.get entry failed normalization: {exc}"
                ) from exc
        return rows, complete

    def read_recovery_events(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        problem_eventids: Sequence[str],
        *,
        max_rows: int,
    ) -> Sequence[ZabbixRecoveryEvidence]:
        """Recovery evidence for known problem events — problem.get on the
        problem identity returns r_eventid/r_clock for resolved events."""
        if not problem_eventids:
            return ()
        result = _rpc(
            endpoint.api_url,
            "problem.get",
            {
                "eventids": list(problem_eventids),
                "output": ["eventid", "r_eventid", "r_clock"],
                "limit": max_rows,
            },
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("problem.get recovery result invalid")

        rows: list[ZabbixRecoveryEvidence] = []
        for item in result:
            if not isinstance(item, dict) or "eventid" not in item:
                raise ProviderProtocolError("problem.get recovery malformed")
            r_eventid = str(item.get("r_eventid", "0"))
            if r_eventid == "0":
                continue  # still active
            try:
                rows.append(
                    ZabbixRecoveryEvidence(
                        problem_eventid=str(item["eventid"]),
                        recovery_eventid=r_eventid,
                        clock=int(item.get("r_clock", 0)),
                    )
                )
            except (TypeError, ValueError) as exc:
                raise ProviderProtocolError(
                    f"recovery entry failed normalization: {exc}"
                ) from exc
        return rows

    def read_trigger_associations(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        *,
        max_rows: int,
    ) -> Sequence[tuple[str, str]]:
        """trigger.get selectHosts -> (triggerid, hostid) pairs. Provider
        evidence only — canonical binding happens repository-side."""
        result = _rpc(
            endpoint.api_url,
            "trigger.get",
            {
                "output": ["triggerid"],
                "selectHosts": ["hostid"],
                "limit": max_rows,
                **({"groupids": list(self.scope_group_ids)}
                   if self.scope_group_ids else {}),
            },
            credential.api_token,
        )
        if not isinstance(result, list):
            raise ProviderProtocolError("trigger.get result is not a list")
        pairs: list[tuple[str, str]] = []
        for item in result:
            if not isinstance(item, dict) or "triggerid" not in item:
                raise ProviderProtocolError("trigger.get malformed entry")
            hosts = item.get("hosts") or []
            if not hosts:
                continue
            pairs.append((str(item["triggerid"]), str(hosts[0]["hostid"])))
        return pairs
