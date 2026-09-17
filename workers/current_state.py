"""Metric current-state worker — real implementation.

Claims durable `current_state_poll` operations and runs the canonical
`MetricCurrentStateWorker` from the domain package:

  claim (targets from current definitions)
  -> credential -> egress -> item.get (lastvalue/lastclock/lastns)
  -> canonical value parsing -> fenced complete
  -> observation acceptance + projection advance + transitions
"""

from __future__ import annotations

import logging
import time

import psycopg

from jlmirror_monitoring.metric_current_state import MetricCurrentStateWorker
from providers.credentials import EnvCredentialResolver
from providers.egress import DevOutboundAdmission
from providers.zabbix import ZabbixClient
from shared.config import settings
from shared.monitoring_repo import (
    PgMetricCurrentStateRepository,
    list_all_pending_current_polls,
)

logger = logging.getLogger(__name__)


def _process_pending(conn: psycopg.Connection) -> int:
    pending = list_all_pending_current_polls(conn)
    processed = 0
    for tenant_id, op_id in pending:
        repo = PgMetricCurrentStateRepository(conn, tenant_id)
        worker = MetricCurrentStateWorker(
            repository=repo,
            credential_resolver=EnvCredentialResolver(),
            outbound_admission=DevOutboundAdmission(),
            reader=ZabbixClient(),
        )
        try:
            result = worker.run(op_id)
            processed += 1
            logger.info(
                "current-state poll %s/%s -> %s/%s observations=%s",
                tenant_id, op_id,
                result.operation_state.value,
                result.operational_evidence_state.value,
                len(result.accepted_observations),
            )
        except ValueError as exc:
            conn.rollback()
            logger.warning("current-state poll %s skipped: %s", op_id, exc)
        except Exception:
            conn.rollback()
            logger.exception("current-state poll %s failed unexpectedly", op_id)
    return processed


def run_current_state_worker(poll_interval: int = 10, once: bool = False) -> None:
    """Run the metric current-state worker loop (blocking)."""
    dsn = settings.db_dsn
    logger.info("Starting metric current-state worker (poll=%ss)", poll_interval)
    with psycopg.connect(dsn, autocommit=False) as conn:
        while True:
            try:
                n = _process_pending(conn)
                if once:
                    logger.info("Processed %s pending current-state polls", n)
                    return
            except Exception:
                logger.exception("current-state worker tick failed")
            time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_current_state_worker()
