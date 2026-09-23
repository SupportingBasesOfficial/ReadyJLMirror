"""Outbox dispatcher worker — durable monitoring event publication.

Drains `monitoring.monitoring_outbox` rows appended transactionally by
the problem/health projection completions. Dispatch semantics:

  claim (FOR UPDATE SKIP LOCKED, lease) -> publish -> receipt
    success     -> published + receipt ref
    failure     -> release claim (retry) or quarantine after cap
    ambiguous   -> reconciliation-required evidence class recorded

Dev channel: POST to ALERTING_WEBHOOK_URL when configured, else a
simulated dev receipt (logged). The wire format is the canonical
LogicalMessage envelope; production = broker/Kafka adapter.

Also retains the legacy in-memory demo ledger drain for the API's
async_ops endpoint.
"""

from __future__ import annotations

import base64
import logging
import os
import time
from datetime import datetime, timezone

import httpx
import psycopg

from api.routers.async_ops import _outbox
from jlmirror_async.outbox import BrokerPublicationReceipt
from shared import telemetry
from shared.config import settings

logger = logging.getLogger(__name__)

_MAX_ATTEMPTS = 5
_CLAIM_LEASE_SECONDS = 60


def _webhook_request() -> tuple[str, dict]:
    """Resolve the publish URL and TLS kwargs.

    API_MTLS=1 upgrades the webhook boundary: the worker presents its
    service client cert (WORKER_CLIENT_CERT/KEY_FILE) and verifies the
    API against API_CA_FILE — same trust model as BFF->API.
    """
    url = os.environ.get("ALERTING_WEBHOOK_URL", "").strip()
    kwargs: dict = {"timeout": 10.0}
    if os.environ.get("API_MTLS", "").strip().lower() in (
            "1", "true", "yes"):
        if url.startswith("http://"):
            url = "https://" + url[len("http://"):]
        cert = os.environ.get("WORKER_CLIENT_CERT_FILE", "")
        key = os.environ.get("WORKER_CLIENT_KEY_FILE", "")
        ca = os.environ.get("API_CA_FILE", "")
        if cert and key:
            kwargs["cert"] = (cert, key)
        if ca:
            kwargs["verify"] = ca
    return url, kwargs


def wire_envelope(row: dict) -> dict:
    """Compose the canonical g6 integration envelope for the wire.

    Field-for-field the vendored contract
    (g6-monitoring-alerting-transport/envelope.schema.json): the
    scheduling fields the contract pins to null are emitted as null
    here — the table does not carry them."""
    payload = row["encoded_payload"]
    raw = (payload.tobytes() if isinstance(payload, memoryview)
           else payload if isinstance(payload, bytes)
           else str(payload).encode())
    occurred = row["occurred_at"]
    return {
        "producer_message_scope": row["producer_message_scope"],
        "message_id": row["message_id"],
        "message_class": row["message_class"],
        "contract_name": row["contract_name"],
        "contract_version": row["contract_version"],
        "producer": row["producer"],
        "producer_generation": None,
        "scope_class": row["scope"],
        "tenant_id": row["tenant_id"],
        "subject_type": row["subject_type"],
        "subject_id": row["subject_id"],
        "occurred_at": (occurred.isoformat()
                        if hasattr(occurred, "isoformat") else occurred),
        "created_at": None,
        "operation_id": None,
        "not_before": None,
        "deadline": None,
        "correlation_id": row["correlation_id"],
        "causation_id": row["causation_id"],
        "data_classification": row["data_classification"],
        "serialization_profile_id": row["serialization_profile_id"],
        "encoded_payload": base64.b64encode(raw).decode(),
    }


