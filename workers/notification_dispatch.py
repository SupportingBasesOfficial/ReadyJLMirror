"""G9 notification dispatch worker — claims the durable outbox,
runs the WhatsApp adapter attempt, records immutable attempt +
normalized evidence, recomputes the delivery projection.
At-least-once safe: dispatch_identity dedups replay.
"""

from __future__ import annotations

import logging
import secrets
import time

import psycopg

from providers.whatsapp import WhatsAppError, send_message
from shared.config import settings
from shared import notification

logger = logging.getLogger(__name__)


def _process_pending(conn: psycopg.Connection) -> int:
    processed = 0
    while True:
        token = f"claim_{secrets.token_urlsafe(12)}"
        row = notification.claim_dispatch(conn, claim_token=token)
        if row is None:
            conn.rollback()          # release SKIP LOCKED snapshot
            break
        (tenant_id, dispatch_id, intent_id, attempt_no,
         logical_id) = row
        try:
            conn.execute(
                "SELECT set_config('jlmirror.tenant_id', %s, false)",
                (tenant_id,))
            cur = conn.execute(
                """
                SELECT destination_ref, payload_ref
                  FROM notification.notification_intent
                 WHERE tenant_id=%s AND notification_intent_id=%s
                """, (tenant_id, intent_id))
            dest, payload_ref = cur.fetchone()
            try:
                res = send_message(
                    destination_ref=dest, template_name=payload_ref,
                    correlation_id=logical_id)
                outcome = "provider_accepted"   # 2xx = accepted only
                provider_ref = res["provider_message_ref"]
                failure = None
                evidence = {"provider_status":
                            res["raw"]["provider_status"]}
            except WhatsAppError as exc:
                outcome = "unknown" if "transport" in str(exc) \
                    else "failed"
                provider_ref = None
                failure = str(exc)[:128]
                evidence = {"error": str(exc)[:256]}
            notification.complete_dispatch(
                conn, tenant_id=tenant_id, dispatch_id=dispatch_id,
                claim_token=token, intent_id=intent_id,
                attempt_number=attempt_no,
                logical_dispatch_id=logical_id, outcome=outcome,
                provider_message_ref=provider_ref,
                failure_class=failure, dispatch_evidence=evidence)
            # Provider acceptance is itself normalized evidence.
            if provider_ref:
                notification.record_evidence(
                    conn, tenant_id=tenant_id, intent_id=intent_id,
                    normalized_state="provider_accepted",
                    attempt_id=None, provider_message_ref=provider_ref,
                    raw_envelope={"provider_status":
                                  evidence.get("provider_status")})
            conn.commit()
            processed += 1
            logger.info("notification %s attempt %s -> %s",
                        intent_id, attempt_no, outcome)
        except Exception:
            conn.rollback()
            logger.exception("notification dispatch %s failed",
                             dispatch_id)
    return processed


def run_notification_dispatch_worker(poll_interval: int = 10,
                                     once: bool = False) -> None:
    dsn = settings.db_dsn
    logger.info("Starting notification dispatch worker (poll=%ss)",
                poll_interval)
    with psycopg.connect(dsn, autocommit=False) as conn:
        while True:
            try:
                _process_pending(conn)
            except Exception:
                conn.rollback()
                logger.exception("notification dispatch cycle failed")
            if once:
                return
            time.sleep(poll_interval)
