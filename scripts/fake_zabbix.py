"""Fake Zabbix 7.4.13 JSON-RPC API — contract-faithful simulator.

Emulates the real Zabbix HTTP JSON-RPC endpoint (`api_jsonrpc.php`)
for dev E2E: validates the request envelope, enforces Bearer-token
authentication on every method except `apiinfo.version`, honors
filters/limits/output/select* params, and returns the exact response
envelope Zabbix produces:

    {"jsonrpc": "2.0", "result": <result>, "id": <request id>}
    {"jsonrpc": "2.0", "error": {"code": -32602, "message": "Invalid
      params.", "data": "Not authorized."}, "id": <request id>}

The dataset is provider-side state only — the platform source
configuration (base_url, credential binding, host-group refs) always
comes from the user through the normal onboarding path.
"""

from __future__ import annotations

import time
from typing import Any

# Zabbix JSON-RPC error codes
ERR_PARSE = -32700
ERR_INVALID_REQUEST = -32600
ERR_METHOD_NOT_FOUND = -32601
ERR_INVALID_PARAMS = -32602
ERR_INTERNAL = -32603

_UNAUTHENTICATED_METHODS = {"apiinfo.version"}


def _error(code: int, message: str, data: str, req_id: Any) -> dict:
    return {
        "jsonrpc": "2.0",
        "error": {"code": code, "message": message, "data": data},
        "id": req_id,
    }


def _result(value: Any, req_id: Any) -> dict:
    return {"jsonrpc": "2.0", "result": value, "id": req_id}


def _project(row: dict, output: list[str] | None) -> dict:
    if not output:
        return dict(row)
    return {k: row[k] for k in output if k in row}


