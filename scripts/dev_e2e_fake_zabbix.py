"""Dev E2E — full monitoring pipeline against a fake Zabbix provider.

Exercises the real chain end to end on a live PostgreSQL:

    source create (API) -> validation -> inventory -> metric defs
    -> current state -> history -> problem state -> health -> outbox

`providers.zabbix._rpc` is patched with canned JSON-RPC responses, so
claim/fencing/credential/admission/normalization/projection/outbox all
run for real; only the transport itself is simulated (httpx is already
covered by unit tests).

Requires: PostgreSQL with migrations applied (DB_* env), plus
    ZABBIX_CRED_CRED_BINDING_1, EGRESS_ALLOW_HOSTS=zabbix.example.com

Usage: python -m scripts.dev_e2e_fake_zabbix
"""

from __future__ import annotations

import logging
import time

import psycopg

from shared.config import settings

logger = logging.getLogger("dev_e2e")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

NOW = int(time.time())

# ---------------------------------------------------------------------------
# Canned Zabbix JSON-RPC responses
# ---------------------------------------------------------------------------

HOSTS = [
    {
        "hostid": "10101", "host": "web-01", "name": "Web Server 01",
        "interfaces": [{"interfaceid": "1", "type": "1", "main": "1",
                        "useip": "1", "ip": "10.0.0.11", "dns": "",
                        "port": "10050"}],
        "groups": [{"groupid": "5", "name": "Linux servers"}],
        "parentTemplates": [], "tags": [{"tag": "env", "value": "dev"}],
        "inventory": {"os": "Linux", "vendor": "ACME"},
    },
    {
        "hostid": "10202", "host": "db-01", "name": "Database 01",
        "interfaces": [{"interfaceid": "2", "type": "1", "main": "1",
                        "useip": "1", "ip": "10.0.0.12", "dns": "",
                        "port": "10050"}],
        "groups": [{"groupid": "5", "name": "Linux servers"}],
        "parentTemplates": [], "tags": [], "inventory": {},
    },
]

ITEMS = [
    {"itemid": "20101", "hostid": "10101", "name": "CPU load",
     "key_": "system.cpu.load", "units": "", "value_type": "0",
     "state": "0", "status": "0",
     "lastvalue": "0.42", "lastclock": str(NOW - 10), "lastns": "500000000"},
    {"itemid": "20102", "hostid": "10101", "name": "Memory used %",
     "key_": "vm.memory.util", "units": "%", "value_type": "0",
     "state": "0", "status": "0",
     "lastvalue": "71.5", "lastclock": str(NOW - 10), "lastns": "600000000"},
    {"itemid": "20201", "hostid": "10202", "name": "CPU load",
     "key_": "system.cpu.load", "units": "", "value_type": "0",
     "state": "0", "status": "0",
     "lastvalue": "1.87", "lastclock": str(NOW - 10), "lastns": "700000000"},
]

# One active problem on web-01's trigger 30001 (severity 3 = average).
PROBLEMS = [
    {"eventid": "90001", "objectid": "30001", "clock": str(NOW - 120),
     "name": "High CPU load on web-01", "severity": "3",
     "acknowledged": "0", "r_eventid": "0",
     "tags": [{"tag": "scope", "value": "perf"}]},
]

TRIGGERS = [
    {"triggerid": "30001", "hosts": [{"hostid": "10101"}]},
]


def fake_rpc(endpoint: str, method: str, params: dict, api_token: str):
    """Canned JSON-RPC responder keyed on method + params."""
    if method == "apiinfo.version":
        return "7.4.0"
    if method == "hostgroup.get":
        return [{"groupid": "5", "name": "Linux servers"}]
    if method == "host.get":
        return list(HOSTS)
    if method == "item.get":
        output = params.get("output") or []
        wanted = params.get("itemids")
        rows = [dict(i) for i in ITEMS
                if wanted is None or i["itemid"] in wanted]
        if "lastvalue" in output:
            return [{k: r[k] for k in ("itemid", "lastvalue",
                                       "lastclock", "lastns") if k in r}
                    for r in rows]
        return [{k: r[k] for k in output if k in r} for r in rows]
    if method == "history.get":
        rows = []
        frm, till = params["time_from"], params["time_till"]
        for itemid in params.get("itemids", []):
            for offset in (300, 240, 180):
                clock = frm + offset
                if frm <= clock <= till:
                    rows.append({"itemid": itemid, "clock": str(clock),
                                 "ns": "100000000", "value": "1.5"})
        return rows
    if method == "problem.get":
        if "eventids" in params:
            return []  # no recoveries
        return list(PROBLEMS)
    if method == "trigger.get":
        return list(TRIGGERS)
    raise RuntimeError(f"fake_rpc: unhandled method {method}")


