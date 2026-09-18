"""Fake Zabbix 7.4.13 contract tests — the simulator must behave like
the real JSON-RPC API so E2E evidence stays meaningful."""

from __future__ import annotations

import pytest

from scripts.fake_zabbix import (
    ERR_INVALID_PARAMS,
    ERR_METHOD_NOT_FOUND,
    make_dev_server,
    rpc_client,
)


@pytest.fixture()
def server():
    return make_dev_server(api_token="dev-token")


def _req(method, params=None, req_id=7):
    return {"jsonrpc": "2.0", "method": method,
            "params": params or {}, "id": req_id}


def test_envelope_and_apiinfo_unauthenticated(server):
    resp = server.handle(_req("apiinfo.version"), None)
    assert resp["jsonrpc"] == "2.0"
    assert resp["result"] == "7.4.13"
    assert resp["id"] == 7


def test_auth_required_on_other_methods(server):
    resp = server.handle(_req("host.get"), None)
    assert resp["error"]["code"] == ERR_INVALID_PARAMS
    assert "Not authorized" in resp["error"]["data"]
    assert resp["id"] == 7
    # wrong token also rejected
    resp = server.handle(_req("host.get"), "Bearer wrong")
    assert "error" in resp


def test_valid_token_accepted(server):
    resp = server.handle(_req("host.get", {"output": ["hostid"]}),
                         "Bearer dev-token")
    assert "error" not in resp
    assert len(resp["result"]) == 2
    assert resp["result"][0] == {"hostid": "10101"}


def test_unknown_method(server):
    resp = server.handle(_req("nope.get"), "Bearer dev-token")
    assert resp["error"]["code"] == ERR_METHOD_NOT_FOUND


def test_hostget_group_filter_and_limit(server):
    resp = server.handle(
        _req("host.get", {"groupids": ["5"], "limit": 1,
                          "output": ["hostid"]}),
        "Bearer dev-token")
    assert len(resp["result"]) == 1
    resp = server.handle(
        _req("host.get", {"groupids": ["999"], "output": ["hostid"]}),
        "Bearer dev-token")
    assert resp["result"] == []


def test_itemget_itemids_and_output_projection(server):
    resp = server.handle(
        _req("item.get", {"itemids": ["20101", "20201"],
                          "output": ["itemid", "lastvalue"]}),
        "Bearer dev-token")
    assert len(resp["result"]) == 2
    assert all(set(r) <= {"itemid", "lastvalue"} for r in resp["result"])


def test_history_window_filter(server):
    import time
    now = int(time.time())
    resp = server.handle(
        _req("history.get", {"history": 0, "itemids": ["20101"],
                             "time_from": now - 400, "time_till": now,
                             "output": ["itemid", "clock", "value"]}),
        "Bearer dev-token")
    assert len(resp["result"]) == 3
    # outside the window -> nothing
    resp = server.handle(
        _req("history.get", {"history": 0, "itemids": ["20101"],
                             "time_from": now - 10, "time_till": now,
                             "output": ["itemid"]}),
        "Bearer dev-token")
    assert resp["result"] == []


def test_rpc_client_auth_error_maps_to_domain(server):
    rpc = rpc_client(server)
    from providers.zabbix import ProviderAuthenticationError
    with pytest.raises(ProviderAuthenticationError):
        rpc("https://zabbix.example.com/api_jsonrpc.php",
            "host.get", {}, "wrong-token")


def test_rpc_client_result_passthrough(server):
    rpc = rpc_client(server)
    out = rpc("https://zabbix.example.com/api_jsonrpc.php",
              "trigger.get", {"output": ["triggerid"]}, "dev-token")
    assert out == [{"triggerid": "30001"}]
