"""G23 Escalation worker — fires successive notification steps for
active alerts that have an assigned escalation policy and have exceeded
the step's delay threshold without resolving.

Suppression checks (same order as notification_dispatch):
  1. Alert must still be lifecycle_state='active'.
  2. Alert must not be snoozed (g21_is_snoozed).
  3. Elapsed time since last_fired_at (or armed_at for step 1) must
     be >= the step's delay_minutes.

On firing: inserts notification_intent + dispatch_outbox directly
(same pattern as notification_dispatch), then calls g23_advance_step.
"""

from __future__ import annotations

import json
import logging
import secrets

import psycopg

logger = logging.getLogger(__name__)

_APP_ROLE    = "jlmirror_g23_esc_app_invoker"
_WORKER_ROLE = "jlmirror_g23_esc_worker_invoker"


def _tenants(conn: psycopg.Connection) -> list[str]:
    cur = conn.execute(
        "SELECT tenant_id FROM g1.tenants WHERE state='active'")
    return [r[0] for r in cur.fetchall()]


def _due_escalations(conn: psycopg.Connection,
                     tenant_id: str) -> list[dict]:
    """Return all escalation steps that are due for this tenant."""
    conn.execute(
        "SELECT set_config('jlmirror.tenant_id', %s, false)",
        (tenant_id,))
    cur = conn.execute(
        """
        SELECT ae.alert_id, ae.policy_id, ae.current_step,
               es.delay_minutes, es.channel_class,
               es.destination_ref, es.payload_ref
          FROM alerting.alert_escalation ae
          JOIN alerting.alert a
            ON a.alert_id = ae.alert_id AND a.tenant_id = ae.tenant_id
          JOIN alerting.escalation_step es
            ON es.policy_id    = ae.policy_id
           AND es.tenant_id    = ae.tenant_id
           AND es.step_number  = ae.current_step
         WHERE ae.tenant_id    = %s
           AND ae.completed_at IS NULL
           AND a.lifecycle_state = 'active'
           AND now() - COALESCE(ae.last_fired_at, ae.armed_at)
               >= (es.delay_minutes || ' minutes')::interval
        """, (tenant_id,))
    cols = [d.name for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


def _fire_step(conn: psycopg.Connection,
               tenant_id: str, row: dict) -> None:
    alert_id    = row["alert_id"]
    channel     = row["channel_class"]
    dest        = row["destination_ref"]
    payload_ref = row["payload_ref"]
    step_no     = row["current_step"]

    # G21: skip if alert is snoozed
    snooze_cur = conn.execute(
        "SELECT alerting.g21_is_snoozed(%s, %s)", (tenant_id, alert_id))
    if snooze_cur.fetchone()[0]:
        logger.info("escalation skipped — alert %s is snoozed", alert_id)
        conn.rollback()
        return

    intent_id  = f"nti_{secrets.token_urlsafe(12)}"
    dispatch_id = f"dsp_{secrets.token_urlsafe(12)}"
    logical_id  = f"esc:{alert_id}:step{step_no}"

    from shared.notification import _hash
    content = {
        "alert_id": alert_id, "destination_ref": dest,
        "reason": "alert_requires_attention", "payload_ref": payload_ref,
    }

    try:
        with conn.transaction():
            conn.execute(
                """
                INSERT INTO notification.notification_intent
                    (tenant_id, notification_intent_id, alert_id,
                     recipient_principal_id, destination_ref,
                     channel_class, reason, payload_ref, content_hash,
                     authority_snapshot, logical_action_id,
                     created_by_principal_id)
                VALUES (%s,%s,%s,NULL,%s,%s,
                        'alert_requires_attention',%s,%s,
                        '{"principal_id":"escalation-worker"}'::jsonb,
                        %s,'escalation-worker')
                ON CONFLICT DO NOTHING
                """,
                (tenant_id, intent_id, alert_id, dest, channel,
                 payload_ref, _hash(content), logical_id))
            conn.execute(
                """
                INSERT INTO notification.notification_dispatch_outbox
                    (tenant_id, dispatch_id, notification_intent_id,
                     logical_dispatch_id, attempt_number)
                VALUES (%s,%s,%s,%s,1)
                """,
                (tenant_id, dispatch_id, intent_id,
                 f"dispatch:{intent_id}:1"))
            # Advance or complete the escalation
            conn.execute(
                f"SET LOCAL ROLE {_WORKER_ROLE}")
            conn.execute(
                "SELECT alerting.g23_advance_step(%s,%s,%s)",
                (tenant_id, alert_id, step_no))
    except Exception:
        conn.rollback()
        logger.exception(
            "escalation step fire failed alert=%s step=%s", alert_id, step_no)
        return

    logger.info("escalation step %s fired for alert %s → %s via %s",
                step_no, alert_id, dest, channel)


def _process_pending(conn: psycopg.Connection) -> int:
    processed = 0
    try:
        tenants = _tenants(conn)
    except Exception:
        conn.rollback()
        logger.exception("escalation: failed to list tenants")
        return 0
    for tenant_id in tenants:
        try:
            due = _due_escalations(conn, tenant_id)
            conn.rollback()   # release snapshot
        except Exception:
            conn.rollback()
            logger.exception("escalation: due query failed tenant=%s", tenant_id)
            continue
        for row in due:
            _fire_step(conn, tenant_id, row)
            processed += 1
    return processed
