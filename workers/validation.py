"""Validation worker — real implementation.

Claims durable `validation_and_initial_sync` operations and runs the
canonical `InitialValidationWorker` from the domain package:

  claim -> CredentialResolver -> OutboundAdmission -> hostgroup.get
  -> fenced complete (source generation + revisions must be current)

Adapters:
  - EnvCredentialResolver (dev) — OpenBao in production
  - DevOutboundAdmission (dev) — governed egress policy in production
  - ZabbixClient — real JSON-RPC hostgroup.get

No retry cadence is selected here: failed/degraded validation becomes
durable `reconciliation_required` per the accepted semantics.
"""

from __future__ import annotations

import logging
import time

import psycopg

from jlmirror_monitoring.validation_worker import InitialValidationWorker
from providers.credentials import EnvCredentialResolver
from providers.egress import DevOutboundAdmission
from providers.zabbix import ZabbixClient
from shared.config import settings
from shared.monitoring_repo import (
    PgValidationRepository,
    list_all_pending_validations,
)

logger = logging.getLogger(__name__)


def _process_pending(conn: psycopg.Connection) -> int:
    """Drain all pending validations once. Returns processed count."""
    pending = list_all_pending_validations(conn)
    processed = 0
    for tenant_id, op_id in pending:
        repo = PgValidationRepository(conn, tenant_id)
        worker = InitialValidationWorker(
            repository=repo,
            credential_resolver=EnvCredentialResolver(),
            outbound_admission=DevOutboundAdmission(),
            host_group_reader=ZabbixClient(),
        )
        try:
            result = worker.run(op_id)
            processed += 1
            logger.info(
                "validation %s/%s -> %s/%s",
                tenant_id, op_id,
                result.operation_state.value,
                result.operational_evidence_state.value,
            )
        except ValueError as exc:
            # Not claimable (raced/stale) — leave durable state; the
            # operation remains pending for a later claim or reconciliation.
            logger.warning("validation %s skipped: %s", op_id, exc)
        except Exception:
            logger.exception("validation %s failed unexpectedly", op_id)
    return processed


def run_validation_worker(poll_interval: int = 10, once: bool = False) -> None:
    """Run the validation worker loop (blocking)."""
    dsn = settings.db_dsn
    logger.info("Starting validation worker (poll=%ss)", poll_interval)
    with psycopg.connect(dsn, autocommit=False) as conn:
        while True:
            try:
                n = _process_pending(conn)
                if once:
                    logger.info("Processed %s pending validations", n)
                    return
            except Exception:
                logger.exception("validation worker tick failed")
            time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_validation_worker()
