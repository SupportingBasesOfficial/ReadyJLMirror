"""Health projection worker — canonical Monitoring-owned derivation.

Health is derived from canonical state only (source currentness,
resource presence/scope, problem snapshot completeness, active problem
severities) — it introduces no provider polling authority. The sweep
runs `derive_health` per resource and persists the projection plus
immutable transitions; 'healthy'/'current' outcomes are also enforced
by the DB projection guard.
"""

from __future__ import annotations

import logging
import time

import psycopg

from shared.config import settings
from shared.monitoring_repo import (
    PgHealthProjectionRepository,
    list_all_monitoring_sources,
)

logger = logging.getLogger(__name__)


def _process_pending(conn: psycopg.Connection) -> int:
    projected = 0
    for tenant_id, source_id in list_all_monitoring_sources(conn):
        repo = PgHealthProjectionRepository(conn, tenant_id)
        try:
            n = repo.project_source_health(source_id)
            projected += n
            if n:
                logger.info(
                    "health projection %s/%s -> %s resources projected",
                    tenant_id, source_id, n,
                )
        except Exception:
            conn.rollback()
            logger.exception(
                "health projection %s/%s failed", tenant_id, source_id)
    return projected


def run_health_worker(poll_interval: int = 15, once: bool = False) -> None:
    """Run the health projection worker loop (blocking)."""
    dsn = settings.db_dsn
    logger.info("Starting health projection worker (poll=%ss)", poll_interval)
    with psycopg.connect(dsn, autocommit=False) as conn:
        while True:
            try:
                n = _process_pending(conn)
                if once:
                    logger.info("Projected health for %s resources", n)
                    return
            except Exception:
                logger.exception("health projection tick failed")
            time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_health_worker()
