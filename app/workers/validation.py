"""Validation worker — monitoring source validation.

In production, this worker resolves credentials, obtains egress
admission, and validates monitoring sources against their providers
(e.g. Zabbix hostgroup.get). In development, it logs a placeholder.
"""

from __future__ import annotations

import logging
import time

logger = logging.getLogger(__name__)


def run_validation_worker(poll_interval: int = 10, batch_size: int = 5) -> None:
    """Run the validation worker loop (blocking, dev placeholder)."""
    logger.info("Starting validation worker (poll=%ss, batch=%s)", poll_interval, batch_size)
    for i in range(batch_size):
        logger.info("Validation tick %s: no monitoring sources to validate in dev mode", i + 1)
        time.sleep(poll_interval)
    logger.info("Validation worker finished")
