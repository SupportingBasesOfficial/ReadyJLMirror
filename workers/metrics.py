"""Metric definition worker — real implementation.

Claims durable `metric_definition_poll` operations and runs the
canonical `MetricDefinitionWorker` from the domain package:

  claim -> credential -> egress -> hostgroup.get -> item.get
  -> fenced complete -> definition upsert + immutable evidence
  -> unseen definitions retire (poll-generation ordered)

Poll ordering: each op claims (epoch, generation); the source must
still sit at the predecessor generation on completion.
"""

from __future__ import annotations

import logging
import time

import psycopg

from jlmirror_monitoring.metric_definitions import MetricDefinitionWorker
from providers.credentials import EnvCredentialResolver
from providers.egress import DevOutboundAdmission
from providers.zabbix import ZabbixClient
from shared.config import settings
from shared.monitoring_repo import (
    PgMetricDefinitionRepository,
    list_all_pending_metric_polls,
)

logger = logging.getLogger(__name__)


def _process_pending(conn: psycopg.Connection) -> int:
    pending = list_all_pending_metric_polls(conn)
    processed = 0
    for tenant_id, op_id in pending:
        repo = PgMetricDefinitionRepository(conn, tenant_id)
        worker = MetricDefinitionWorker(
            repository=repo,
            credential_resolver=EnvCredentialResolver(),
            outbound_admission=DevOutboundAdmission(),
            item_reader=ZabbixClient(),
        )
        try:
            result = worker.run(op_id)
            processed += 1
            logger.info(
                "metric poll %s/%s -> %s/%s items=%s complete=%s",
                tenant_id, op_id,
                result.operation_state.value,
                result.operational_evidence_state.value,
                len(result.items),
                result.snapshot_complete,
            )
        except ValueError as exc:
            logger.warning("metric poll %s skipped: %s", op_id, exc)
        except Exception:
            logger.exception("metric poll %s failed unexpectedly", op_id)
    return processed


def run_metrics_worker(poll_interval: int = 10, once: bool = False) -> None:
    """Run the metric definition worker loop (blocking)."""
    dsn = settings.db_dsn
    logger.info("Starting metric definition worker (poll=%ss)", poll_interval)
    with psycopg.connect(dsn, autocommit=False) as conn:
        while True:
            try:
                n = _process_pending(conn)
                if once:
                    logger.info("Processed %s pending metric polls", n)
                    return
            except Exception:
                logger.exception("metrics worker tick failed")
            time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_metrics_worker()
