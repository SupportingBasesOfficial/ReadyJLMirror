"""G10 ITSM incident — DB-level invariants through the canonical
SECURITY DEFINER boundary.

Exercises itsm.g10_* exactly the way api/routers/itsm.py and
workers/itsm_sync.py invoke them. Incident facts are immutable by
design, so fixtures resolve (never delete) their alerts.
"""

from __future__ import annotations

import os
import secrets

import psycopg
import pytest
from psycopg.types.json import Jsonb

from tests.test_alerting import _conn, _make_policy  # noqa: F401
from tests.test_alerting import REAL_SOURCE

TENANT = "tenant:dev"
ACTOR = "principal.test-actor"


@pytest.fixture
def g10fx():
    """fx-equivalent monitoring/alert setup, but the teardown never
    deletes alerting rows — itsm incident facts are immutable and
    FK-pin the alert, so we resolve/disable instead."""
    src = f"mon-src_g10test_{secrets.token_hex(4)}"
    pid = f"prob_{secrets.token_hex(4)}"
    rid = f"res_{secrets.token_hex(4)}"
    pol = f"pol-g10-{secrets.token_hex(4)}"
    with _conn() as conn:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id',%s,false)",
            (TENANT,))
        cur = conn.execute(
            "UPDATE alerting.alert_policy_effective_version"
            "   SET enabled = FALSE"
            " WHERE tenant_id=%s AND enabled RETURNING policy_id",
            (TENANT,))
        suspended = [r[0] for r in cur.fetchall()]
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_source_generation
                (tenant_id, monitoring_source_id,
                 source_instance_generation, provider_profile,
                 provider_instance_ref, provider_base_url)
            SELECT %s, %s, source_instance_generation,
                   provider_profile, provider_instance_ref,
                   provider_base_url
              FROM monitoring.monitoring_source_generation
             WHERE monitoring_source_id = %s LIMIT 1
            """, (TENANT, src, REAL_SOURCE))
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_source
                (tenant_id, monitoring_source_id,
                 provider_scope_tenant_binding_id, provider_profile,
                 active_source_instance_generation,
                 configuration_revision, scope_revision, display_name,
                 credential_binding_ref, configured_provider_scope,
                 operational_evidence_state, last_sync_operation_id,
                 item_definition_poll_epoch,
                 item_definition_poll_generation,
                 current_state_poll_epoch, current_state_poll_generation,
                 problem_poll_epoch, problem_poll_generation)
            SELECT %s, %s, %s || '_bnd', provider_profile,
                   active_source_instance_generation,
                   configuration_revision, scope_revision, 'g10-test',
                   credential_binding_ref, configured_provider_scope,
                   'current', last_sync_operation_id,
                   item_definition_poll_epoch,
                   item_definition_poll_generation,
                   current_state_poll_epoch, current_state_poll_generation,
                   problem_poll_epoch, problem_poll_generation
              FROM monitoring.monitoring_source
             WHERE monitoring_source_id = %s
            """, (TENANT, src, src, REAL_SOURCE))
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_resource
                (tenant_id, monitoring_resource_id,
                 monitoring_source_id, source_instance_generation,
                 resource_kind, provider_object_kind,
                 provider_external_ref, display_name, scope_state,
                 scope_projection_revision, scope_evidence_state,
                 presence_state, presence_evidence_state,
                 last_observed_at, last_confirmed_present_at)
            SELECT %s, %s, %s, g.source_instance_generation,
                   r.resource_kind, r.provider_object_kind,
                   'ext-' || %s, 'g10-test-res', r.scope_state,
                   r.scope_projection_revision, r.scope_evidence_state,
                   r.presence_state, r.presence_evidence_state,
                   now(), now()
              FROM monitoring.monitoring_resource r
              JOIN monitoring.monitoring_source_generation g
                ON g.monitoring_source_id = %s
              LIMIT 1
            """, (TENANT, rid, src, rid, src))
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_problem_provider_binding
                (tenant_id, problem_id, monitoring_source_id,
                 source_instance_generation, monitoring_resource_id,
                 provider_profile, provider_external_ref,
                 provider_trigger_ref)
            SELECT %s, %s, %s, active_source_instance_generation,
                   %s, 'zabbix', 'ext-' || %s, 'trg-' || %s
              FROM monitoring.monitoring_source
             WHERE monitoring_source_id = %s
            """, (TENANT, pid, src, rid, pid, pid, src))
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_problem
                (tenant_id, problem_id, monitoring_source_id,
                 source_instance_generation, monitoring_resource_id,
                 problem_state, severity_class, summary, opened_at,
                 last_confirmed_at, evidence_state,
                 projection_revision, problem_poll_epoch,
                 problem_poll_generation)
            SELECT %s, %s, %s, active_source_instance_generation,
                   %s, 'active', 'critical', 'g10 test problem',
                   now(), now(), 'current', 7, 1, 1
              FROM monitoring.monitoring_source
             WHERE monitoring_source_id = %s
            """, (TENANT, pid, src, rid, src))
        conn.commit()
        yield {"source": src, "problem": pid, "policy": pol,
               "resource": rid, "conn": conn}
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id',%s,false)",
            (TENANT,))
        # alerts pinned by incidents can never be deleted —
        # resolve + disable so leftovers stay inert.
        conn.execute(
            "UPDATE alerting.alert SET lifecycle_state='resolved',"
            " resolved_at=now() WHERE tenant_id=%s AND policy_id=%s",
            (TENANT, pol))
        conn.execute(
            "UPDATE alerting.alert_policy_effective_version"
            "   SET enabled=FALSE"
            " WHERE tenant_id=%s AND policy_id=%s", (TENANT, pol))
        for policy_id in suspended:
            conn.execute(
                "UPDATE alerting.alert_policy_effective_version"
                "   SET enabled = TRUE"
                " WHERE tenant_id=%s AND policy_id=%s",
                (TENANT, policy_id))
        conn.commit()


def _snapshot(tenant: str = TENANT, actor: str = ACTOR,
              action: str = "alerting:operate",
              current: bool = True) -> Jsonb:
    return Jsonb({"tenant_id": tenant, "principal_id": actor,
                  "current": current, "action": action,
                  "policy_revision": "g10.itsm-incident@1"})


def _mk_alert(f) -> str:
    """Create a real active alert through G7 evaluation — the only
    legal FK target for g10_create_incident."""
    from shared import alerting_eval
    conn = f["conn"]
    _make_policy(conn, f["policy"])
    alerting_eval.evaluate_problem_policies(
        conn, tenant_id=TENANT, monitoring_source_id=f["source"])
    conn.commit()
    cur = conn.execute(
        "SELECT alert_id FROM alerting.alert "
        "WHERE tenant_id=%s AND policy_id=%s",
        (TENANT, f["policy"]))
    return cur.fetchone()[0]


def _create(conn, alert_id: str, la: str | None = None,
            title: str = "test incident",
            snapshot: Jsonb | None = None) -> dict:
    cur = conn.execute(
        "SELECT itsm.g10_create_incident(%s,%s,%s,%s,%s,%s,%s)",
        (TENANT, alert_id, title, "desc", ACTOR,
         la or f"la_{secrets.token_hex(8)}",
         snapshot or _snapshot()))
    return cur.fetchone()[0]


def _g10(conn, fn: str, params: tuple):
    cur = conn.execute(
        f"SELECT itsm.{fn}(" + ",".join(["%s"] * len(params)) + ")",
        params)
    row = cur.fetchone()
    return row[0] if row else None


def _err(fn) -> str:
    with pytest.raises(psycopg.errors.RaiseException) as e:
        fn()
    return str(e.value)


@pytest.fixture
def incident(g10fx):
    alert_id = _mk_alert(g10fx)
    yield {"conn": g10fx["conn"], "alert": alert_id, "fx": g10fx}


def test_create_requires_active_alert(incident):
    conn = incident["conn"]
    alert_id = incident["alert"]
    res = _create(conn, alert_id)
    assert res["duplicate"] is False
    assert res["incident_id"].startswith("g10-incident:")
    conn.commit()

    # missing alert -> refused
    assert "g10.active_alert_required" in _err(
        lambda: _create(conn, "alert_bogus"))
    conn.rollback()

    # resolved alert -> refused (incident creation needs an
    # admitted, currently-active alert)
    conn.execute(
        "UPDATE alerting.alert SET lifecycle_state='resolved',"
        " resolved_at=now() WHERE alert_id=%s", (alert_id,))
    conn.commit()
    assert "g10.active_alert_required" in _err(
        lambda: _create(conn, alert_id))
    conn.rollback()


def test_create_idempotent_replay_and_equivalence(incident):
    conn = incident["conn"]
    la = f"la_{secrets.token_hex(8)}"
    first = _create(conn, incident["alert"], la=la, title="t1")
    replay = _create(conn, incident["alert"], la=la, title="t1")
    conn.commit()
    assert replay["duplicate"] is True
    assert replay["incident_id"] == first["incident_id"]
    # same logical action, different content -> equivalence conflict
    assert "g10.incident_equivalence_conflict" in _err(
        lambda: _create(conn, incident["alert"], la=la, title="t2"))
    conn.rollback()


def test_lifecycle_rules_and_replay(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()
    la = f"la_{secrets.token_hex(8)}"

    def tr(target, la_id=None):
        return _g10(conn, "g10_transition_incident",
                    (TENANT, inc, target, ACTOR,
                     la_id or f"la_{secrets.token_hex(8)}",
                     _snapshot()))

    # illegal: open -> closed
    assert "g10.transition_not_authorized" in _err(
        lambda: tr("closed"))
    conn.rollback()

    assert tr("in_progress", la)["state"] == "in_progress"
    # replay same logical action -> recorded effect, no new row
    dup = tr("in_progress", la)
    assert dup["duplicate"] is True
    conn.commit()
    # same action, different target -> conflict
    assert "g10.transition_equivalence_conflict" in _err(
        lambda: tr("resolved", la))
    conn.rollback()

    # illegal: in_progress -> closed
    assert "g10.transition_not_authorized" in _err(
        lambda: tr("closed"))
    conn.rollback()

    assert tr("resolved")["state"] == "resolved"
    assert tr("closed")["state"] == "closed"
    conn.commit()
    # closed is terminal — no reopen in v1
    assert "g10.transition_not_authorized" in _err(
        lambda: tr("open"))
    conn.rollback()

    cur = conn.execute(
        "SELECT from_state,to_state FROM itsm.incident_transition "
        "WHERE incident_id=%s ORDER BY occurred_at", (inc,))
    assert [tuple(r) for r in cur.fetchall()] == [
        ("open", "in_progress"), ("in_progress", "resolved"),
        ("resolved", "closed")]


def test_assignment_history_single_current(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()

    def assign(assignee, la_id=None):
        return _g10(conn, "g10_assign_incident",
                    (TENANT, inc, assignee, ACTOR,
                     la_id or f"la_{secrets.token_hex(8)}",
                     _snapshot()))

    la = f"la_{secrets.token_hex(8)}"
    assign("principal.a", la)
    dup = assign("principal.a", la)
    assert dup["duplicate"] is True
    conn.commit()
    assert "g10.assignment_equivalence_conflict" in _err(
        lambda: assign("principal.b", la))
    conn.rollback()

    assign("principal.b")
    conn.commit()
    cur = conn.execute(
        "SELECT assignee_principal_id, effective_until IS NULL "
        "FROM itsm.incident_assignment WHERE incident_id=%s "
        "ORDER BY effective_from", (inc,))
    rows = cur.fetchall()
    assert rows == [("principal.a", False), ("principal.b", True)]


def test_comment_immutable_and_idempotent(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    la = f"la_{secrets.token_hex(8)}"
    _g10(conn, "g10_add_comment",
         (TENANT, inc, "note", ACTOR, la, _snapshot()))
    dup = _g10(conn, "g10_add_comment",
               (TENANT, inc, "note", ACTOR, la, _snapshot()))
    assert dup["duplicate"] is True
    conn.commit()
    assert "g10.comment_equivalence_conflict" in _err(
        lambda: _g10(conn, "g10_add_comment",
                     (TENANT, inc, "other", ACTOR, la, _snapshot())))
    conn.rollback()
    # immutable fact — direct mutation rejected even for owner
    assert "g10.immutable_fact" in _err(
        lambda: conn.execute(
            "UPDATE itsm.incident_comment SET body='x' "
            "WHERE incident_id=%s", (inc,)))
    conn.rollback()
    assert "g10.immutable_fact" in _err(
        lambda: conn.execute(
            "DELETE FROM itsm.incident_comment WHERE incident_id=%s",
            (inc,)))
    conn.rollback()


def test_authority_snapshot_required(incident):
    conn = incident["conn"]
    alert = incident["alert"]
    for bad in (
        _snapshot(current=False),
        _snapshot(tenant="tenant:other"),
        _snapshot(actor="principal.other"),
        _snapshot(action=""),
        Jsonb({"tenant_id": TENANT, "principal_id": ACTOR,
               "current": True, "action": "a",
               "policy_revision": ""}),
    ):
        assert "g10.current_authority_required" in _err(
            lambda b=bad: _create(conn, alert, snapshot=b))
        conn.rollback()


def test_tenant_isolation(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()
    assert "g10.incident_missing" in _err(
        lambda: _g10(conn, "g10_get_incident",
                     ("tenant:other", inc)))
    conn.rollback()


def test_get_incident_shape(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()
    res = _g10(conn, "g10_get_incident", (TENANT, inc))
    for k in ("incident_id", "alert_id", "lifecycle_state",
              "transitions", "assignments", "comments",
              "provider_sync", "alert_summary"):
        assert k in res
    assert res["provider_sync"]["sync_state"] in (
        "pending", "dispatching", "linked")
    assert res["alert_summary"]["alert_id"] == incident["alert"]


def _our_pending_outbox(conn, inc: str) -> str:
    cur = conn.execute(
        "SELECT sync_outbox_id FROM itsm.incident_sync_outbox "
        "WHERE incident_id=%s AND sync_state='pending' "
        "ORDER BY attempt_number", (inc,))
    row = cur.fetchone()
    return row[0] if row else None


def _sync_identity(conn, inc) -> tuple:
    """Claim OUR incident's pending outbox row through the canonical
    claim function. The live worker races us — skip if it won."""
    outbox_id = _our_pending_outbox(conn, inc)
    if outbox_id is None:
        conn.rollback()
        pytest.skip("live worker already claimed the sync outbox")
    executor = f"test-exec-{secrets.token_hex(4)}"
    claim = _g10(conn, "g10_claim_sync",
                 (TENANT, outbox_id, executor, 60))
    if claim["state"] != "dispatching":
        conn.rollback()
        pytest.skip("live worker raced the claim")
    return {"sync_outbox_id": outbox_id}, executor, claim


def test_sync_claim_complete_linked(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()
    cand, executor, claim = _sync_identity(conn, inc)
    assert claim["state"] == "dispatching"
    ticket = f"ticket-{secrets.token_hex(6)}"
    res = _g10(conn, "g10_complete_sync",
               (TENANT, cand["sync_outbox_id"], executor, "linked",
                ticket, Jsonb({"provider_status": "2xx"}),
                None))
    assert res["state"] == "linked"
    conn.commit()
    cur = conn.execute(
        "SELECT provider_ticket_ref, adapter_instance_ref "
        "FROM itsm.incident_provider_link WHERE incident_id=%s",
        (inc,))
    assert cur.fetchone() == (ticket, "fixture-neutral@1")
    # provider already linked -> no further retries
    res = _g10(conn, "g10_schedule_sync_retry", (TENANT, inc))
    assert res["reason"] == "provider_already_linked"


def test_sync_complete_requires_live_claim(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()
    cand, executor, _ = _sync_identity(conn, inc)
    # wrong executor -> claim lost
    assert "g10.sync_claim_lost" in _err(
        lambda: _g10(conn, "g10_complete_sync",
                     (TENANT, cand["sync_outbox_id"], "other-exec",
                      "linked", "t", Jsonb({}), None)))
    conn.rollback()


def test_expired_claim_reconciles_to_unknown(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()
    cand, executor, claim = _sync_identity(conn, inc)
    assert claim["state"] == "dispatching"
    # force the lease into the past (owner override — simulates a
    # crashed worker whose claim expired)
    conn.execute(
        "UPDATE itsm.incident_sync_outbox SET claim_expires_at="
        "now()-interval '1s' WHERE sync_outbox_id=%s",
        (cand["sync_outbox_id"],))
    conn.commit()
    # expired claim -> reconciliation_required
    claim2 = _g10(conn, "g10_claim_sync",
                  (TENANT, cand["sync_outbox_id"], "exec2", 60))
    assert claim2["state"] == "reconciliation_required"
    _g10(conn, "g10_reconcile_sync",
         (TENANT, cand["sync_outbox_id"]))
    conn.commit()
    cur = conn.execute(
        "SELECT sync_state FROM itsm.incident_sync_outbox "
        "WHERE sync_outbox_id=%s", (cand["sync_outbox_id"],))
    assert cur.fetchone()[0] == "unknown"
    # bounded retry scheduled
    retry = _g10(conn, "g10_schedule_sync_retry", (TENANT, inc))
    assert retry["scheduled"] is True
    assert retry["attempt_number"] == 2
    conn.commit()


def test_retry_budget_exhausted(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()
    for attempt in (1, 2, 3):
        outbox_id = _our_pending_outbox(conn, inc)
        if outbox_id is None:
            conn.rollback()
            pytest.skip("live worker claimed the sync outbox")
        ex = f"exec-{attempt}"
        _g10(conn, "g10_claim_sync", (TENANT, outbox_id, ex, 60))
        _g10(conn, "g10_complete_sync",
             (TENANT, outbox_id, ex, "failed",
              None, Jsonb({}), "provider_5xx"))
        conn.commit()
        retry = _g10(conn, "g10_schedule_sync_retry", (TENANT, inc))
        if attempt < 3:
            assert retry["scheduled"] is True
            # jump the backoff for the test
            conn.execute(
                "UPDATE itsm.incident_sync_outbox SET available_at="
                "now()-interval '1s' WHERE incident_id=%s AND "
                "sync_state='pending'", (inc,))
            conn.commit()
        else:
            assert retry["reason"] == "retry_budget_exhausted"


def test_least_privilege_boundaries():
    """jlmirror_app/worker hold zero itsm.* table privilege and only
    the EXECUTE grant matching their invoker role."""
    def role_conn(user):
        return psycopg.connect(
            host=os.environ.get("DB_HOST", "localhost"),
            port=int(os.environ.get("DB_PORT", "5434")),
            dbname=os.environ.get("DB_NAME", "jlmirror"),
            user=user, password=os.environ.get(
                "DB_PASSWORD", "jlmirror_dev"),
            autocommit=True)

    app = role_conn("jlmirror_app")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        app.execute("SELECT count(*) FROM itsm.incident")
    # app invoker cannot reach worker-only functions
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        app.execute("SELECT itsm.g10_next_sync_candidate('tenant:dev')")
    app.close()

    worker = role_conn("jlmirror_worker")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        worker.execute("SELECT count(*) FROM itsm.incident")
    with pytest.raises(psycopg.errors.InsufficientPrivilege):
        worker.execute(
            "SELECT itsm.g10_create_incident('t','a','t','d','p','l',"
            "'{}'::jsonb)")
    # worker CAN reach the narrow sync capability
    worker.execute("SELECT itsm.g10_next_sync_candidate('tenant:dev')")
    worker.close()


def test_provider_link_immutable(incident):
    conn = incident["conn"]
    inc = _create(conn, incident["alert"])["incident_id"]
    conn.commit()
    cand, executor, _ = _sync_identity(conn, inc)
    _g10(conn, "g10_complete_sync",
         (TENANT, cand["sync_outbox_id"], executor, "linked",
          f"ticket-{secrets.token_hex(6)}", Jsonb({}), None))
    conn.commit()
    assert "g10.immutable_fact" in _err(
        lambda: conn.execute(
            "DELETE FROM itsm.incident_provider_link "
            "WHERE incident_id=%s", (inc,)))
    conn.rollback()
