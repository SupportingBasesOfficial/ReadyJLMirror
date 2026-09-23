"""Worker entry point — runs all responsibility loops on one process.

Dev consolidation: every pending-work processor runs on a shared
connection in a single tick loop, so `docker compose up worker`
keeps the whole pipeline alive. `--once` runs a single pass —
the verification shape used by the dev E2E.

In production each responsibility runs as its own service; only the
scheduling differs.
"""

from __future__ import annotations

import logging
import sys
import time

import psycopg

from shared import telemetry
from shared.config import settings
from workers.current_state import _process_pending as current_state
from workers.health import _process_pending as health
from workers.history import _process_pending as history
from workers.inventory import _process_pending as inventory
from workers.metrics import _process_pending as metrics
from workers.alerting_transport import _process_pending as alerting_inbox
from workers.outbox_dispatcher import _publish_durable as outbox
from workers.notification_dispatch import (
    _process_pending as notification_dispatch)
from workers.itsm_sync import _process_pending as itsm_sync
from workers.problem_state import _process_pending as problem_state
from workers.reconciliation import _process_pending as reaper
from workers.scheduler import _process_pending as scheduler
from workers.validation import _process_pending as validation

logger = logging.getLogger("workers.run_all")

_PROCESSORS = (
    ("reaper", reaper),         # reap orphans/zombies before scheduling
    ("scheduler", scheduler),   # enqueue due ops first — same tick picks them up
    ("validation", validation),
    ("inventory", inventory),
    ("metrics", metrics),
    ("current_state", current_state),
    ("history", history),
    ("problem_state", problem_state),
    ("health", health),
    ("outbox", outbox),
    ("alerting_inbox", alerting_inbox),
    ("notification_dispatch", notification_dispatch),
    ("itsm_sync", itsm_sync),
)


def tick(conn) -> int:
    """One full pipeline pass — every processor drains its pending work."""
    total = 0
    for name, fn in _PROCESSORS:
        try:
            n = fn(conn)
            if n:
                logger.info("%s processed %s", name, n)
            total += n or 0
        except Exception:
            conn.rollback()
            logger.exception("%s tick failed", name)
    _heartbeat(conn, total)
    return total


def _heartbeat(conn, processed: int) -> None:
    """Durable liveness: one upsert per tick so operators/readiness
    can distinguish a live pipeline from a silently dead one."""
    try:
        conn.execute(
            """
            INSERT INTO monitoring.worker_heartbeat
                (tenant_id, worker_id, last_seen_at, last_processed,
                 tick_count)
            VALUES ('system', 'all', transaction_timestamp(), %s, 1)
            ON CONFLICT (tenant_id, worker_id) DO UPDATE
              SET last_seen_at = transaction_timestamp(),
                  last_processed = EXCLUDED.last_processed,
                  tick_count = monitoring.worker_heartbeat.tick_count + 1
            """,
            (processed,))
        conn.commit()
    except Exception:
        conn.rollback()
        logger.exception("heartbeat failed")


def main() -> None:
    telemetry.configure_structured_logging(settings.log_level)
    once = "--once" in sys.argv
    interval = settings.worker_poll_interval_seconds
    logger.info("workers starting (once=%s, poll=%ss)", once, interval)
    while True:
        try:
            with psycopg.connect(
                    settings.db_dsn, autocommit=False,
                    connect_timeout=10) as conn:
                while True:
                    tick(conn)
                    if once:
                        return
                    time.sleep(interval)
        except psycopg.OperationalError:
            # DB restart/failover — drop the dead connection and
            # re-enter; processors resume from durable outbox state.
            logger.exception("db connection lost; reconnecting")
            if once:
                raise
            time.sleep(interval)


if __name__ == "__main__":
    main()
