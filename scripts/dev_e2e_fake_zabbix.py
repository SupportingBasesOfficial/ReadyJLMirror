"""Dev E2E — full monitoring pipeline against a fake Zabbix provider.

Exercises the real chain end to end on a live PostgreSQL:

    source create (API) -> validation -> inventory -> metric defs
    -> current state -> history -> problem state -> health -> outbox

`providers.zabbix._rpc` is patched with canned JSON-RPC responses, so
claim/fencing/credential/admission/normalization/projection/outbox all
run for real; only the transport itself is simulated (httpx is already
covered by unit tests).

Requires: PostgreSQL with migrations applied (DB_* env), plus
    ZABBIX_CRED_CRED_BINDING_1 (or secrets/cred-binding-1.token),
    EGRESS_ALLOW_HOSTS=zabbix.example.com,
    EGRESS_ALLOW_PRIVATE_IPS=true (fake host doesn't resolve — the
    DNS screen would deny it correctly for a real target)

Usage: python -m scripts.dev_e2e_fake_zabbix
"""

from __future__ import annotations

import logging
import time

import psycopg

from shared.config import settings

logger = logging.getLogger("dev_e2e")
logging.basicConfig(level=logging.INFO, format="%(levelname)s %(message)s")

from scripts.fake_zabbix import make_dev_server, rpc_client


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
    server = make_dev_server(api_token="dev-token")
    zb._rpc = rpc_client(server)  # noqa: SLF001 — dev E2E transport stub

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
