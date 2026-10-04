"""G9 notification dispatch worker — claims the durable outbox,
runs the WhatsApp adapter attempt, records immutable attempt +
normalized evidence, recomputes the delivery projection.
At-least-once safe: dispatch_identity dedups replay.

G20 integration: before dispatching, checks g20_is_in_maintenance() for
the source that generated the alert.  A suppressed source releases the
dispatch so a future cycle retries when the window expires.

G21 integration: before dispatching, checks g21_is_snoozed() for the
alert itself.  A snoozed alert releases the dispatch so a future cycle
retries when the snooze expires.
"""

from __future__ import annotations

import logging
import secrets
import time

import psycopg

from providers.email import EmailError, send_message as send_email
from providers.slack import SlackError, send_message as send_slack
from providers.whatsapp import WhatsAppError, send_message as send_whatsapp
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
                SELECT ni.destination_ref, ni.payload_ref,
                       a.monitoring_source_id, ni.alert_id,
                       ni.channel_class
                  FROM notification.notification_intent ni
                  JOIN alerting.alert a
                    ON a.tenant_id = ni.tenant_id
                   AND a.alert_id  = ni.alert_id
                 WHERE ni.tenant_id=%s AND ni.notification_intent_id=%s
                """, (tenant_id, intent_id))
            row_data = cur.fetchone()
            if row_data is None:
                conn.rollback()
                logger.warning("notification_intent %s not found — skipping", intent_id)
                continue
            dest, payload_ref, source_id, alert_id, channel_class = row_data

            # G20: suppress delivery during active maintenance window
            maint_cur = conn.execute(
                "SELECT monitoring.g20_is_in_maintenance(%s, %s)",
                (tenant_id, source_id))
            if maint_cur.fetchone()[0]:
                conn.rollback()
                logger.info(
                    "notification %s skipped — source %s in maintenance window",
                    intent_id, source_id)
                continue

            # G21: suppress delivery while alert is snoozed
            snooze_cur = conn.execute(
                "SELECT alerting.g21_is_snoozed(%s, %s)",
                (tenant_id, alert_id))
            if snooze_cur.fetchone()[0]:
                conn.rollback()
                logger.info(
                    "notification %s skipped — alert %s is snoozed",
                    intent_id, alert_id)
                continue

            try:
                if channel_class == "email_smtp@1":
                    res = send_email(
                        destination_ref=dest,
                        template_name=payload_ref,
                        correlation_id=logical_id)
                elif channel_class == "slack@1":
                    res = send_slack(
                        destination_ref=dest,
                        template_name=payload_ref,
                        correlation_id=logical_id)
                else:
                    res = send_whatsapp(
                        destination_ref=dest,
                        template_name=payload_ref,
                        correlation_id=logical_id)
                outcome = "provider_accepted"
                provider_ref = res["provider_message_ref"]
                failure = None
                evidence = {"provider_status":
                            res["raw"]["provider_status"]}
            except (WhatsAppError, EmailError, SlackError) as exc:
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
    while True:
        try:
            with psycopg.connect(dsn, autocommit=False,
                                 connect_timeout=10) as conn:
                while True:
                    try:
                        _process_pending(conn)
                    except psycopg.OperationalError:
                        logger.warning("notification dispatch: DB connection lost, reconnecting")
                        break
                    except Exception:
                        conn.rollback()
                        logger.exception("notification dispatch cycle failed")
                    if once:
                        return
                    time.sleep(poll_interval)
        except Exception:
            logger.exception("notification dispatch: failed to connect to DB")
        if once:
            return
        time.sleep(poll_interval)
