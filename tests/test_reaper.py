"""Reaper/reconciliation worker tests — orphaned running, zombie
pending, bounded reconciliation requeue.

Self-contained fixtures on tenant:test; exercises the real SQL paths
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
    """A monitoring source with known authority snapshot."""
    src = f"mon-src_reaper_{secrets.token_hex(6)}"
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
                    now(),now())
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
            VALUES (%s,%s,%s,'zabbix',%s,1,1,'reaper-src','test-cred',
                    '{"host_group_refs":[]}'::jsonb,'current',%s,
                    1,1,1,1,1,1)
            """, (TENANT, src, f"{src}_bnd", gen, seed_op))
        conn.commit()
    yield {"src": src, "gen": gen}
    with _conn() as conn:
        for t in ("monitoring_source", "monitoring_sync_operation",
                  "monitoring_source_generation"):
            conn.execute(
                f"DELETE FROM monitoring.{t} "
                f"WHERE monitoring_source_id=%s", (src,))
        conn.commit()


def _mk_op(conn, src, gen, *, kind="problem_state_sync", state="pending",
           started=None, completed=None, recovery=0,
           config_rev=1, scope_rev=1):
    op = f"mon-op_{secrets.token_hex(6)}"
    conn.execute(
        f"""
        INSERT INTO monitoring.monitoring_sync_operation
            (tenant_id, monitoring_sync_operation_id,
             monitoring_source_id, source_instance_generation,
             configuration_revision, scope_revision,
             responsibility_kind, state, claim_token,
             started_at, completed_at, recovery_count)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,{started or 'NULL'},
                {completed or 'NULL'},%s)
        """,
        (TENANT, op, src, gen, config_rev, scope_rev, kind, state,
         "claim-x" if state == "running" else None,
         recovery))
    return op


def _op_state(conn, op):
    cur = conn.execute(
        """
        SELECT state, claim_token, recovery_count, last_error_class
          FROM monitoring.monitoring_sync_operation
         WHERE monitoring_sync_operation_id=%s
        """, (op,))
    return cur.fetchone()


def _run(conn):
    from workers.reconciliation import _process_pending
    return _process_pending(conn)


def test_orphaned_running_requeued(source):
    with _conn() as conn:
        op = _mk_op(
            conn, source["src"], source["gen"], state="running",
            started="now() - interval '1 hour'")
        n = _run(conn)
        st = _op_state(conn, op)
    assert n >= 1
    assert st[0] == "pending" and st[1] is None
    assert st[2] == 1 and st[3] == "claim.orphaned"


def test_orphaned_running_exhausted_terminal(source):
    with _conn() as conn:
        op = _mk_op(
            conn, source["src"], source["gen"], state="running",
            started="now() - interval '1 hour'", recovery=3)
        _run(conn)
        st = _op_state(conn, op)
    assert st[0] == "failed_terminal"
    assert st[3] == "claim.orphaned_exhausted"


def test_fresh_running_untouched(source):
    with _conn() as conn:
        op = _mk_op(conn, source["src"], source["gen"],
                    state="running", started="now()")
        _run(conn)
        st = _op_state(conn, op)
    assert st[0] == "running" and st[1] == "claim-x"


def test_zombie_pending_terminated(source):
    """Pending op whose snapshot diverged from source authority can
    never satisfy a claim fence — it is terminally swept."""
    with _conn() as conn:
        op = _mk_op(conn, source["src"], source["gen"],
                    state="pending", scope_rev=99)
        _run(conn)
        st = _op_state(conn, op)
    assert st[0] == "failed_terminal"
    assert st[3] == "authority_superseded"


def test_live_pending_untouched(source):
    with _conn() as conn:
        op = _mk_op(conn, source["src"], source["gen"], state="pending")
        _run(conn)
        st = _op_state(conn, op)
    assert st[0] == "pending"


def test_terminal_requeued_with_evidence_restore(source):
    """reconciliation_required + elapsed backoff + no live successor
    -> pending again, and source evidence restored to 'current'
    (the reconciliation act)."""
    with _conn() as conn:
        op = _mk_op(conn, source["src"], source["gen"],
                    state="reconciliation_required",
                    completed="'2000-01-01'::timestamptz")
        conn.execute(
            """
            UPDATE monitoring.monitoring_source
               SET operational_evidence_state='reconciliation_required'
             WHERE monitoring_source_id=%s
            """, (source["src"],))
        _run(conn)
        st = _op_state(conn, op)
        ev = conn.execute(
            "SELECT operational_evidence_state FROM "
            "monitoring.monitoring_source "
            "WHERE monitoring_source_id=%s",
            (source["src"],)).fetchone()[0]
    assert st[0] == "pending" and st[2] == 1
    assert ev == "current"


def test_terminal_skipped_when_live_successor(source):
    """Scheduler already produced a live op of the same kind — the
    reconciler must not double the work."""
    with _conn() as conn:
        old = _mk_op(conn, source["src"], source["gen"],
                     state="reconciliation_required",
                     completed="now() - interval '1 hour'")
        _mk_op(conn, source["src"], source["gen"], state="pending")
        _run(conn)
        st = _op_state(conn, old)
    assert st[0] == "reconciliation_required"


def test_terminal_recovery_cap(source):
    with _conn() as conn:
        op = _mk_op(conn, source["src"], source["gen"],
                    state="reconciliation_required",
                    completed="now() - interval '1 hour'",
                    recovery=3)
        _run(conn)
        st = _op_state(conn, op)
    assert st[0] == "reconciliation_required"


def test_recent_terminal_untouched(source):
    """Inside the backoff window the reconciler waits — the cadence
    or the operator gets the first move."""
    with _conn() as conn:
        op = _mk_op(conn, source["src"], source["gen"],
                    state="reconciliation_required",
                    completed="now()")
        _run(conn)
        st = _op_state(conn, op)
    assert st[0] == "reconciliation_required"
