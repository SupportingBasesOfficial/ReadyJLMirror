"""Canonical contract conformance + full-journey E2E.

Drives a real monitoring source through the entire pipeline against
the fake Zabbix provider (real claim/fence/credential/egress/
normalization/projection code; only the transport is simulated) and
validates every contract-facing response against the vendored JSON
schemas in vendor/ProjectJLMirror/contracts.

Journey: create source (contract shape) -> validation -> inventory ->
metric definitions -> current -> history -> problems -> health ->
outbox publish -> inbox reread -> alert evaluation -> human ops ->
notification intent -> contract-conformant reads.

Requires a live PostgreSQL with migrations applied (DB_* env, same
convention as the other integration tests).
"""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path

import psycopg
import pytest
from jsonschema import Draft202012Validator

CONTRACTS = (Path(__file__).resolve().parent.parent
             / "vendor" / "ProjectJLMirror" / "contracts")
TENANT = "tenant:test"


def _schema(*parts: str):
    return json.loads(CONTRACTS.joinpath(*parts).read_text())


def _check(payload, *parts: str) -> None:
    Draft202012Validator(_schema(*parts)).validate(payload)


def _conn():
    # Owner role — the worker path bypasses RLS; the app role
    # (jlmirror_app, used by the API pool) sees zero rows here.
    return psycopg.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5434")),
        dbname=os.environ.get("DB_NAME", "jlmirror"),
        user="jlmirror_owner",
        password="jlmirror_dev",
        autocommit=False)


def _db_reachable() -> bool:
    try:
        with _conn() as c:
            c.execute("SELECT 1")
        return True
    except Exception:
        return False


pytestmark = pytest.mark.skipif(
    not _db_reachable(), reason="requires live PostgreSQL")


@pytest.fixture(scope="module")
def journey():
    """Drive the full pipeline once; yield {client, source_id, ids}."""
    os.environ["ZABBIX_CRED_CRED_E2E_1"] = "dev-token"
    os.environ["EGRESS_ALLOW_HOSTS"] = "zabbix.example.com"
    os.environ["EGRESS_ALLOW_PRIVATE_IPS"] = "true"

    import providers.zabbix as zb
    from scripts.fake_zabbix import make_dev_server, rpc_client

    server = make_dev_server(api_token="dev-token")
    original_rpc = zb._rpc
    zb._rpc = rpc_client(server)  # noqa: SLF001 — e2e transport stub

    from fastapi.testclient import TestClient
    from api.main import app

    ctx: dict = {}
    try:
        with TestClient(app) as client:
            ctx["client"] = client
            # G2 create-source — canonical contract request shape.
            r = client.post(
                "/api/v1/monitoring/sources",
                params={"tenant_id": TENANT},
                json={
                    # Canonical g2 create-source shape; tenant_id is the
                    # dev-sandbox seam (BFF context supplies it in prod).
                    "tenant_id": TENANT,
                    "provider_profile": "zabbix",
                    "display_name": f"e2e-conformance-{secrets.token_hex(3)}",
                    "provider_configuration": {
                        "base_url": "https://zabbix.example.com"},
                    "credential_binding_ref": "cred-e2e-1",
                    "configured_provider_scope": {
                        "host_group_refs": ["5"]},
                    "idempotency_key": f"e2e-{secrets.token_hex(8)}",
                })
            assert r.status_code == 201, r.text
            source_id = r.json()["monitoring_source_id"]
            ctx["source_id"] = source_id

            def _run(label):
                import workers.current_state as w_cur
                import workers.health as w_hea
                import workers.history as w_his
                import workers.inventory as w_inv
                import workers.metrics as w_met
                import workers.problem_state as w_prb
                import workers.validation as w_val
                fns = {
                    "validation": w_val._process_pending,
                    "inventory": w_inv._process_pending,
                    "metrics": w_met._process_pending,
                    "current": w_cur._process_pending,
                    "history": w_his._process_pending,
                    "problems": w_prb._process_pending,
                    "health": w_hea._process_pending,
                }
                with _conn() as conn:
                    return fns[label](conn)

            def _enqueue(kind):
                ep = (f"/api/v1/monitoring/sources/{source_id}/{kind}")
                rr = client.post(ep, params={"tenant_id": TENANT})
                assert rr.status_code in (200, 202), rr.text

            _run("validation")
            for kind in ("inventory", "metrics/poll", "current/poll",
                         "history/poll"):
                _enqueue(kind)
            for label in ("inventory", "metrics", "current", "history"):
                _run(label)

            # G7 policy must exist before problem eval fires.
            pr = client.post(
                "/api/v1/alerting/policies",
                params={"tenant_id": TENANT},
                json={
                    "policy_id": "pol-e2e",
                    "source_kind": "monitoring_problem",
                    "problem_min_severity": "warning",
                    "make_effective": True,
                })
            assert pr.status_code == 201, pr.text

            _enqueue("problems/poll")
            _run("problems")
            _run("health")

            from workers.outbox_dispatcher import _publish_durable
            import workers.alerting_transport as w_trn
            with _conn() as conn:
                ctx["published"] = _publish_durable(conn)
                ctx["inbox_processed"] = w_trn._process_pending(conn)

            with _conn() as conn:
                cur = conn.execute(
                    "SELECT alert_id FROM alerting.alert "
                    "WHERE tenant_id=%s ORDER BY opened_at DESC LIMIT 1",
                    (TENANT,))
                row = cur.fetchone()
                ctx["alert_id"] = row[0] if row else None
            ctx["server"] = server
            ctx["run"] = _run
            ctx["enqueue"] = _enqueue
            yield ctx
    finally:
        zb._rpc = original_rpc


