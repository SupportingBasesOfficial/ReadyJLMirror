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



def _seed_monitoring(conn, tenant, src, rid, pid):
    """Self-contained monitoring fixture — no dependency on live
    tenant data. Seeds source generation, source, host resource,
    problem binding and an active critical problem."""
    gen = f"gen_{secrets.token_hex(4)}"
    conn.execute(
        """
        INSERT INTO monitoring.monitoring_source_generation
            (tenant_id, monitoring_source_id,
             source_instance_generation, provider_profile,
             provider_instance_ref, provider_base_url)
        VALUES (%s,%s,%s,'zabbix','zbx-test','http://test')
        """, (tenant, src, gen))
    conn.execute(
        """
        INSERT INTO monitoring.monitoring_sync_operation
            (tenant_id, monitoring_sync_operation_id,
             monitoring_source_id, source_instance_generation,
             configuration_revision, scope_revision,
             responsibility_kind, state, started_at, completed_at)
        VALUES (%s,%s,%s,%s,1,1,'problem_state_sync','succeeded',
                now(),now())
        """, (tenant, f"op-{src}", src, gen))
    conn.execute(
        """
        INSERT INTO monitoring.monitoring_source
            (tenant_id, monitoring_source_id,
             provider_scope_tenant_binding_id, provider_profile,
             active_source_instance_generation,
             configuration_revision, scope_revision, display_name,
             credential_binding_ref, configured_provider_scope,
             operational_evidence_state, last_sync_operation_id,
             last_attempt_at,
             item_definition_poll_epoch,
             item_definition_poll_generation,
             current_state_poll_epoch, current_state_poll_generation,
             problem_poll_epoch, problem_poll_generation)
        VALUES (%s,%s,%s,'zabbix',%s,1,1,'test-src','test-cred',
                '{"host_group_refs":[]}'::jsonb,'current',
                %s,now(),
                1,1,1,1,1,1)
        """, (tenant, src, f"{src}_bnd", gen, f"op-{src}"))
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
        VALUES (%s,%s,%s,%s,'host','zabbix_host',%s,'test-res',
                'in_scope',1,'current','present','current',
                now(),now())
        """, (tenant, rid, src, gen, f"ext-{rid}"))
    conn.execute(
        """
        INSERT INTO monitoring.monitoring_problem_provider_binding
            (tenant_id, problem_id, monitoring_source_id,
             source_instance_generation, monitoring_resource_id,
             provider_profile, provider_external_ref,
             provider_trigger_ref)
        VALUES (%s,%s,%s,%s,%s,'zabbix',%s,%s)
        """, (tenant, pid, src, gen, rid, f"ext-{pid}", f"trg-{pid}"))
    conn.execute(
        """
        INSERT INTO monitoring.monitoring_problem
            (tenant_id, problem_id, monitoring_source_id,
             source_instance_generation, monitoring_resource_id,
             problem_state, severity_class, summary, opened_at,
             last_confirmed_at, evidence_state,
             projection_revision, problem_poll_epoch,
             problem_poll_generation)
        VALUES (%s,%s,%s,%s,%s,'active','critical','test problem',
                now(),now(),'current',7,1,1)
        """, (tenant, pid, src, gen, rid))

@pytest.fixture
def fx():
    src = f"mon-src_g7test_{secrets.token_hex(4)}"
    pid = f"prob_{secrets.token_hex(4)}"
    rid = f"res_{secrets.token_hex(4)}"
    pol = f"pol-g7-{secrets.token_hex(4)}"
    with _conn() as conn:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        # Isolate WITHOUT destroying tenant data: evaluation runs
        # over every ENABLED policy of the tenant, so suspend the
        # others for the duration and restore them afterwards.
        cur = conn.execute(
            """
            UPDATE alerting.alert_policy_effective_version
               SET enabled = FALSE
             WHERE tenant_id='tenant:test' AND enabled
             RETURNING policy_id
            """)
        suspended = [r[0] for r in cur.fetchall()]
        _seed_monitoring(conn, 'tenant:test', src, rid, pid)
        conn.commit()
        yield {"source": src, "problem": pid, "policy": pol,
               "resource": rid, "conn": conn}
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        for t in ("alerting.alert_decision", "alerting.alert_transition",
                  "alerting.alert",
                  "alerting.alert_policy_effective_version",
                  "alerting.alert_policy_version",
                  "alerting.alert_policy"):
            conn.execute(
                f"DELETE FROM {t} WHERE tenant_id='tenant:test' "
                f"AND policy_id=%s", (pol,))
        # monitoring fixture rows stay: bindings are immutable
        # evidence by design; everything is uniquely suffixed so
        # orphans never collide with later runs.
        for policy_id in suspended:      # restore live policies
            conn.execute(
                """
                UPDATE alerting.alert_policy_effective_version
                   SET enabled = TRUE
                 WHERE tenant_id='tenant:test' AND policy_id=%s
                """, (policy_id,))
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
        "VALUES ('tenant:test', %s) ON CONFLICT DO NOTHING",
        (policy_id,))
    conn.execute(
        """
        INSERT INTO alerting.alert_policy_version
            (tenant_id, policy_id, policy_version, source_kind,
             problem_min_severity, content_hash)
        VALUES ('tenant:test', %s, 1, 'monitoring_problem', %s, %s)
        ON CONFLICT DO NOTHING
        """, (policy_id, min_sev, chash))
    conn.execute(
        """
        INSERT INTO alerting.alert_policy_effective_version
            (tenant_id, policy_id, policy_version, enabled)
        VALUES ('tenant:test', %s, 1, TRUE)
        ON CONFLICT (tenant_id, policy_id) DO UPDATE
        SET policy_version = 1, enabled = TRUE
        """, (policy_id,))
    conn.commit()


def test_problem_policy_creates_alert(fx):
    from shared import alerting_eval
    conn = fx["conn"]
    _make_policy(conn, fx["policy"])
    stats = alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:test",
        monitoring_source_id=fx["source"])
    conn.commit()
    assert stats["created"] == 1
    cur = conn.execute(
        """
        SELECT alert_id, policy_version, lifecycle_state,
               source_subject_id, monitoring_resource_id
          FROM alerting.alert
         WHERE tenant_id='tenant:test' AND policy_id=%s
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
        conn, tenant_id="tenant:test",
        monitoring_source_id=fx["source"])
    conn.commit()
    stats = alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:test",
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
        conn, tenant_id="tenant:test",
        monitoring_source_id=fx["source"])
    conn.commit()
    assert stats["created"] == 0


def test_resolve_when_problem_no_longer_active(fx):
    from shared import alerting_eval
    conn = fx["conn"]
    _make_policy(conn, fx["policy"])
    alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:test",
        monitoring_source_id=fx["source"])
    conn.commit()
    conn.execute(
        "UPDATE monitoring.monitoring_problem SET problem_state="
        "'resolved', resolved_at=now() WHERE problem_id=%s",
        (fx["problem"],))
    conn.commit()
    stats = alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:test",
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
        conn, tenant_id="tenant:test",
        monitoring_source_id=fx["source"])
    conn.commit()
    assert stats["reason"] == "source_not_current"
    assert stats["created"] == 0