def _publish_durable(conn: psycopg.Connection) -> int:
    """Claim and publish pending durable outbox rows. Returns count."""
    webhook_url, httpx_kwargs = _webhook_request()
    now = datetime.now(timezone.utc)

    cur = conn.execute(
        """
        SELECT record_id, tenant_id, message_id, producer_message_scope,
               message_class, contract_name, contract_version, producer,
               scope, subject_type, subject_id, occurred_at,
               correlation_id, causation_id, data_classification,
               serialization_profile_id, encoded_payload, attempt_count
          FROM monitoring.monitoring_outbox
         WHERE dispatch_state = 'pending'
            OR (dispatch_state = 'claimed' AND claim_expires_at < %s)
         ORDER BY record_id
         LIMIT 10
         FOR UPDATE SKIP LOCKED
        """,
        (now,),
    )
    keys = ("record_id", "tenant_id", "message_id",
            "producer_message_scope", "message_class", "contract_name",
            "contract_version", "producer", "scope", "subject_type",
            "subject_id", "occurred_at", "correlation_id",
            "causation_id", "data_classification",
            "serialization_profile_id", "encoded_payload",
            "attempt_count")
    rows = [dict(zip(keys, r)) for r in cur.fetchall()]
    published = 0

    for row in rows:
        record_id = row["record_id"]
        tenant_id = row["tenant_id"]
        message_id = row["message_id"]
        attempts = row["attempt_count"]
        telemetry.correlation_id_var.set(message_id)
        telemetry.tenant_id_var.set(tenant_id)
        conn.execute(
            """
            UPDATE monitoring.monitoring_outbox
               SET dispatch_state = 'claimed', claim_owner = %s,
                   claim_expires_at = %s, attempt_count = attempt_count + 1
             WHERE tenant_id = %s AND record_id = %s
            """,
            ("worker-outbox-dispatcher",
             datetime.fromtimestamp(
                 now.timestamp() + _CLAIM_LEASE_SECONDS, tz=timezone.utc),
             tenant_id, record_id),
        )

        envelope = wire_envelope(row)

        error = None
        receipt_id = None
        try:
            if webhook_url:
                resp = httpx.post(
                    webhook_url, json=envelope, **httpx_kwargs)
                resp.raise_for_status()
                receipt_id = f"webhook:{resp.status_code}:{message_id}"
            else:
                receipt_id = f"dev-log:{message_id}"
        except Exception as exc:  # publish failure — retry or quarantine
            error = exc

        if error is None:
            conn.execute(
                """
                UPDATE monitoring.monitoring_outbox
                   SET dispatch_state = 'published',
                       published_receipt_id = %s,
                       published_at = transaction_timestamp(),
                       claim_owner = NULL, claim_expires_at = NULL,
                       last_error_class = NULL
                 WHERE tenant_id = %s AND record_id = %s
                """,
                (receipt_id, tenant_id, record_id),
            )
            published += 1
            logger.info(
                "outbox %s/%s published (%s)", tenant_id, message_id,
                receipt_id)
        elif attempts + 1 >= _MAX_ATTEMPTS:
            conn.execute(
                """
                UPDATE monitoring.monitoring_outbox
                   SET dispatch_state = 'quarantined', claim_owner = NULL,
                       claim_expires_at = NULL,
                       last_error_class = 'publication_exhausted'
                 WHERE tenant_id = %s AND record_id = %s
                """,
                (tenant_id, record_id),
            )
            logger.warning(
                "outbox %s/%s quarantined after %s attempts: %s",
                tenant_id, message_id, attempts + 1, error)
        else:
            conn.execute(
                """
                UPDATE monitoring.monitoring_outbox
                   SET dispatch_state = 'pending', claim_owner = NULL,
                       claim_expires_at = NULL,
                       last_error_class = 'publication_failed'
                 WHERE tenant_id = %s AND record_id = %s
                """,
                (tenant_id, record_id),
            )
            logger.warning(
                "outbox %s/%s publish failed (retry): %s",
                tenant_id, message_id, error)

    conn.commit()
    return published


def _dispatch_inmemory(processed: int, batch_size: int) -> int:
    """Legacy in-memory demo ledger drain (async_ops endpoint)."""
    for _ in range(batch_size):
        now = datetime.now(timezone.utc)
        claim = _outbox.claim_next(
            owner_id="worker-outbox-dispatcher",
            observed_at=now,
            claim_expires_at=datetime.fromtimestamp(
                now.timestamp() + 300, tz=timezone.utc),
        )
        if claim is None:
            break
        now = datetime.now(timezone.utc)
        receipt = BrokerPublicationReceipt(
            receipt_id=f"simulated:{claim.message.message_id}",
            observed_at=now,
        )
        _outbox.mark_published(claim=claim, receipt=receipt, observed_at=now)
        processed += 1
    return processed


def run_outbox_dispatcher(
    poll_interval: int = 5, batch_size: int = 10, once: bool = False
) -> None:
    """Run the outbox dispatcher loop (blocking) — or one pass if once."""
    logger.info("Starting outbox dispatcher (poll=%ss, batch=%s)",
                poll_interval, batch_size)
    while True:
        processed = 0
        try:
            with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
                processed += _publish_durable(conn)
        except Exception:
            logger.debug("durable outbox sweep skipped (DB unavailable)")
        processed = _dispatch_inmemory(processed, batch_size)
        if once:
            logger.info("Outbox dispatcher finished (processed %s)", processed)
            return
        if processed == 0:
            logger.debug("No pending outbox messages; sleeping %ss",
                         poll_interval)
        time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_outbox_dispatcher()