def _get(ctx, path):
    r = ctx["client"].get(
        f"/api/v1/monitoring{path}", params={"tenant_id": TENANT})
    assert r.status_code == 200, r.text
    return r.json()


# ---------------------------------------------------------------------------
# Journey assertions — the pipeline actually moved data
# ---------------------------------------------------------------------------


def test_journey_pipeline_completed(journey):
    """The full worker chain produced canonical state."""
    sid = journey["source_id"]
    with _conn() as conn:
        def scalar(sql, *p):
            return conn.execute(sql, p).fetchone()[0]
        assert scalar(
            "SELECT count(*) FROM monitoring.monitoring_resource "
            "WHERE tenant_id=%s AND monitoring_source_id=%s",
            TENANT, sid) == 2
        assert scalar(
            "SELECT count(*) FROM monitoring.metric_definition "
            "WHERE tenant_id=%s AND monitoring_source_id=%s",
            TENANT, sid) == 3
        assert scalar(
            "SELECT count(*) FROM monitoring.metric_current_state "
            "WHERE tenant_id=%s AND monitoring_source_id=%s",
            TENANT, sid) == 3
        assert scalar(
            "SELECT count(*) FROM monitoring.metric_observation "
            "WHERE tenant_id=%s AND monitoring_source_id=%s",
            TENANT, sid) >= 9
        assert scalar(
            "SELECT count(*) FROM monitoring.monitoring_problem "
            "WHERE tenant_id=%s AND monitoring_source_id=%s",
            TENANT, sid) >= 1
        assert scalar(
            "SELECT count(*) FROM monitoring.health_projection "
            "WHERE tenant_id=%s AND monitoring_source_id=%s",
            TENANT, sid) == 2
        assert scalar(
            "SELECT count(*) FROM monitoring.monitoring_outbox "
            "WHERE tenant_id=%s AND dispatch_state='published'",
            TENANT) >= 1
    # Note: the durable published rows above are the assertion — the
    # in-process _publish_durable call may return 0 when the dev
    # container's dispatcher wins the claim race.
    assert journey["alert_id"], "alert evaluation produced an alert"


# ---------------------------------------------------------------------------
# Contract-conformant reads — each response validated against the
# vendored schema (strict: additionalProperties=false enforced)
# ---------------------------------------------------------------------------


def test_onboarding_view_contract(journey):
    body = _get(journey, f"/sources/{journey['source_id']}/onboarding")
    _check(body, "g2-monitoring-source-onboarding",
           "onboarding-view.schema.json")
    assert body["state"] == "current"
    assert body["provider_connection_confirmed"] is True


def test_resource_list_contract(journey):
    body = _get(journey, f"/sources/{journey['source_id']}/resources")
    _check(body, "g3-resource-inventory", "resource-list.schema.json")
    assert len(body["items"]) == 2
    assert body["next_cursor"] is None


def test_resource_list_cursor_pagination(journey):
    first = _get(journey,
                 f"/sources/{journey['source_id']}/resources?limit=1")
    assert len(first["items"]) == 1 and first["next_cursor"]
    second = _get(
        journey, f"/sources/{journey['source_id']}/resources?limit=1"
                 f"&cursor={first['next_cursor']}")
    _check(second, "g3-resource-inventory", "resource-list.schema.json")
    assert second["items"][0]["monitoring_resource_id"] != \
        first["items"][0]["monitoring_resource_id"]
    assert second["next_cursor"] is None


def test_metric_definitions_contract(journey):
    body = _get(journey, f"/sources/{journey['source_id']}/metrics")
    _check(body, "g4-metrics", "metric-definitions.schema.json")
    assert len(body["items"]) == 3


def test_metric_current_contract(journey):
    body = _get(journey, f"/sources/{journey['source_id']}/current")
    _check(body, "g4-metrics", "metric-current.schema.json")
    assert len(body["items"]) == 3
    journey["definition_id"] = body["items"][0]["metric_definition_id"]


