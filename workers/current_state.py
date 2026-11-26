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
import psycopg

from jlmirror_monitoring.metric_current_state import MetricCurrentStateWorker
from providers.credentials import ChainedCredentialResolver
from providers.egress import DevOutboundAdmission
from providers.zabbix import ZabbixClient
from shared.config import settings
from shared import telemetry
from shared.monitoring_repo import (
    PgMetricCurrentStateRepository,
    list_all_pending_current_polls,
)
from workers.base import ResilientWorker

logger = logging.getLogger(__name__)


def _process_pending(conn: psycopg.Connection) -> int:
    pending = list_all_pending_current_polls(conn)
    processed = 0
    for tenant_id, op_id in pending:
        telemetry.correlation_id_var.set(op_id)
        telemetry.tenant_id_var.set(tenant_id)
        repo = PgMetricCurrentStateRepository(conn, tenant_id)
        worker = MetricCurrentStateWorker(
            repository=repo,
            credential_resolver=ChainedCredentialResolver(),
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


class CurrentStateWorker(ResilientWorker):
    name = "current_state"
    default_poll_interval = 10

    def process_pending(self, conn: psycopg.Connection) -> int:
        return _process_pending(conn)


def run_current_state_worker(poll_interval: int = 10, once: bool = False) -> None:
    """Run the metric current-state worker loop (blocking)."""
    logger.info("Starting metric current-state worker (poll=%ss)", poll_interval)
    CurrentStateWorker().run(poll_interval=poll_interval, once=once)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_current_state_worker()
