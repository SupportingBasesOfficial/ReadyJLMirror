"""G9 notification delivery — intent, dispatch, evidence,
projection (canonical g9.notification-delivery@1).

State rank is monotonic: stronger evidence may advance the
projection but never rewrites attempts or invents strength.
`unknown` stays unknown; `external_read_observed` is supplementary
and never satisfies G8 authoritative visibility.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import timedelta

# Monotonic rank — evidence can only advance, never downgrade.
_STATE_RANK = {
    "dispatching": 0, "unknown": 0, "failed": 0,
    "sent": 1, "provider_accepted": 2, "delivered": 3,
    "external_read_observed": 4,
}
MAX_ATTEMPTS = 3
ADAPTER_VERSION = "whatsapp_business@1"


def callback_timestamp_expired(ts, *, now: float,
                               window: int) -> bool:
    """Signed-payload freshness: the timestamp lives inside the
    HMAC'd body, so a captured callback cannot be freshened without
    the secret. Missing/unparseable timestamps fail closed."""
    try:
        return abs(now - float(ts)) > window
    except (TypeError, ValueError):
        return True


def _hash(obj) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True,
                   separators=(",", ":")).encode()).hexdigest()


def _recompute_projection(conn, tenant_id: str, intent_id: str) -> None:
    """Rebuild the delivery projection from immutable facts."""
    cur = conn.execute(
        """
        SELECT outcome, notification_attempt_id, completed_at
          FROM notification.notification_attempt
         WHERE tenant_id=%s AND notification_intent_id=%s
         ORDER BY attempt_number DESC LIMIT 1
        """, (tenant_id, intent_id))
    last_attempt = cur.fetchone()
    cur = conn.execute(
        """
        SELECT normalized_state, notification_evidence_id,
               observed_at
          FROM notification.notification_provider_evidence
         WHERE tenant_id=%s AND notification_intent_id=%s
         ORDER BY observed_at DESC LIMIT 1
        """, (tenant_id, intent_id))
    last_ev = cur.fetchone()
    cur = conn.execute(
        """
        SELECT count(*) FROM notification.notification_attempt
         WHERE tenant_id=%s AND notification_intent_id=%s
        """, (tenant_id, intent_id))
    attempts = cur.fetchone()[0]

    attempt_state = last_attempt[0] if last_attempt else "dispatching"
    # Monotonic strongest-known: the projection takes the MAXIMUM
    # evidence rank ever observed — out-of-order weaker evidence can
    # never downgrade it (canonical reconcile law). last_evidence_id
    # stays the most recent row for diagnostics.
    cur = conn.execute(
        """
        SELECT normalized_state
          FROM notification.notification_provider_evidence
         WHERE tenant_id=%s AND notification_intent_id=%s
        """, (tenant_id, intent_id))
    ev_states = [r[0] for r in cur.fetchall()]
    rank_a = _STATE_RANK.get(attempt_state, 0)
    best_ev = max(ev_states, key=lambda s: _STATE_RANK.get(s, 0),
                  default=None)
    rank_e = _STATE_RANK.get(best_ev, -1) if best_ev else -1
    current = best_ev if rank_e > rank_a else attempt_state

    delivered_at = None
    read_at = None
    cur = conn.execute(
        """
        SELECT normalized_state, observed_at
          FROM notification.notification_provider_evidence
         WHERE tenant_id=%s AND notification_intent_id=%s
           AND normalized_state IN ('delivered','external_read_observed')
         ORDER BY normalized_state, observed_at
        """, (tenant_id, intent_id))
    for st, ts in cur.fetchall():
        if st == "delivered" and delivered_at is None:
            delivered_at = ts
        if st == "external_read_observed":
            read_at = ts

    terminal = current in ("delivered", "external_read_observed")
    exhausted = attempts >= MAX_ATTEMPTS
    failed_last = attempt_state in ("failed", "unknown")
    retry_required = (not terminal) and failed_last and not exhausted
    fallback = (not terminal) and exhausted and failed_last

    conn.execute(
        """
        INSERT INTO notification.notification_projection
            (tenant_id, notification_intent_id, current_state,
             last_attempt_id, last_evidence_id, attempt_count,
             delivered_at, external_read_observed_at,
             retry_required, fallback_action_required,
             projection_revision)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,1)
        ON CONFLICT (tenant_id, notification_intent_id) DO UPDATE
        SET current_state = EXCLUDED.current_state,
            last_attempt_id = EXCLUDED.last_attempt_id,
            last_evidence_id = EXCLUDED.last_evidence_id,
            attempt_count = EXCLUDED.attempt_count,
            delivered_at = COALESCE(
                notification_projection.delivered_at,
                EXCLUDED.delivered_at),
            external_read_observed_at = COALESCE(
                notification_projection.external_read_observed_at,
                EXCLUDED.external_read_observed_at),
            retry_required = EXCLUDED.retry_required,
            fallback_action_required =
                EXCLUDED.fallback_action_required,
            projection_revision =
                notification_projection.projection_revision + 1,
            updated_at = transaction_timestamp()
        """,
        (tenant_id, intent_id, current,
         last_attempt[1] if last_attempt else None,
         last_ev[1] if last_ev else None, attempts,
         delivered_at, read_at, retry_required, fallback))


# ---------------------------------------------------------------------------
# Worker path — durable dispatch (sync psycopg)
# ---------------------------------------------------------------------------


def claim_dispatch(conn, *, claim_token: str):
    """Oldest due pending outbox entry -> claimed (fenced)."""
    cur = conn.execute(
        """
        UPDATE notification.notification_dispatch_outbox
           SET state='claimed', claim_token=%s
         WHERE (tenant_id, dispatch_id) = (
             SELECT tenant_id, dispatch_id
               FROM notification.notification_dispatch_outbox
              WHERE state='pending' AND next_attempt_at <= now()
              ORDER BY created_at LIMIT 1
              FOR UPDATE SKIP LOCKED)
         RETURNING tenant_id, dispatch_id, notification_intent_id,
                   attempt_number, logical_dispatch_id
        """, (claim_token,))
    return cur.fetchone()


def complete_dispatch(conn, *, tenant_id: str, dispatch_id: str,
                      claim_token: str, intent_id: str,
                      attempt_number: int, logical_dispatch_id: str,
                      outcome: str, provider_message_ref=None,
                      failure_class=None,
                      dispatch_evidence: dict | None = None) -> None:
    """Record the immutable attempt + project + schedule retry or
    finish. Attempt rows are never rewritten."""
    attempt_id = f"att_{secrets.token_urlsafe(12)}"
    conn.execute(
        """
        INSERT INTO notification.notification_attempt
            (tenant_id, notification_attempt_id,
             notification_intent_id, attempt_number,
             dispatch_evidence, adapter_version, outcome,
             provider_message_ref, failure_class, dispatch_identity,
             completed_at)
        VALUES (%s,%s,%s,%s,%s::jsonb,%s,%s,%s,%s,%s,
                transaction_timestamp())
        """,
        (tenant_id, attempt_id, intent_id, attempt_number,
         json.dumps(dispatch_evidence or {}), ADAPTER_VERSION,
         outcome, provider_message_ref, failure_class,
         logical_dispatch_id))
    if provider_message_ref:
        # Global routing index — the callback binds provider refs
        # back to (tenant, intent) without trusting the payload.
        conn.execute(
            """
            INSERT INTO notification.provider_ref_binding
                (provider_message_ref, tenant_id,
                 notification_intent_id)
            VALUES (%s,%s,%s)
            ON CONFLICT DO NOTHING
            """, (provider_message_ref, tenant_id, intent_id))
    conn.execute(
        """
        UPDATE notification.notification_dispatch_outbox
           SET state='done'
         WHERE tenant_id=%s AND dispatch_id=%s AND claim_token=%s
        """, (tenant_id, dispatch_id, claim_token))
    _recompute_projection(conn, tenant_id, intent_id)

    # Bounded retry: new outbox entry, deterministic backoff.
    if outcome in ("failed", "unknown") and attempt_number < MAX_ATTEMPTS:
        backoff = timedelta(seconds=30 * attempt_number)
        conn.execute(
            """
            INSERT INTO notification.notification_dispatch_outbox
                (tenant_id, dispatch_id, notification_intent_id,
                 logical_dispatch_id, attempt_number,
                 next_attempt_at)
            VALUES (%s,%s,%s,%s,%s, now() + %s)
            """,
            (tenant_id, f"dsp_{secrets.token_urlsafe(12)}", intent_id,
             f"{logical_dispatch_id}:retry:{attempt_number + 1}",
             attempt_number + 1, backoff))


def record_evidence(conn, *, tenant_id: str, intent_id: str,
                    normalized_state: str, attempt_id=None,
                    provider_callback_id=None,
                    provider_message_ref=None,
                    raw_envelope: dict | None = None) -> str | None:
    """Append normalized provider evidence; dedup by callback id;
    reconcile monotonically. Returns evidence_id or None on dupe."""
    evidence_id = f"nev_{secrets.token_urlsafe(12)}"
    cur = conn.execute(
        """
        INSERT INTO notification.notification_provider_evidence
            (tenant_id, notification_evidence_id,
             notification_intent_id, notification_attempt_id,
             normalized_state, provider_callback_id,
             provider_message_ref, raw_envelope)
        VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
        ON CONFLICT (tenant_id, provider_callback_id)
        WHERE provider_callback_id IS NOT NULL
        DO NOTHING
        RETURNING notification_evidence_id
        """,
        (tenant_id, evidence_id, intent_id, attempt_id,
         normalized_state, provider_callback_id,
         provider_message_ref, json.dumps(raw_envelope or {})))
    row = cur.fetchone()
    if row is None:
        return None  # duplicate callback — deduped
    _recompute_projection(conn, tenant_id, intent_id)
    return evidence_id