def test_metric_history_contract(journey):
    def_id = journey.get("definition_id")
    if not def_id:
        cur = _get(journey,
                   f"/sources/{journey['source_id']}/current?limit=1")
        def_id = cur["items"][0]["metric_definition_id"]
    body = _get(
        journey,
        f"/sources/{journey['source_id']}/metrics/{def_id}/history")
    _check(body, "g4-metrics", "metric-history.schema.json")
    assert len(body["items"]) >= 3
    assert body["completeness"]["state"] in (
        "complete", "incomplete", "gap_detected",
        "reconciliation_required")


def test_problems_contract(journey):
    body = _get(journey, f"/sources/{journey['source_id']}/problems")
    _check(body, "g5-problem-health", "problems.schema.json")
    assert len(body["items"]) >= 1
    item = body["items"][0]
    assert item["problem_state"] == "active"
    assert len(item["monitoring_resource_ids"]) >= 1


def test_health_contract(journey):
    body = _get(journey, f"/sources/{journey['source_id']}/health")
    _check(body, "g5-problem-health", "health.schema.json")
    assert len(body["items"]) == 2


def test_g6_wire_envelope_contract(journey):
    """The published outbox message validates against the canonical
    integration envelope schema — the exact object put on the wire."""
    from workers.outbox_dispatcher import wire_envelope
    with _conn() as conn:
        cur = conn.execute(
            """
            SELECT record_id, tenant_id, message_id,
                   producer_message_scope, message_class, contract_name,
                   contract_version, producer, scope, subject_type,
                   subject_id, occurred_at, correlation_id,
                   causation_id, data_classification,
                   serialization_profile_id, encoded_payload,
                   attempt_count
              FROM monitoring.monitoring_outbox
             WHERE tenant_id = %s AND dispatch_state = 'published'
               AND contract_name IN ('monitoring.problem-state.changed',
                   'monitoring.health-projection.changed')
             ORDER BY record_id DESC LIMIT 1
            """, (TENANT,))
        row = cur.fetchone()
    assert row, "no published monitoring event found"
    keys = ("record_id", "tenant_id", "message_id",
            "producer_message_scope", "message_class", "contract_name",
            "contract_version", "producer", "scope", "subject_type",
            "subject_id", "occurred_at", "correlation_id",
            "causation_id", "data_classification",
            "serialization_profile_id", "encoded_payload",
            "attempt_count")
    envelope = wire_envelope(dict(zip(keys, row)))
    _check(envelope, "g6-monitoring-alerting-transport",
           "envelope.schema.json")


# ---------------------------------------------------------------------------
# Journey — human operations + notification intent (g8/g9)
# ---------------------------------------------------------------------------


def test_journey_assign_and_ack(journey):
    alert_id = journey["alert_id"]
    r = journey["client"].post(
        f"/api/v1/alerting/alerts/{alert_id}/assign",
        params={"tenant_id": TENANT},
        json={"owner_principal_id": "dev-test-user",
              "action_kind": "investigate_alert",
              "logical_action_id": f"e2e-act-{secrets.token_hex(4)}"})
    assert r.status_code == 201, r.text
    r = journey["client"].post(
        f"/api/v1/alerting/alerts/{alert_id}/ack",
        params={"tenant_id": TENANT}, json={"note": "e2e"})
    assert r.status_code == 201, r.text


def test_journey_notification_intent(journey):
    r = journey["client"].post(
        f"/api/v1/alerting/alerts/{journey['alert_id']}/notifications",
        params={"tenant_id": TENANT},
        json={"destination_ref": "+5511999999999",
              "reason": "alert_requires_attention"})
    assert r.status_code == 201, r.text
    body = r.json()
    assert body["notification_intent_id"].startswith("nti_")


def test_journey_problem_resolves_when_provider_clears(journey):
    """Provider recovery propagates end to end: the provider stops
    reporting the problem -> next sync resolves the canonical problem
    -> evaluation resolves the alert. The same path that opened it."""
    server = journey["server"]
    server.problems = []          # provider no longer reports it
    journey["enqueue"]("problems/poll")
    journey["run"]("problems")
    sid = journey["source_id"]
    with _conn() as conn:
        resolved = conn.execute(
            "SELECT count(*) FROM monitoring.monitoring_problem "
            "WHERE tenant_id=%s AND monitoring_source_id=%s "
            "AND problem_state='resolved'",
            (TENANT, sid)).fetchone()[0]
        alert_state = conn.execute(
            "SELECT lifecycle_state FROM alerting.alert "
            "WHERE tenant_id=%s AND alert_id=%s",
            (TENANT, journey["alert_id"])).fetchone()[0]
    assert resolved >= 1
    assert alert_state == "resolved"
