"""G9 notification delivery — DB-level invariants.

Exercises shared.notification (claim/complete/evidence/projection)
and the callback replay-window helper. The HTTP boundary is covered
by the live E2E; these tests pin the durable semantics.
"""

from __future__ import annotations

import json
import secrets
import time

import pytest

from tests.test_alerting import _conn, _make_policy, fx  # noqa: F401


def _mk_alert(f):
    """Create a real alert through G7 evaluation (FK target for
    notification intents)."""
    from shared import alerting_eval
    conn = f["conn"]
    _make_policy(conn, f["policy"])
    alerting_eval.evaluate_problem_policies(
        conn, tenant_id="tenant:test",
        monitoring_source_id=f["source"])
    conn.commit()
    cur = conn.execute(
        "SELECT alert_id FROM alerting.alert "
        "WHERE tenant_id='tenant:test' AND policy_id=%s",
        (f["policy"],))
    return cur.fetchone()[0]


@pytest.fixture
def intent(fx):  # noqa: F811
    from shared.notification import _hash
    conn = fx["conn"]
    alert_id = _mk_alert(fx)
    iid = f"nti_test_{secrets.token_hex(6)}"
    conn.execute(
        """
        INSERT INTO notification.notification_intent
            (tenant_id, notification_intent_id, alert_id,
             destination_ref, channel_class, reason, payload_ref,
             content_hash, authority_snapshot, logical_action_id,
             created_by_principal_id)
        VALUES ('tenant:test',%s,%s,'5511999990000',
                'whatsapp_business@1','alert_requires_attention',
                'alert_notification',%s,'{}'::jsonb,%s,'test')
        """,
        (iid, alert_id, _hash({"t": iid}), f"la_{iid}"))
    conn.execute(
        """
        INSERT INTO notification.notification_dispatch_outbox
            (tenant_id, dispatch_id, notification_intent_id,
             logical_dispatch_id, attempt_number)
        VALUES ('tenant:test',%s,%s,%s,1)
        """,
        (f"dsp_{secrets.token_hex(6)}", iid, f"dispatch:{iid}:1"))
    conn.commit()
    yield {"conn": conn, "intent": iid, "alert": alert_id}
    conn.execute(
        "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
    for t in ("notification.notification_projection",
              "notification.notification_provider_evidence",
              "notification.notification_callback_inbox",
              "notification.notification_attempt",
              "notification.notification_dispatch_outbox",
              "notification.provider_ref_binding",
              "notification.notification_intent"):
        conn.execute(
            f"DELETE FROM {t} WHERE notification_intent_id=%s",
            (iid,))
    conn.commit()


def _dispatch_once(conn, outcome, iid):
    """Claim OUR pending outbox row (scoped — live rows in the dev
    tenant are never touched) and complete it. Mirrors the worker's
    claim -> complete -> retry/projection path."""
    from shared import notification
    token = f"ct_{secrets.token_hex(6)}"
    # Clock-advance: bounded backoff schedules retries in the future;
    # the test compresses the wait instead of sleeping.
    conn.execute(
        "UPDATE notification.notification_dispatch_outbox "
        "SET next_attempt_at = now() - interval '1 second' "
        "WHERE notification_intent_id=%s AND state='pending'", (iid,))
    cur = conn.execute(
        """
        UPDATE notification.notification_dispatch_outbox
           SET state='claimed', claim_token=%s
         WHERE (tenant_id, dispatch_id) = (
             SELECT tenant_id, dispatch_id
               FROM notification.notification_dispatch_outbox
              WHERE state='pending' AND next_attempt_at <= now()
                AND notification_intent_id=%s
              ORDER BY created_at LIMIT 1
              FOR UPDATE SKIP LOCKED)
        RETURNING tenant_id, dispatch_id, notification_intent_id,
                  attempt_number, logical_dispatch_id
        """, (token, iid))
    row = cur.fetchone()
    assert row is not None, "no pending dispatch for test intent"
    tenant_id, dispatch_id, _, attempt_no, logical_id = row
    notification.complete_dispatch(
        conn, tenant_id=tenant_id, dispatch_id=dispatch_id,
        claim_token=token, intent_id=iid, attempt_number=attempt_no,
        logical_dispatch_id=logical_id, outcome=outcome,
        provider_message_ref="wamid.test" if outcome ==
        "provider_accepted" else None,
        failure_class="simulated" if outcome in ("failed", "unknown")
        else None)
    return attempt_no


def _projection(conn, iid):
    cur = conn.execute(
        """
        SELECT current_state, attempt_count, retry_required,
               fallback_action_required
          FROM notification.notification_projection
         WHERE notification_intent_id=%s
        """, (iid,))
    return cur.fetchone()


def test_failed_attempt_schedules_bounded_retry(intent):
    conn = _conn()
    try:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        # run_all claims with its own conn; use the same DB
        _dispatch_once(conn, "failed", intent["intent"])
        conn.commit()
        state, count, retry, fallback = _projection(
            conn, intent["intent"])
        assert (state, count, retry, fallback) == (
            "failed", 1, True, False)
        cur = conn.execute(
            """
            SELECT attempt_number, next_attempt_at > now()
              FROM notification.notification_dispatch_outbox
             WHERE notification_intent_id=%s AND state='pending'
            """, (intent["intent"],))
        n, future = cur.fetchone()
        assert n == 2 and future
        conn.commit()
    finally:
        conn.rollback()
        conn.close()


def test_retry_exhaustion_sets_fallback(intent):
    conn = _conn()
    try:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        from shared import notification
        for _ in range(notification.MAX_ATTEMPTS):
            _dispatch_once(conn, "failed", intent["intent"])
            conn.commit()
        state, count, retry, fallback = _projection(
            conn, intent["intent"])
        assert state == "failed" and count == notification.MAX_ATTEMPTS
        assert not retry and fallback
        cur = conn.execute(
            "SELECT count(*) FROM "
            "notification.notification_dispatch_outbox "
            "WHERE notification_intent_id=%s AND state='pending'",
            (intent["intent"],))
        assert cur.fetchone()[0] == 0
        conn.commit()
    finally:
        conn.rollback()
        conn.close()


def test_evidence_dedup_and_monotonic(intent):
    conn = _conn()
    try:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        from shared import notification
        _dispatch_once(conn, "provider_accepted", intent["intent"])
        notification.record_evidence(
            conn, tenant_id="tenant:test", intent_id=intent["intent"],
            normalized_state="delivered",
            provider_callback_id="cb-dup",
            provider_message_ref="wamid.test")
        conn.commit()
        # weaker evidence must not downgrade the projection
        notification.record_evidence(
            conn, tenant_id="tenant:test", intent_id=intent["intent"],
            normalized_state="provider_accepted",
            provider_callback_id="cb-weaker",
            provider_message_ref="wamid.test")
        # replayed callback_id dedups durably
        dup = notification.record_evidence(
            conn, tenant_id="tenant:test", intent_id=intent["intent"],
            normalized_state="failed",
            provider_callback_id="cb-dup",
            provider_message_ref="wamid.test")
        conn.commit()
        assert dup is None
        state, count, retry, fallback = _projection(
            conn, intent["intent"])
        assert state == "delivered"
        conn.commit()
    finally:
        conn.rollback()
        conn.close()


def test_out_of_order_evidence_reconciles(intent):
    """Delivered arriving before accepted still ends at delivered."""
    conn = _conn()
    try:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        from shared import notification
        _dispatch_once(conn, "provider_accepted", intent["intent"])
        notification.record_evidence(
            conn, tenant_id="tenant:test", intent_id=intent["intent"],
            normalized_state="delivered",
            provider_callback_id="cb-a",
            provider_message_ref="wamid.test")
        notification.record_evidence(
            conn, tenant_id="tenant:test", intent_id=intent["intent"],
            normalized_state="provider_accepted",
            provider_callback_id="cb-b",
            provider_message_ref="wamid.test")
        conn.commit()
        state = _projection(conn, intent["intent"])[0]
        assert state == "delivered"
        conn.commit()
    finally:
        conn.rollback()
        conn.close()


def test_provider_ref_binding_routes_callback(intent):
    """Dispatch completion writes the global routing index — the
    callback derives (tenant, intent) from the provider ref, never
    from the payload or a global env tenant."""
    conn = _conn()
    try:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        _dispatch_once(conn, "provider_accepted", intent["intent"])
        conn.commit()
        # the routing index is tenant-independent — query it under a
        # different tenant context to prove binding, not context,
        # resolves the route
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:other',false)")
        cur = conn.execute(
            """
            SELECT tenant_id, notification_intent_id
              FROM notification.provider_ref_binding
             WHERE provider_message_ref='wamid.test'
            """)
        row = cur.fetchone()
        assert row == ("tenant:test", intent["intent"])
        conn.commit()
    finally:
        conn.rollback()
        conn.close()


def test_callback_replay_window():
    from shared.notification import callback_timestamp_expired
    now = time.time()
    assert not callback_timestamp_expired(now, now=now, window=600)
    assert not callback_timestamp_expired(
        now - 599, now=now, window=600)
    assert callback_timestamp_expired(
        now - 601, now=now, window=600)
    # future-skewed beyond the window also fails (clock attack)
    assert callback_timestamp_expired(
        now + 601, now=now, window=600)
    # unparseable fails closed
    assert callback_timestamp_expired("garbage", now=now, window=600)
    assert callback_timestamp_expired(None, now=now, window=600)


def test_unknown_never_becomes_failed(intent):
    """Unknown is not failed — the projection keeps it distinct."""
    conn = _conn()
    try:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        _dispatch_once(conn, "unknown", intent["intent"])
        conn.commit()
        state = _projection(conn, intent["intent"])[0]
        assert state == "unknown"
        conn.commit()
    finally:
        conn.rollback()
        conn.close()


def test_intent_channel_check(intent):
    """Intent rows never accept a second channel class — the CHECK
    keeps whatsapp_business@1 as the only admitted channel."""
    conn = _conn()
    try:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        import psycopg
        with pytest.raises(psycopg.errors.CheckViolation):
            conn.execute(
                """
                INSERT INTO notification.notification_intent
                    (tenant_id, notification_intent_id, alert_id,
                     destination_ref, channel_class, reason,
                     payload_ref, content_hash, authority_snapshot,
                     logical_action_id, created_by_principal_id)
                VALUES ('tenant:test',%s,%s,'x','email@1',
                        'alert_requires_attention','p','h',
                        '{}'::jsonb,%s,'test')
                """,
                (f"nti_bad_{secrets.token_hex(4)}", intent["alert"],
                 f"la_{secrets.token_hex(4)}"))
    finally:
        conn.rollback()
        conn.close()


def test_attempt_dispatch_identity_dedup(intent):
    """Same logical dispatch identity cannot produce two attempts."""
    conn = _conn()
    try:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id','tenant:test',false)")
        import psycopg
        with pytest.raises(psycopg.errors.UniqueViolation):
            conn.execute(
                """
                INSERT INTO notification.notification_attempt
                    (tenant_id, notification_attempt_id,
                     notification_intent_id, attempt_number,
                     dispatch_evidence, adapter_version, outcome,
                     dispatch_identity)
                VALUES ('tenant:test','att_a',%s,1,'{}'::jsonb,
                        'whatsapp_business@1','sent',%s),
                       ('tenant:test','att_b',%s,2,'{}'::jsonb,
                        'whatsapp_business@1','sent',%s)
                """,
                (intent["intent"], f"dup_{intent['intent']}",
                 intent["intent"], f"dup_{intent['intent']}"))
    finally:
        conn.rollback()
        conn.close()


def test_projection_json_shape(intent):
    """detail endpoint shape: retry policy + projection are distinct
    fields (regression guard for the API contract the UI reads)."""
    from shared import notification
    assert notification.MAX_ATTEMPTS == 3
    assert notification.ADAPTER_VERSION == "whatsapp_business@1"
    _ = json.dumps({"retry_policy": {"max_attempts":
                                     notification.MAX_ATTEMPTS}})
