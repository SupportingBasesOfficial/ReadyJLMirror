"""Scheduler evidence-gating tests — which source states get probed.

Self-contained fixtures on tenant:test; exercises the real SQL path
against live PostgreSQL.
"""

from __future__ import annotations

import os
import secrets

import psycopg
import pytest


def _conn():
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

TENANT = "tenant:test"


@pytest.fixture()
def source():
    """A monitoring source due for every kind (seed op completed long
    ago); tests flip its evidence state to exercise gating."""
    src = f"mon-src_sched_{secrets.token_hex(6)}"
    gen = f"gen_{secrets.token_hex(4)}"
    seed_op = f"op-seed-{src}"
    with _conn() as conn:
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_source_generation
                (tenant_id, monitoring_source_id,
                 source_instance_generation, provider_profile,
                 provider_instance_ref, provider_base_url)
            VALUES (%s,%s,%s,'zabbix','zbx-test','http://test')
            """, (TENANT, src, gen))
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_sync_operation
                (tenant_id, monitoring_sync_operation_id,
                 monitoring_source_id, source_instance_generation,
                 configuration_revision, scope_revision,
                 responsibility_kind, state, started_at, completed_at)
            VALUES (%s,%s,%s,%s,1,1,
                    'validation_and_initial_sync','succeeded',
                    now() - interval '3 hours', now() - interval '3 hours')
            """, (TENANT, seed_op, src, gen))
        conn.execute(
            """
            INSERT INTO monitoring.monitoring_source
                (tenant_id, monitoring_source_id,
                 provider_scope_tenant_binding_id, provider_profile,
                 active_source_instance_generation,
                 configuration_revision, scope_revision, display_name,
                 credential_binding_ref, configured_provider_scope,
                 operational_evidence_state, last_sync_operation_id,
                 item_definition_poll_epoch, item_definition_poll_generation,
                 current_state_poll_epoch, current_state_poll_generation,
                 problem_poll_epoch, problem_poll_generation)
            VALUES (%s,%s,%s,'zabbix',%s,1,1,'sched-src','test-cred',
                    '{"host_group_refs":[]}'::jsonb,'current',%s,
                    1,1,1,1,1,1)
            """, (TENANT, src, f"{src}_bnd", gen, seed_op))
        conn.commit()
    yield src
    with _conn() as conn:
        # monitoring.* FKs are DEFERRABLE INITIALLY DEFERRED — delete
        # children and parents in one transaction; checks fire at commit.
        for t in ("monitoring_sync_operation", "monitoring_source",
                  "monitoring_source_generation"):
            conn.execute(
                f"DELETE FROM monitoring.{t} "
                f"WHERE monitoring_source_id=%s", (src,))
        conn.commit()


def _set_evidence(src: str, state: str) -> None:
    with _conn() as conn:
        conn.execute(
            "UPDATE monitoring.monitoring_source"
            " SET operational_evidence_state=%s"
            " WHERE tenant_id=%s AND monitoring_source_id=%s",
            (state, TENANT, src))
        conn.commit()


def _run_scheduler() -> None:
    from workers.scheduler import _process_pending
    with _conn() as conn:
        _process_pending(conn)
        conn.commit()


def _pending_kinds(src: str) -> list[str]:
    with _conn() as conn:
        cur = conn.execute(
            "SELECT responsibility_kind"
            " FROM monitoring.monitoring_sync_operation"
            " WHERE tenant_id=%s AND monitoring_source_id=%s"
            "   AND state='pending'", (TENANT, src))
        return [r[0] for r in cur.fetchall()]


def test_unavailable_source_gets_recovery_probe(source):
    """'unavailable' sources must still be probed — a transient failure
    (credential blip, network partition) would otherwise brick the
    source until an operator intervenes."""
    _set_evidence(source, "unavailable")
    _run_scheduler()
    kinds = _pending_kinds(source)
    assert "host_inventory_sync" in kinds


def test_unavailable_source_excluded_from_alert_eval(source):
    """problem_state_sync is hard-gated to 'current' — alert
    evaluation must never see degraded scope evidence."""
    _set_evidence(source, "unavailable")
    _run_scheduler()
    assert "problem_state_sync" not in _pending_kinds(source)


def test_current_source_gets_all_kinds(source):
    _run_scheduler()
    kinds = _pending_kinds(source)
    for kind in ("problem_state_sync", "current_state_poll",
                 "host_inventory_sync", "metric_definition_poll",
                 "metric_history_sync"):
        assert kind in kinds


def test_schedulable_sets():
    """problem_state stays hard-gated; the cheap probe covers the
    full recoverable set including 'unavailable'."""
    from workers.scheduler import _SCHEDULABLE
    assert _SCHEDULABLE["problem_state_sync"] == ("current",)
    assert "unavailable" in _SCHEDULABLE["host_inventory_sync"]
    assert "unavailable" not in _SCHEDULABLE["current_state_poll"]
