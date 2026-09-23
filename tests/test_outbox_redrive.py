"""Outbox quarantine redrive — the DLQ recovery path.

Self-contained fixtures on tenant:test; exercises the real SQL
function against live PostgreSQL:

  - quarantined -> pending with fresh attempt budget
  - non-quarantined rows are not touchable (idempotent)
  - redrive_count bound refuses permanent poison loops
  - claim fields cleared so the dispatcher can claim it
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


def _insert(conn, *, state="quarantined", attempts=5, redrives=0):
    """Insert an outbox row; returns its record_id."""
    msg = f"msg-{secrets.token_hex(6)}"
    cur = conn.execute(
        """
        INSERT INTO monitoring.monitoring_outbox
            (tenant_id, message_id, producer_message_scope,
             message_class, contract_name, contract_version,
             producer, scope, correlation_id,
             data_classification, serialization_profile_id,
             encoded_payload, comparison_evidence,
             comparison_profile_id, comparison_profile_version,
             subject_type, subject_id, occurred_at, dispatch_state,
             attempt_count, redrive_count, last_error_class,
             claim_owner, claim_expires_at)
        VALUES (%s,%s,'scope','domain_event',
                'monitoring.problem-state.changed','1.0.0',
                'Monitoring','tenant',%s,
                'internal','jlmirror.monitoring.v1',
                %s,%s,'cmp','1',
                'monitoring_problem','prob-1',
                now() - interval '1 hour',%s,
                %s,%s,'publication_exhausted',
                'worker-x', now() + interval '1 hour')
        RETURNING record_id
        """,
        (TENANT, msg, f"corr-{msg}", b"{}", b"{}", state,
         attempts, redrives))
    return cur.fetchone()[0]


@pytest.fixture()
def quarantined():
    with _conn() as conn:
        rid = _insert(conn)
        conn.commit()
        yield rid
        conn.execute(
            "DELETE FROM monitoring.monitoring_outbox "
            "WHERE record_id = %s", (rid,))
        conn.commit()


def _redrive(rid, max_redrives=5):
    with _conn() as conn:
        cur = conn.execute(
            "SELECT monitoring.redrive_outbox_message(%s, %s, %s)",
            (TENANT, rid, max_redrives))
        ok = cur.fetchone()[0]
        conn.commit()
    return ok


def _fetch(rid):
    with _conn() as conn:
        cur = conn.execute(
            """
            SELECT dispatch_state, attempt_count, redrive_count,
                   last_error_class, claim_owner, claim_expires_at
              FROM monitoring.monitoring_outbox
             WHERE record_id = %s
            """, (rid,))
        return cur.fetchone()


def test_redrive_returns_quarantined_to_pending(quarantined):
    assert _redrive(quarantined) is True
    state, attempts, redrives, err, owner, exp = _fetch(quarantined)
    assert state == "pending"
    assert attempts == 0            # fresh retry budget
    assert redrives == 1
    assert err == "operator_redrive"
    assert owner is None and exp is None  # claim fields cleared


def test_redrive_is_idempotent(quarantined):
    assert _redrive(quarantined) is True
    assert _redrive(quarantined) is False   # already pending
    state, _, redrives, _, _, _ = _fetch(quarantined)
    assert state == "pending" and redrives == 1


def test_redrive_refuses_non_quarantined():
    with _conn() as conn:
        rid = _insert(conn, state="published", attempts=1)
        conn.commit()
        try:
            assert _redrive(rid) is False
            state, attempts, *_ = _fetch(rid)
            assert state == "published" and attempts == 1
        finally:
            with _conn() as c:
                c.execute(
                    "DELETE FROM monitoring.monitoring_outbox "
                    "WHERE record_id = %s", (rid,))
                c.commit()


def test_redrive_count_bounds_permanent_poison():
    with _conn() as conn:
        rid = _insert(conn, redrives=5)
        conn.commit()
        try:
            assert _redrive(rid, max_redrives=5) is False
            state, _, redrives, *_ = _fetch(rid)
            assert state == "quarantined" and redrives == 5
        finally:
            with _conn() as c:
                c.execute(
                    "DELETE FROM monitoring.monitoring_outbox "
                    "WHERE record_id = %s", (rid,))
                c.commit()


def test_redrive_preserves_message_identity(quarantined):
    with _conn() as conn:
        cur = conn.execute(
            "SELECT message_id, encoded_payload "
            "FROM monitoring.monitoring_outbox WHERE record_id = %s",
            (quarantined,))
        mid, payload = cur.fetchone()
    _redrive(quarantined)
    with _conn() as conn:
        cur = conn.execute(
            "SELECT message_id, encoded_payload "
            "FROM monitoring.monitoring_outbox WHERE record_id = %s",
            (quarantined,))
        mid2, payload2 = cur.fetchone()
    # Same durable identity — the inbox dedup key is unchanged, so a
    # redriven message cannot create a duplicate downstream effect.
    assert mid2 == mid and bytes(payload2) == bytes(payload)
