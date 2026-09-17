"""Metric history worker — real implementation.

Two responsibilities per tick:

  1. Drain pending `metric_history_sync` ops: fenced claim -> credential ->
     egress -> canonical `read_metric_history_window` (history.get per value
     type, bounded window) -> fenced complete. Raw provider rows are captured
     through a recording reader wrapper; acceptance identity and canonical
     value parsing are repository-bound per the canonical design.

  2. Project pending acceptance envelopes into immutable `metric_observation`
     — the History projection obligation carried by current-state acceptances
     (`history_projection_state='pending'`).
"""

from __future__ import annotations

import logging
import secrets
import time
from typing import Sequence

import psycopg

from jlmirror_monitoring.metric_history import (
    MetricHistoryClaim,
    ZabbixHistoryEvidence,
    read_metric_history_window,
)
from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
    ResolvedZabbixCredential,
)
from providers.credentials import EnvCredentialResolver
from providers.egress import DevOutboundAdmission
from providers.zabbix import ZabbixClient
from shared.config import settings
from shared.monitoring_repo import (
    PgMetricHistoryRepository,
    list_all_pending_history_syncs,
    list_source_ids_with_pending_projection,
)

logger = logging.getLogger(__name__)


class _RecordingHistoryReader:
    """ZabbixHistoryReader wrapper that retains raw provider rows so the
    repository-bound acceptance/projection can consume them after the
    canonical collect has validated the response shape."""

    def __init__(self, inner: ZabbixClient) -> None:
        self._inner = inner
        self.rows: list[ZabbixHistoryEvidence] = []

    def read_history(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        *,
        history_value_type: int,
        itemids: Sequence[str],
        time_from: int,
        time_till: int,
        max_rows: int,
    ) -> Sequence[ZabbixHistoryEvidence]:
        rows = tuple(
            self._inner.read_history(
                endpoint,
                credential,
                history_value_type=history_value_type,
                itemids=itemids,
                time_from=time_from,
                time_till=time_till,
                max_rows=max_rows,
            )
        )
        self.rows.extend(rows)
        return rows


def _process_pending(conn: psycopg.Connection) -> int:
    processed = 0

    for tenant_id, op_id in list_all_pending_history_syncs(conn):
        repo = PgMetricHistoryRepository(conn, tenant_id)
        reader = _RecordingHistoryReader(ZabbixClient())
        try:
            claim: MetricHistoryClaim = repo.claim_metric_history(
                op_id, claim_token=f"mon-claim_{secrets.token_urlsafe(24)}"
            )
            result = read_metric_history_window(
                claim,
                credential_resolver=EnvCredentialResolver(),
                outbound_admission=DevOutboundAdmission(),
                reader=reader,
            )
            persisted = repo.complete_metric_history(
                claim, result, raw_rows=reader.rows
            )
            processed += 1
            logger.info(
                "metric history %s/%s -> %s/%s coverage=%s rows=%s",
                tenant_id, op_id,
                persisted.operation_state.value,
                persisted.operational_evidence_state.value,
                persisted.coverage_state.value,
                len(reader.rows),
            )
        except ValueError as exc:
            conn.rollback()
            logger.warning("metric history %s skipped: %s", op_id, exc)
        except Exception:
            conn.rollback()
            logger.exception("metric history %s failed unexpectedly", op_id)

    for tenant_id, source_id in list_source_ids_with_pending_projection(conn):
        repo = PgMetricHistoryRepository(conn, tenant_id)
        try:
            projected = repo.project_pending_observations(source_id)
            if projected:
                logger.info(
                    "history projection %s/%s -> %s envelopes projected",
                    tenant_id, source_id, projected,
                )
        except Exception:
            conn.rollback()
            logger.exception(
                "history projection %s/%s failed", tenant_id, source_id
            )

    return processed


def run_history_worker(poll_interval: int = 30, once: bool = False) -> None:
    """Run the metric history worker loop (blocking)."""
    dsn = settings.db_dsn
    logger.info("Starting metric history worker (poll=%ss)", poll_interval)
    with psycopg.connect(dsn, autocommit=False) as conn:
        while True:
            try:
                n = _process_pending(conn)
                if once:
                    logger.info("Processed %s pending history syncs", n)
                    return
            except Exception:
                logger.exception("history worker tick failed")
            time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_history_worker()
