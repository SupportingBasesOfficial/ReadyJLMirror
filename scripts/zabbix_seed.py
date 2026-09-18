"""Seed the dev Zabbix provider profile — real objects over the real
JSON-RPC API so the monitoring pipeline ingests actual provider data.

Creates, idempotently:
  - an API token (written to secrets/cred-binding-1.token — the file
    the credential resolver reads, same shape as OpenBao output)
  - hostgroup "ReadyJLMirror"
  - host "zbx-agent-1" (the compose zabbix-agent) in that group
  - items agent.ping + system.cpu.load + trigger on high load

Usage: python -m scripts.zabbix_seed [--wait 120]
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path
from urllib import request as urlreq

import ssl as _ssl

API = "https://localhost:8443/api_jsonrpc.php"
CA = Path("secrets/tls/ca.pem")
TOKEN_FILE = Path("secrets/cred-binding-1.token")


def _ctx() -> _ssl.SSLContext:
    ctx = _ssl.create_default_context()
    if CA.exists():
        ctx.load_verify_locations(str(CA))
    else:
        ctx.check_hostname = False
        ctx.verify_mode = _ssl.CERT_NONE
    return ctx


def rpc(method: str, params: dict, token: str | None = None) -> object:
    body = {"jsonrpc": "2.0", "method": method, "params": params, "id": 1}
    req = urlreq.Request(
        API, data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json-rpc",
                 **({"Authorization": f"Bearer {token}"} if token else {})})
    with urlreq.urlopen(req, context=_ctx(), timeout=15) as resp:
        out = json.loads(resp.read())
    if out.get("error"):
        raise RuntimeError(f"{method}: {out['error']}")
    return out["result"]


def wait_ready(seconds: int) -> None:
    deadline = time.time() + seconds
    while time.time() < deadline:
        try:
            print("api version:", rpc("apiinfo.version", {}))
            return
        except Exception as exc:
            print(f"waiting for zabbix api... {type(exc).__name__}")
            time.sleep(5)
    raise RuntimeError("zabbix api did not come up")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wait", type=int, default=120)
    args = ap.parse_args()
    wait_ready(args.wait)

    # Admin session -> create a real API token
    session = rpc("user.login", {"username": "Admin", "password": "zabbix"})
    token_name = "readyjlmirror"
    token_id = None
    for t in rpc("token.get", {"output": ["tokenid", "name"]}, session):
        if t["name"] == token_name:
            token_id = t["tokenid"]
    if token_id is None:
        created = rpc("token.create", {
            "name": token_name, "userid": "1",
            "expires_at": int(time.time()) + 31536000}, session)
        token_id = created["tokenids"][0]
    generated = rpc("token.generate", {"tokenid": token_id}, session)
    if isinstance(generated, list) and generated:
        generated = generated[0]
    token_value = (generated.get("token") if isinstance(generated, dict)
                   else str(generated))
    TOKEN_FILE.parent.mkdir(exist_ok=True)
    TOKEN_FILE.write_text(token_value + "\n", encoding="utf-8")
    print(f"api token -> {TOKEN_FILE}")

    tok = token_value

    # Hostgroup
    gid = None
    for g in rpc("hostgroup.get", {"output": ["groupid", "name"]}, tok):
        if g["name"] == "ReadyJLMirror":
            gid = g["groupid"]
    if gid is None:
        gid = rpc("hostgroup.create", {"name": "ReadyJLMirror"},
                  tok)["groupids"][0]
    print("hostgroup:", gid)

    # Host bound to the compose agent
    hid = None
    for h in rpc("host.get", {"output": ["hostid", "host"]}, tok):
        if h["host"] == "zbx-agent-1":
            hid = h["hostid"]
    if hid is None:
        hid = rpc("host.create", {
            "host": "zbx-agent-1",
            "interfaces": [{
                "type": 1, "main": 1, "useip": 0, "dns": "zabbix-agent",
                "port": "10050", "ip": ""}],
            "groups": [{"groupid": gid}],
        }, tok)["hostids"][0]
    print("host:", hid)

    ifaces = rpc("hostinterface.get", {
        "output": ["interfaceid"], "hostids": [hid],
        "filter": {"main": 1, "type": 1}}, tok)
    iface_id = ifaces[0]["interfaceid"] if ifaces else None

    # Items (agent.ping + cpu load)
    items = rpc("item.get", {
        "output": ["itemid", "key_"], "hostids": [hid]}, tok)
    keys = {i["key_"] for i in items}
    if "agent.ping" not in keys:
        rpc("item.create", {
            "name": "agent ping", "key_": "agent.ping", "hostid": hid,
            "interfaceid": iface_id,
            "type": 0, "value_type": 3, "delay": "30s"}, tok)
    if "system.cpu.load[percpu,avg1]" not in keys:
        rpc("item.create", {
            "name": "cpu load avg1", "key_": "system.cpu.load[percpu,avg1]",
            "hostid": hid, "interfaceid": iface_id,
            "type": 0, "value_type": 0, "delay": "30s"}, tok)
    items = rpc("item.get", {
        "output": ["itemid", "key_"], "hostids": [hid]}, tok)
    print("items:", [i["key_"] for i in items])

    # Trigger so problem_state has real events to collect
    if not rpc("trigger.get", {
            "output": ["triggerid"], "hostids": [hid]}, tok):
        rpc("trigger.create", {
            "description": "zbx-agent-1 load high",
            "expression": "avg(/zbx-agent-1/system.cpu.load[percpu,avg1],1m)>0",
            "priority": 3}, tok)
        print("trigger: created")

    print("\nZabbix seeded. Source config:")
    print("  provider_base_url      = https://zabbix-web:8443")
    print("  credential_binding_ref = cred-binding-1")
    print(f"  host_group_refs        = ['{gid}']")
    print("  EGRESS_ALLOW_HOSTS=zabbix-web  EGRESS_ALLOW_PRIVATE_IPS=true")
    return 0


if __name__ == "__main__":
    sys.exit(main())
