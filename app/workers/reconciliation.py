"""Reconciliation worker — cross-authority reconciliation.

In production, this worker processes reconciliation-required states
across authority boundaries. In development, it logs a placeholder.
"""

from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)


def run_reconciliation_worker(poll_interval: int = 15, batch_size: int = 3) -> None:
    """Run the reconciliation worker loop (blocking, dev placeholder)."""
    logger.info("Starting reconciliation worker (poll=%ss, batch=%s)", poll_interval, batch_size)
    for i in range(batch_size):
        logger.info("Reconciliation tick %s: no pending reconciliations in dev mode", i + 1)
        time.sleep(poll_interval)
    logger.info("Reconciliation worker finished")