# ---------------------------------------------------------------------------
# E2E driver
# ---------------------------------------------------------------------------


def _dump(conn, label, sql):
    cur = conn.execute(sql)
    rows = cur.fetchall()
    cols = [d.name for d in cur.description]
    print(f"\n== {label} ({len(rows)})")
    for r in rows:
        print("   ", dict(zip(cols, r)))


def main() -> None:
    import providers.zabbix as zb
    zb._rpc = fake_rpc  # noqa: SLF001 — dev E2E transport stub

    from fastapi.testclient import TestClient
    from api.main import app

    # 1. Source create via real API path
    with TestClient(app) as c:
        r = c.post(
            "/api/v1/monitoring/sources",
            params={"tenant_id": "tenant:dev"},
            json={
                "tenant_id": "tenant:dev",
                "display_name": "fake-zabbix-e2e",
                "provider_instance_ref": "zabbix-fake-1",
                "provider_base_url": "https://zabbix.example.com",
                "credential_binding_ref": "cred-binding-1",
                "host_group_refs": ["5"],
            },
        )
        body = r.json()
        print("source:", r.status_code, body)
        source_id = body["monitoring_source_id"]

        for name in ("inventory", "metrics/poll", "current/poll",
                     "history/poll"):
            ep = f"/api/v1/monitoring/sources/{source_id}/{name}"
            rr = c.post(ep, params={"tenant_id": "tenant:dev"})
            print("enqueue", name, "->", rr.status_code)

    # 2. Run all workers once against the live DB
    from workers.current_state import _process_pending as cur_w
    from workers.health import _process_pending as hea_w
    from workers.history import _process_pending as his_w
    from workers.inventory import _process_pending as inv_w
    from workers.metrics import _process_pending as met_w
    from workers.outbox_dispatcher import _publish_durable
    from workers.problem_state import _process_pending as prob_w
    from workers.validation import _process_pending as val_w

    with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
        for label, fn in (("validation", val_w), ("inventory", inv_w),
                          ("metrics", met_w), ("current", cur_w),
                          ("history", his_w)):
            print(f"worker {label:10s} ->", fn(conn))

    # problems/poll requires source evidence 'current' — enqueue only
    # after the validation/inventory chain has run.
    with TestClient(app) as c:
        rr = c.post(
            f"/api/v1/monitoring/sources/{source_id}/problems/poll",
            params={"tenant_id": "tenant:dev"})
        print("enqueue problems/poll ->", rr.status_code)

    with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
        print(f"worker problems   ->", prob_w(conn))
        print(f"worker health     ->", hea_w(conn))
        print("worker outbox     ->", _publish_durable(conn))

        _dump(conn, "ops",
              "SELECT responsibility_kind, state, last_error_class"
              " FROM monitoring.monitoring_sync_operation"
              " ORDER BY created_at")
        _dump(conn, "resources",
              "SELECT monitoring_resource_id, display_name, presence_state,"
              " scope_state FROM monitoring.monitoring_resource")
        _dump(conn, "definitions",
              "SELECT metric_definition_id, name, value_kind, scope_state"
              " FROM monitoring.metric_definition")
        _dump(conn, "current state",
              "SELECT metric_definition_id, canonical_value, evidence_state"
              " FROM monitoring.metric_current_state")
        _dump(conn, "history rows",
              "SELECT metric_definition_id, count(*)"
              " FROM monitoring.metric_observation GROUP BY 1")
        _dump(conn, "problems",
              "SELECT problem_id, problem_state, severity_class"
              " FROM monitoring.monitoring_problem")
        _dump(conn, "health",
              "SELECT monitoring_resource_id, health_class, evidence_state"
              " FROM monitoring.health_projection")
        _dump(conn, "outbox",
              "SELECT contract_name, dispatch_state, published_receipt_id"
              " FROM monitoring.monitoring_outbox ORDER BY record_id")


if __name__ == "__main__":
    main()
