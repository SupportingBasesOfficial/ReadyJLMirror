"""Worker entry point — runs all workers sequentially.

In production, each worker would run as a separate process. In
development, this runs them sequentially for quick verification.
"""

from __future__ import annotations

import logging

from workers.outbox_dispatcher import run_outbox_dispatcher
from workers.reconciliation import run_reconciliation_worker
from workers.validation import run_validation_worker

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def main() -> None:
    """Run all workers sequentially (dev mode)."""
    logger.info("=== ReadyJLMirror workers starting (dev mode) ===")
    run_outbox_dispatcher(poll_interval=2, batch_size=3)
    # Validation worker needs a live DB; run one pass when available.
    try:
        run_validation_worker(poll_interval=2, once=True)
    except Exception as exc:
        logger.warning("validation worker skipped (DB unavailable): %s", exc)
    run_reconciliation_worker(poll_interval=2, batch_size=2)
    logger.info("=== All workers finished ===")


if __name__ == "__main__":
    main()