class FakeZabbixServer:
    """In-memory Zabbix 7.4.13 API simulator.

    `handle(body, authorization)` accepts the raw JSON-RPC request dict
    and the Authorization header value, returning the raw response dict.
    """

    def __init__(self, api_token: str, *, version: str = "7.4.13") -> None:
        self.api_token = api_token
        self.version = version
        self.host_groups: list[dict] = []
        self.hosts: list[dict] = []
        self.items: list[dict] = []
        self.triggers: list[dict] = []
        self.problems: list[dict] = []
        self.history: list[dict] = []

    # -- request handling ---------------------------------------------------

    def handle(self, body: Any, authorization: str | None) -> dict:
        if not isinstance(body, dict):
            return _error(ERR_PARSE, "Parse error", "Invalid JSON.", None)
        req_id = body.get("id")
        if body.get("jsonrpc") != "2.0" or not isinstance(
            body.get("method"), str
        ):
            return _error(
                ERR_INVALID_REQUEST, "Invalid Request",
                "The JSON sent is not a valid Request object.", req_id)

        method = body["method"]
        params = body.get("params") or {}

        if method not in _UNAUTHENTICATED_METHODS:
            expected = f"Bearer {self.api_token}"
            if authorization != expected:
                return _error(
                    ERR_INVALID_PARAMS, "Invalid params.",
                    "Not authorized.", req_id)

        handler = getattr(self, f"_m_{method.replace('.', '_')}", None)
        if handler is None:
            return _error(
                ERR_METHOD_NOT_FOUND, "Method not found",
                f'Method "{method}" not found.', req_id)
        try:
            return _result(handler(params), req_id)
        except FakeZabbixError as exc:
            return _error(exc.code, exc.message, exc.data, req_id)

    # -- methods ------------------------------------------------------------

    def _m_apiinfo_version(self, _p: dict) -> str:
        return self.version

    def _m_hostgroup_get(self, p: dict) -> list:
        rows = self.host_groups
        filt = (p.get("filter") or {}).get("groupid")
        if filt is not None:
            rows = [g for g in rows if g["groupid"] in filt]
        return [_project(g, p.get("output")) for g in rows]

    def _m_host_get(self, p: dict) -> list:
        rows = self.hosts
        groupids = p.get("groupids")
        if groupids:
            rows = [
                h for h in rows
                if any(g["groupid"] in groupids
                       for g in h.get("groups") or [])
            ]
        limit = p.get("limit")
        if limit is not None:
            rows = rows[: int(limit)]
        # Sub-select results are extra row keys alongside `output` —
        # Zabbix 7.x renamed selectGroups -> selectHostGroups and the
        # response key `groups` -> `hostgroups`.
        out = []
        for h in rows:
            row = _project(h, p.get("output"))
            if p.get("selectInterfaces"):
                row["interfaces"] = [
                    _project(i, p["selectInterfaces"])
                    for i in h.get("interfaces") or []]
            if p.get("selectHostGroups"):
                row["hostgroups"] = [
                    _project(g, p["selectHostGroups"])
                    for g in h.get("groups") or []]
            if p.get("selectGroups"):
                row["groups"] = [
                    _project(g, p["selectGroups"])
                    for g in h.get("groups") or []]
            if p.get("selectParentTemplates"):
                row["parentTemplates"] = [
                    _project(t, p["selectParentTemplates"])
                    for t in h.get("parentTemplates") or []]
            if p.get("selectTags"):
                row["tags"] = [
                    _project(t, p["selectTags"])
                    for t in h.get("tags") or []]
            if p.get("selectInventory"):
                row["inventory"] = dict(h.get("inventory") or {})
            out.append(row)
        return out

    def _m_item_get(self, p: dict) -> list:
        rows = self.items
        if p.get("itemids"):
            rows = [i for i in rows if i["itemid"] in p["itemids"]]
        groupids = p.get("groupids")
        if groupids:
            host_ids = {
                h["hostid"] for h in self.hosts
                if any(g["groupid"] in groupids
                       for g in h.get("groups") or [])
            }
            rows = [i for i in rows if i["hostid"] in host_ids]
        if p.get("hostids"):
            rows = [i for i in rows if i["hostid"] in p["hostids"]]
        limit = p.get("limit")
        if limit is not None:
            rows = rows[: int(limit)]
        return [_project(i, p.get("output")) for i in rows]

    def _m_history_get(self, p: dict) -> list:
        value_type = int(p.get("history", 0))
        itemids = set(p.get("itemids") or [])
        frm = int(p.get("time_from", 0))
        till = int(p.get("time_till", 2**63 - 1))
        rows = [
            r for r in self.history
            if int(r.get("value_type", 0)) == value_type
            and r["itemid"] in itemids
            and frm <= int(r["clock"]) <= till
        ]
        if p.get("sortfield") == ["clock", "ns"]:
            rows.sort(key=lambda r: (int(r["clock"]), int(r.get("ns", 0))))
        limit = p.get("limit")
        if limit is not None:
            rows = rows[: int(limit)]
        return [_project(r, p.get("output")) for r in rows]

    def _m_problem_get(self, p: dict) -> list:
        rows = self.problems
        if p.get("eventids"):
            rows = [r for r in rows if r["eventid"] in p["eventids"]]
        if p.get("source") is not None and int(p.get("source")) == 0:
            rows = [r for r in rows if r.get("source", "0") == "0"]
        if p.get("object") is not None and int(p.get("object")) == 0:
            rows = [r for r in rows if r.get("object", "0") == "0"]
        if p.get("sortfield") == "eventid":
            rows.sort(key=lambda r: int(r["eventid"]))
        limit = p.get("limit")
        if limit is not None:
            rows = rows[: int(limit)]
        out = []
        for r in rows:
            row = _project(r, p.get("output"))
            if p.get("selectTags"):
                row["tags"] = [
                    _project(t, p["selectTags"])
                    for t in r.get("tags") or []]
            out.append(row)
        return out

    def _m_trigger_get(self, p: dict) -> list:
        rows = self.triggers
        limit = p.get("limit")
        if limit is not None:
            rows = rows[: int(limit)]
        out = []
        for t in rows:
            row = _project(t, p.get("output"))
            if p.get("selectHosts"):
                row["hosts"] = [
                    _project(h, p["selectHosts"])
                    for h in t.get("hosts") or []]
            out.append(row)
        return out


