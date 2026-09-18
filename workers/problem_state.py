"""Problem state worker — real implementation.

Per pending `problem_state_sync` op:

  1. Volatile recovery admission is re-established for the source's
     current problem poll epoch (fail-closed authority gate).
  2. Credential + egress resolved once; trigger.get selectHosts refreshes
     the trigger->resource bindings so claim associations cover newly
     created triggers.
  3. Fenced claim -> canonical `collect_problem_state` (problem.get active
     problems, bounded, dedup eventid, association binding) -> recovery
     evidence (problem.get r_eventid/r_clock for known problems) ->
     fenced complete: stable canonical problem_id binding, projection +
     immutable transitions, provider_recovery / authoritative_negative.
"""

from __future__ import annotations

import logging
import secrets
import time
from dataclasses import replace
from typing import Sequence

import psycopg

from jlmirror_monitoring.problem_state import (
    ProblemStateClaim,
    ZabbixProblemEvidence,
    ZabbixRecoveryEvidence,
    collect_problem_state,
)
from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
    ResolvedZabbixCredential,
)
from providers.credentials import ChainedCredentialResolver
from providers.egress import DevOutboundAdmission
from providers.zabbix import ZabbixClient
from shared.config import settings
from shared import telemetry
from shared.monitoring_repo import (
    PgProblemStateRepository,
    list_all_pending_problem_syncs,
)

logger = logging.getLogger(__name__)


class _RecordingProblemReader:
    """ZabbixProblemReader wrapper that retains raw provider rows — the
    provider_trigger_ref (row.objectid) is needed repository-side to bind
    the stable canonical problem identity."""

    def __init__(self, inner: ZabbixClient) -> None:
        self._inner = inner
        self.rows: list[ZabbixProblemEvidence] = []

    def read_active_problems(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        *,
        max_rows: int,
    ) -> tuple[Sequence[ZabbixProblemEvidence], bool]:
        rows, complete = self._inner.read_active_problems(
            endpoint, credential, max_rows=max_rows
        )
        self.rows = list(rows)
        return self.rows, complete

    def read_recovery_events(
        self,
        endpoint: AdmittedProviderEndpoint,
        credential: ResolvedZabbixCredential,
        problem_eventids: Sequence[str],
        *,
        max_rows: int,
    ) -> Sequence[ZabbixRecoveryEvidence]:
        return self._inner.read_recovery_events(
            endpoint, credential, problem_eventids, max_rows=max_rows
        )


def _process_pending(conn: psycopg.Connection) -> int:
    processed = 0
    resolver = ChainedCredentialResolver()
    admission = DevOutboundAdmission()
    client = ZabbixClient()

    for tenant_id, op_id in list_all_pending_problem_syncs(conn):
        telemetry.correlation_id_var.set(op_id)
        telemetry.tenant_id_var.set(tenant_id)
        repo = PgProblemStateRepository(conn, tenant_id)
        reader = _RecordingProblemReader(client)
        try:
            source_id, generation = repo.peek_op_source(op_id)

            # Recovery admission is volatile and fail-closed per epoch —
            # must exist before the claim gate.
            repo.reestablish_problem_admission(source_id, generation)

            claim: ProblemStateClaim = repo.claim_problem_state(
                op_id,
                claim_token=f"mon-claim_{secrets.token_urlsafe(24)}",
            )

            # Scope provider reads to the source's host groups —
            # problem.get/trigger.get must not return out-of-scope
            # hosts (their problems can never associate -> the
            # collector would fail closed forever).
            client.scope_group_ids = repo.source_scope_group_ids(
                claim.monitoring_source_id) or None

            credential = resolver.resolve_zabbix_api_token(
                claim.credential_binding_ref)
            endpoint = admission.admit_zabbix_api(
                claim.provider_configuration)

            # Trigger->host association evidence refreshed before collect so
            # associations cover triggers created since the last poll.
            pairs = client.read_trigger_associations(
                endpoint, credential, max_rows=5000)
            repo.refresh_trigger_bindings(
                claim.monitoring_source_id,
                claim.source_instance_generation,
                pairs,
            )
            claim = replace(
                claim,
                associations=repo.trigger_associations(
                    claim.monitoring_source_id,
                    claim.source_instance_generation),
            )

            result = collect_problem_state(
                claim,
                credential_resolver=resolver,
                outbound_admission=admission,
                reader=reader,
            )

            recoveries: list[ZabbixRecoveryEvidence] = []
            if result.succeeded:
                recoveries = list(client.read_recovery_events(
                    endpoint,
                    credential,
                    repo.known_problem_eventids(
                        claim.monitoring_source_id,
                        claim.source_instance_generation),
                    max_rows=20_000,
                ))

            persisted = repo.complete_problem_state(
                claim, result, raw_rows=reader.rows, recoveries=recoveries)
            processed += 1
            logger.info(
                "problem state %s/%s -> %s/%s problems=%s recoveries=%s",
                tenant_id, op_id,
                persisted.operation_state.value,
                persisted.operational_evidence_state.value,
                len(result.problems), len(recoveries),
            )
        except ValueError as exc:
            conn.rollback()
            logger.warning("problem state %s skipped: %s", op_id, exc)
        except Exception:
            conn.rollback()
            logger.exception("problem state %s failed unexpectedly", op_id)

    return processed


def run_problem_state_worker(poll_interval: int = 15, once: bool = False) -> None:
    """Run the problem state worker loop (blocking)."""
    dsn = settings.db_dsn
    logger.info("Starting problem state worker (poll=%ss)", poll_interval)
    with psycopg.connect(dsn, autocommit=False) as conn:
        while True:
            try:
                n = _process_pending(conn)
                if once:
                    logger.info("Processed %s pending problem syncs", n)
                    return
            except Exception:
                logger.exception("problem state worker tick failed")
            time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_problem_state_worker()
