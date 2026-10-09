"""Worker entry point — runs all responsibility loops on one process.

Dev consolidation: every pending-work processor runs in a single tick
loop, so `docker compose up worker` keeps the whole pipeline alive.
`--once` runs a single pass — the verification shape used by the dev E2E.

Each processor owns a persistent psycopg connection keyed by name.
A failure in one worker never dirties another's transaction; reconnects
happen lazily on the next tick.

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
from workers.incident_response import _process_pending as incident_response
from workers.problem_state import _process_pending as problem_state
from workers.reconciliation import _process_pending as reaper
from workers.scheduler import _process_pending as scheduler
from workers.validation import _process_pending as validation
from workers.aiops import _process_pending as aiops
from workers.finops import _process_pending as finops
from workers.escalation import _process_pending as escalation
from workers.sla_checker import _process_pending as sla_checker
from workers.automation_runner import _process_pending as automation_runner
from workers.report_sender import _process_pending as report_sender
from workers.cert_checker import _process_pending as cert_checker

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
    ("incident_response", incident_response),
    ("aiops", aiops),
    ("finops", finops),
    ("escalation", escalation),
    ("sla_checker", sla_checker),
    ("automation_runner", automation_runner),
    ("report_sender", report_sender),
    ("cert_checker", cert_checker),
)

# One persistent connection per processor, keyed by name.
# "heartbeat" is also an entry here.
_connections: dict[str, psycopg.Connection] = {}


def _get_conn(name: str, dsn: str) -> psycopg.Connection:
    """Return the live connection for *name*, creating one if absent or closed."""
    conn = _connections.get(name)
    if conn is None or conn.closed:
        conn = psycopg.connect(dsn, autocommit=False, connect_timeout=10)
        _connections[name] = conn
    return conn


def tick(dsn: str) -> int:
    """One full pipeline pass — every processor drains its pending work."""
    total = 0
    for name, fn in _PROCESSORS:
        try:
            conn = _get_conn(name, dsn)
            n = fn(conn)
            if n:
                logger.info("%s processed %s", name, n)
            total += n or 0
        except psycopg.OperationalError:
            # Dead connection — drop it so _get_conn reconnects next tick.
            _connections.pop(name, None)
            logger.exception(
                "%s tick failed — connection dropped, will reconnect next tick",
                name)
        except Exception:
            # Soft failure — roll back this processor's transaction and keep going.
            conn = _connections.get(name)
            if conn is not None:
                try:
                    conn.rollback()
                except Exception:
                    pass
            logger.exception("%s tick failed", name)
    _heartbeat(dsn, total)
    return total


def _heartbeat(dsn: str, processed: int) -> None:
    """Durable liveness: one upsert per tick so operators/readiness
    can distinguish a live pipeline from a silently dead one."""
    conn = _get_conn("heartbeat", dsn)
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
    except psycopg.OperationalError:
        _connections.pop("heartbeat", None)
        logger.exception(
            "heartbeat failed — connection dropped, will reconnect next tick")
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        logger.exception("heartbeat failed")


def main() -> None:
    telemetry.configure_structured_logging(settings.log_level)
    once = "--once" in sys.argv
    interval = settings.worker_poll_interval_seconds
    logger.info("workers starting (once=%s, poll=%ss)", once, interval)
    backoff = interval
    while True:
        try:
            tick(settings.db_dsn)
            backoff = interval
            if once:
                return
            time.sleep(interval)
        except Exception:
            logger.exception("tick loop error; retrying in %ss", backoff)
            if once:
                raise
            time.sleep(backoff)
            backoff = min(backoff * 2, 30)


if __name__ == "__main__":
    main()