class FakeZabbixError(Exception):
    def __init__(self, code: int, message: str, data: str) -> None:
        super().__init__(data)
        self.code = code
        self.message = message
        self.data = data


def make_dev_server(api_token: str = "dev-token") -> FakeZabbixServer:
    """Canned dev dataset: 2 hosts, 3 items, history, 1 active problem."""
    srv = FakeZabbixServer(api_token)
    now = int(time.time())

    srv.host_groups = [{"groupid": "5", "name": "Linux servers"}]
    srv.hosts = [
        {"hostid": "10101", "host": "web-01", "name": "Web Server 01",
         "interfaces": [{"interfaceid": "1", "type": "1", "main": "1",
                         "useip": "1", "ip": "10.0.0.11", "dns": "",
                         "port": "10050"}],
         "groups": [{"groupid": "5", "name": "Linux servers"}],
         "parentTemplates": [],
         "tags": [{"tag": "env", "value": "dev"}],
         "inventory": {"os": "Linux", "vendor": "ACME"}},
        {"hostid": "10202", "host": "db-01", "name": "Database 01",
         "interfaces": [{"interfaceid": "2", "type": "1", "main": "1",
                         "useip": "1", "ip": "10.0.0.12", "dns": "",
                         "port": "10050"}],
         "groups": [{"groupid": "5", "name": "Linux servers"}],
         "parentTemplates": [], "tags": [], "inventory": {}},
    ]
    srv.items = [
        {"itemid": "20101", "hostid": "10101", "name": "CPU load",
         "key_": "system.cpu.load", "units": "", "value_type": "0",
         "state": "0", "status": "0", "lastvalue": "0.42",
         "lastclock": str(now - 10), "lastns": "500000000"},
        {"itemid": "20102", "hostid": "10101", "name": "Memory used %",
         "key_": "vm.memory.util", "units": "%", "value_type": "0",
         "state": "0", "status": "0", "lastvalue": "71.5",
         "lastclock": str(now - 10), "lastns": "600000000"},
        {"itemid": "20201", "hostid": "10202", "name": "CPU load",
         "key_": "system.cpu.load", "units": "", "value_type": "0",
         "state": "0", "status": "0", "lastvalue": "1.87",
         "lastclock": str(now - 10), "lastns": "700000000"},
    ]
    srv.triggers = [
        {"triggerid": "30001", "hosts": [{"hostid": "10101"}]},
    ]
    srv.problems = [
        {"eventid": "90001", "objectid": "30001", "source": "0",
         "object": "0", "clock": str(now - 120),
         "name": "High CPU load on web-01", "severity": "3",
         "acknowledged": "0", "r_eventid": "0", "r_clock": "0",
         "tags": [{"tag": "scope", "value": "perf"}]},
    ]
    for item in srv.items:
        for offset in (300, 240, 180):
            srv.history.append(
                {"itemid": item["itemid"], "clock": str(now - offset),
                 "ns": "100000000", "value": "1.5", "value_type": "0"})
    return srv


def rpc_client(server: FakeZabbixServer):
    """Return a `_rpc`-compatible callable that runs the full JSON-RPC
    envelope through the fake server — same request shape the real
    adapter sends, same envelope the real server returns."""

    def _fake_rpc(endpoint: str, method: str, params: dict,
                  api_token: str):
        body = {
            "jsonrpc": "2.0", "method": method,
            "params": params, "id": 1,
        }
        resp = server.handle(body, f"Bearer {api_token}")
        if "error" in resp and resp["error"]:
            from providers.zabbix import (
                ProviderAuthenticationError, ProviderProtocolError)
            err = resp["error"]
            msg = str(err.get("data") or err.get("message") or "")
            if "not authorized" in msg.lower() or "session" in msg.lower():
                raise ProviderAuthenticationError(f"zabbix auth error: {msg}")
            raise ProviderProtocolError(f"zabbix rpc error: {msg}")
        if "result" not in resp:
            raise RuntimeError("fake zabbix: response missing result")
        return resp["result"]

    return _fake_rpc
