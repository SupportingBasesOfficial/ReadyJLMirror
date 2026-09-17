"""Outbox dispatcher worker.

Claims pending outbox messages and simulates dispatch. In production
this would publish to the selected broker (Kafka, per OPEN-EVT-001)
through the anti-corruption layer. In development, it logs and marks
published.
"""

from __future__ import annotations

import logging
import time

from app.auth import utcnow
from app.routers.async_ops import _outbox
from jlmirror_async.outbox import BrokerPublicationReceipt

logger = logging.getLogger(__name__)


def run_outbox_dispatcher(poll_interval: int = 5, batch_size: int = 10) -> None:
    """Run the outbox dispatcher loop (blocking)."""
    logger.info("Starting outbox dispatcher (poll=%ss, batch=%s)", poll_interval, batch_size)
    from datetime import timedelta

    processed = 0
    while processed < batch_size:
        now = utcnow()
        claim = _outbox.claim_next(
            owner_id="worker-outbox-dispatcher",
            observed_at=now,
            claim_expires_at=now + timedelta(minutes=5),
        )
        if claim is None:
            logger.info("No pending outbox messages; sleeping %ss", poll_interval)
            time.sleep(poll_interval)
            continue

        logger.info("Dispatching outbox record %s: %s", claim.record_id, claim.message.message_id)

        # Dev mode: simulate successful publication
        receipt = BrokerPublicationReceipt(
            receipt_id=f"receipt-dev-{claim.record_id}",
            observed_at=now,
        )
        _outbox.mark_published(claim=claim, receipt=receipt, observed_at=now)
        processed += 1
        logger.info("Published outbox record %s", claim.record_id)

    logger.info("Outbox dispatcher finished (processed %s messages)", processed)
