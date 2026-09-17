"""Host inventory worker — real implementation.

Claims durable `host_inventory_sync` operations and runs the canonical
`HostInventoryWorker` from the domain package:

  claim -> credential -> egress -> hostgroup.get (anchor visibility)
  -> host.get (bounded snapshot) -> fenced complete
  -> resource upsert + immutable evidence / degradation

Fail-closed: degraded snapshots degrade presence evidence; resources
are never removed on incomplete evidence.
"""

from __future__ import annotations

import logging
import time

import psycopg

from jlmirror_monitoring.host_inventory import HostInventoryWorker
from providers.credentials import EnvCredentialResolver
from providers.egress import DevOutboundAdmission
from providers.zabbix import ZabbixClient
from shared.config import settings
from shared.monitoring_repo import (
    PgHostInventoryRepository,
    list_all_pending_host_inventory,
)

logger = logging.getLogger(__name__)


def _process_pending(conn: psycopg.Connection) -> int:
    pending = list_all_pending_host_inventory(conn)
    processed = 0
    for tenant_id, op_id in pending:
        repo = PgHostInventoryRepository(conn, tenant_id)
        worker = HostInventoryWorker(
            repository=repo,
            credential_resolver=EnvCredentialResolver(),
            outbound_admission=DevOutboundAdmission(),
            host_reader=ZabbixClient(),
        )
        try:
            result = worker.run(op_id)
            processed += 1
            logger.info(
                "inventory %s/%s -> %s/%s hosts=%s complete=%s",
                tenant_id, op_id,
                result.operation_state.value,
                result.operational_evidence_state.value,
                len(result.hosts),
                result.snapshot_complete,
            )
        except ValueError as exc:
            conn.rollback()
            logger.warning("inventory %s skipped: %s", op_id, exc)
        except Exception:
            conn.rollback()
            logger.exception("inventory %s failed unexpectedly", op_id)
    return processed


def run_inventory_worker(poll_interval: int = 10, once: bool = False) -> None:
    """Run the host inventory worker loop (blocking)."""
    dsn = settings.db_dsn
    logger.info("Starting host inventory worker (poll=%ss)", poll_interval)
    with psycopg.connect(dsn, autocommit=False) as conn:
        while True:
            try:
                n = _process_pending(conn)
                if once:
                    logger.info("Processed %s pending inventory ops", n)
                    return
            except Exception:
                logger.exception("inventory worker tick failed")
            time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_inventory_worker()
