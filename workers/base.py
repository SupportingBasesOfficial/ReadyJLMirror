"""ResilientWorker — base class for standalone worker loops.

Each subclass implements process_pending(conn) -> int.
run() handles: fresh connection per tick, exponential backoff on
psycopg.OperationalError, rollback + continue on soft exceptions,
and once=True for single-pass test runs.
"""

from __future__ import annotations

import logging
import time
from abc import ABC, abstractmethod

import psycopg

from shared.config import settings

logger = logging.getLogger(__name__)

_MAX_BACKOFF = 300  # 5 min cap on reconnect delay


class ResilientWorker(ABC):
    name: str = "worker"
    default_poll_interval: int = 10

    @abstractmethod
    def process_pending(self, conn: psycopg.Connection) -> int:
        """Process one batch. Return count of items handled."""

    def run(self, poll_interval: int | None = None, once: bool = False) -> None:
        interval = poll_interval if poll_interval is not None else self.default_poll_interval
        backoff = interval
        logger.info("%s starting (poll=%ss)", self.name, interval)
        while True:
            try:
                with psycopg.connect(
                    settings.db_dsn, autocommit=False, connect_timeout=10
                ) as conn:
                    try:
                        n = self.process_pending(conn)
                    except psycopg.OperationalError:
                        raise  # let outer handler backoff + reconnect
                    except Exception:
                        try:
                            conn.rollback()
                        except Exception:
                            pass
                        logger.exception("%s tick failed", self.name)
                        n = 0
                    else:
                        if n:
                            logger.info("%s processed %s item(s)", self.name, n)
                backoff = interval  # connected ok; reset backoff
            except psycopg.OperationalError:
                logger.exception(
                    "%s: DB error, retrying in %ss", self.name, backoff
                )
                if once:
                    raise
                time.sleep(backoff)
                backoff = min(backoff * 2, _MAX_BACKOFF)
                continue
            if once:
                return
            time.sleep(interval)
