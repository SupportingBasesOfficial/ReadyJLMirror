"""G7 alert policy lifecycle tests — self-contained fixtures."""

from __future__ import annotations

import os
import secrets

import psycopg
import pytest

REAL_SOURCE = "mon-src_qLB_niwOVKN6d8sLedEdlfb2vd6_eJz-"


def _conn():
    return psycopg.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5434")),
        dbname=os.environ.get("DB_NAME", "jlmirror"),
        user=os.environ.get("DB_USER", "jlmirror_owner"),
        password=os.environ.get("DB_PASSWORD", "jlmirror_dev"),
        autocommit=False)


@pytest.fixture
def fx():
    src = f"mon-src_g7test_{secrets.token_hex(4)}"
    pid = f"prob_{secrets.token_hex(4)}"
    rid = f"res_{secrets.token_hex(4)}"
    pol = f"pol-g7-{secrets.token_hex(4)}"
    with _conn() as conn:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:dev',false)")
        # Isolate: wipe ALL tenant alerting state — evaluation runs
        # over every enabled policy of the tenant, so live/demo
        # policies would otherwise count.
        for t in ("notification.notification_dispatch_outbox",
                  "notification.notification_provider_evidence",
                  "notification.notification_attempt",
                  "notification.notification_callback_inbox",
                  "notification.notification_projection",
                  "notification.notification_intent",
                  "human_operations.alert_action_assignment",
                  "human_operations.alert_acknowledgement",
                  "human_operations.visibility_receipt",
                  "human_operations.visibility_requirement",
                  "human_operations.current_action_projection",
                  "alerting.alert_decision", "alerting.alert_transition",
                  "alerting.alert",
                  "alerting.alert_policy_effective_version",
                  "alerting.alert_policy_version",
                  "alerting.alert_policy"):
            conn.execute(f"DELETE FROM {t} WHERE tenant_id='tenant:dev'")
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_source_generation
                (tenant_id, monitoring_source_id,
                 source_instance_generation, provider_profile,
                 provider_instance_ref, provider_base_url)
            SELECT 'tenant:dev', %s, source_instance_generation,
                   provider_profile, provider_instance_ref,
                   provider_base_url
              FROM monitoring.monitoring_source_generation
             WHERE monitoring_source_id = %s LIMIT 1
            """, (src, REAL_SOURCE))
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
            SELECT 'tenant:dev', %s, %s || '_bnd', provider_profile,
                   active_source_instance_generation,
                   configuration_revision, scope_revision, 'g7-test',
                   credential_binding_ref, configured_provider_scope,
                   'current', last_sync_operation_id,
                   item_definition_poll_epoch,
                   item_definition_poll_generation,
                   current_state_poll_epoch, current_state_poll_generation,
                   problem_poll_epoch, problem_poll_generation
              FROM monitoring.monitoring_source
             WHERE monitoring_source_id = %s
            """, (src, src, REAL_SOURCE))
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
            SELECT 'tenant:dev', %s, %s, g.source_instance_generation,
                   r.resource_kind, r.provider_object_kind,
                   'ext-' || %s, 'g7-test-res', r.scope_state,
                   r.scope_projection_revision, r.scope_evidence_state,
                   r.presence_state, r.presence_evidence_state,
                   now(), now()
              FROM monitoring.monitoring_resource r
              JOIN monitoring.monitoring_source_generation g
                ON g.monitoring_source_id = %s
              LIMIT 1
            """, (rid, src, rid, src))
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_problem_provider_binding
                (tenant_id, problem_id, monitoring_source_id,
                 source_instance_generation, monitoring_resource_id,
                 provider_profile, provider_external_ref,
                 provider_trigger_ref)
            SELECT 'tenant:dev', %s, %s, active_source_instance_generation,
                   %s, 'zabbix', 'ext-' || %s, 'trg-' || %s
              FROM monitoring.monitoring_source
             WHERE monitoring_source_id = %s
            """, (pid, src, rid, pid, pid, src))
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_problem
                (tenant_id, problem_id, monitoring_source_id,
                 source_instance_generation, monitoring_resource_id,
                 problem_state, severity_class, summary, opened_at,
                 last_confirmed_at, evidence_state,
                 projection_revision, problem_poll_epoch,
                 problem_poll_generation)
            SELECT 'tenant:dev', %s, %s, active_source_instance_generation,
                   %s, 'active', 'critical', 'test problem', now(),
                   now(), 'current', 7, 1, 1
              FROM monitoring.monitoring_source
             WHERE monitoring_source_id = %s
            """, (pid, src, rid, src))
        conn.commit()
        yield {"source": src, "problem": pid, "policy": pol,
               "resource": rid, "conn": conn}
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:dev',false)")
        for t in ("alerting.alert_decision", "alerting.alert_transition",
                  "alerting.alert",
                  "alerting.alert_policy_effective_version",
                  "alerting.alert_policy_version",
                  "alerting.alert_policy"):
            conn.execute(
                f"DELETE FROM {t} WHERE tenant_id='tenant:dev' "
                f"AND policy_id=%s", (pol,))
        # monitoring fixture rows stay: bindings are immutable
        # evidence by design; everything is uniquely suffixed so
        # orphans never collide with later runs.
        conn.commit()


def _make_policy(conn, policy_id: str, min_sev: str = "warning") -> None:
    import hashlib
    import json
    chash = hashlib.sha256(json.dumps({
        "source_kind": "monitoring_problem",
        "problem_min_severity": min_sev,
        "health_classes": [], "monitoring_source_id": None,
        "monitoring_resource_id": None},
        sort_keys=True).encode()).hexdigest()
    conn.execute(
        "INSERT INTO alerting.alert_policy (tenant_id, policy_id) "
        "VALUES ('tenant:dev', %s) ON CONFLICT DO NOTHING",
        (policy_id,))
    conn.execute(
        """
        INSERT INTO alerting.alert_policy_version
            (tenant_id, policy_id, policy_version, source_kind,
             problem_min_severity, content_hash)
        VALUES ('tenant:dev', %s, 1, 'monitoring_problem', %s, %s)
        ON CONFLICT DO NOTHING
        """, (policy_id, min_sev, chash))
    conn.execute(
        """
        INSERT INTO alerting.alert_policy_effective_version
            (tenant_id, policy_id, policy_version, enabled)
        VALUES ('tenant:dev', %s, 1, TRUE)
        ON CONFLICT (tenant_id, policy_id) DO UPDATE
        SET policy_version = 1, enabled = TRUE
        """, (policy_id,))
    conn.commit()


def test_problem_policy_creates_alert(fx):
    from shared import alerting_eval
    conn = fx["conn"]
    _make_policy(conn, fx["policy"])
    stats = alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:dev",
        monitoring_source_id=fx["source"])
    conn.commit()
    assert stats["created"] == 1
    cur = conn.execute(
        """
        SELECT alert_id, policy_version, lifecycle_state,
               source_subject_id, monitoring_resource_id
          FROM alerting.alert
         WHERE tenant_id='tenant:dev' AND policy_id=%s
        """, (fx["policy"],))
    row = cur.fetchone()
    assert row[2] == "active"
    assert row[3] == fx["problem"]
    assert row[4] == fx["resource"]
    cur = conn.execute(
        "SELECT count(*) FROM alerting.alert_transition "
        "WHERE alert_id=%s", (row[0],))
    assert cur.fetchone()[0] == 1
    cur = conn.execute(
        "SELECT effect_kind FROM alerting.alert_decision "
        "WHERE alert_id=%s", (row[0],))
    assert cur.fetchone()[0] == "create"


def test_evaluation_idempotent_replay(fx):
    from shared import alerting_eval
    conn = fx["conn"]
    _make_policy(conn, fx["policy"])
    alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:dev",
        monitoring_source_id=fx["source"])
    conn.commit()
    stats = alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:dev",
        monitoring_source_id=fx["source"])
    conn.commit()
    assert stats["created"] == 0
    cur = conn.execute(
        "SELECT count(*) FROM alerting.alert WHERE policy_id=%s "
        "AND lifecycle_state='active'", (fx["policy"],))
    assert cur.fetchone()[0] == 1


def test_min_severity_no_match_no_alert(fx):
    from shared import alerting_eval
    conn = fx["conn"]
    _make_policy(conn, fx["policy"], min_sev="critical")
    conn.execute(
        "UPDATE monitoring.monitoring_problem SET severity_class="
        "'warning' WHERE problem_id=%s", (fx["problem"],))
    conn.commit()
    stats = alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:dev",
        monitoring_source_id=fx["source"])
    conn.commit()
    assert stats["created"] == 0


def test_resolve_when_problem_no_longer_active(fx):
    from shared import alerting_eval
    conn = fx["conn"]
    _make_policy(conn, fx["policy"])
    alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:dev",
        monitoring_source_id=fx["source"])
    conn.commit()
    conn.execute(
        "UPDATE monitoring.monitoring_problem SET problem_state="
        "'resolved', resolved_at=now() WHERE problem_id=%s",
        (fx["problem"],))
    conn.commit()
    stats = alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:dev",
        monitoring_source_id=fx["source"])
    conn.commit()
    assert stats["resolved"] == 1
    cur = conn.execute(
        "SELECT lifecycle_state FROM alerting.alert "
        "WHERE policy_id=%s", (fx["policy"],))
    assert cur.fetchone()[0] == "resolved"


def test_non_current_evidence_produces_nothing(fx):
    from shared import alerting_eval
    conn = fx["conn"]
    _make_policy(conn, fx["policy"])
    conn.execute(
        "UPDATE monitoring.monitoring_source SET "
        "operational_evidence_state='stale' WHERE "
        "monitoring_source_id=%s", (fx["source"],))
    conn.commit()
    stats = alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:dev",
        monitoring_source_id=fx["source"])
    conn.commit()
    assert stats["reason"] == "source_not_current"
    assert stats["created"] == 0
