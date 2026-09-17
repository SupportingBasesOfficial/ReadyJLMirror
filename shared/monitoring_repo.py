"""Monitoring repositories — PostgreSQL adapters for domain ports.

Implements:
  - Source creation (mirrors monitoring.create_zabbix_source semantics:
    atomic idempotency row + generation + source + pending sync op)
  - `MonitoringValidationRepository` — claim/complete with fencing
    (generation + configuration/scope revisions must still be current
    at completion; stale authority cannot update current evidence)

API-facing helpers are async (psycopg.AsyncConnection). The validation
repository used by the domain `InitialValidationWorker` is synchronous
(psycopg.Connection) because the domain worker invokes ports
synchronously — workers run in their own thread/process.

Direct table access replaces the canonical SECURITY DEFINER functions
for this deployment schema; the invariants enforced by those functions
are preserved in the query predicates and domain dataclass validation.
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets
from typing import Optional, Sequence

from psycopg import AsyncConnection, Connection

from jlmirror_monitoring.source import (
    ConfiguredProviderScope,
    ZabbixProviderConfiguration,
)
from jlmirror_monitoring.validation_worker import (
    InitialValidationClaim,
    InitialValidationResult,
)

logger = logging.getLogger(__name__)


def _opaque(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(24)}"


def fingerprint_request(payload: dict) -> str:
    """SHA-256 fingerprint of a canonical request body."""
    canonical = json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


# ---------------------------------------------------------------------------
# Source creation (async — API path)
# ---------------------------------------------------------------------------


async def create_zabbix_source(
    conn: AsyncConnection,
    *,
    tenant_id: str,
    idempotency_key: str,
    display_name: str,
    provider_instance_ref: str,
    provider_base_url: str,
    credential_binding_ref: str,
    host_group_refs: Sequence[str],
) -> dict:
    """Atomic create-or-observe for a monitoring source.

    Returns {monitoring_source_id, monitoring_sync_operation_id,
             idempotency_state, reused}.
    Raises ValueError('idempotency.key_reused') on fingerprint mismatch.
    """
    scope_json = json.dumps({"host_group_refs": list(host_group_refs)})
    fingerprint = fingerprint_request(
        {
            "display_name": display_name,
            "provider_instance_ref": provider_instance_ref,
            "provider_base_url": provider_base_url,
            "credential_binding_ref": credential_binding_ref,
            "host_group_refs": sorted(host_group_refs),
        }
    )
    source_id = _opaque("mon-src")
    generation = _opaque("mon-gen")
    binding_id = _opaque("mon-bind")
    operation_id = _opaque("mon-sync")

    cur = await conn.execute(
        """
        INSERT INTO monitoring.monitoring_source_create_idempotency
            (tenant_id, idempotency_key, request_fingerprint,
             monitoring_source_id, monitoring_sync_operation_id, state)
        VALUES (%s, %s, %s, %s, %s, 'in_progress')
        ON CONFLICT (tenant_id, idempotency_key) DO NOTHING
        """,
        (tenant_id, idempotency_key, fingerprint, source_id, operation_id),
    )
    if cur.rowcount == 0:
        cur = await conn.execute(
            """
            SELECT request_fingerprint, monitoring_source_id,
                   monitoring_sync_operation_id, state
              FROM monitoring.monitoring_source_create_idempotency
             WHERE tenant_id = %s AND idempotency_key = %s
             FOR UPDATE
            """,
            (tenant_id, idempotency_key),
        )
        row = await cur.fetchone()
        if row[0] != fingerprint:
            raise ValueError("idempotency.key_reused")
        return {
            "monitoring_source_id": row[1],
            "monitoring_sync_operation_id": row[2],
            "idempotency_state": row[3],
            "reused": True,
        }

    # Generation must precede source (active_generation FK) and op precedes
    # source too (last_sync_operation_id FK) — order: gen, op, source.
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_source_generation
            (tenant_id, monitoring_source_id, source_instance_generation,
             provider_profile, provider_instance_ref, provider_base_url)
        VALUES (%s, %s, %s, 'zabbix', %s, %s)
        """,
        (tenant_id, source_id, generation, provider_instance_ref, provider_base_url),
    )
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_sync_operation
            (tenant_id, monitoring_sync_operation_id, monitoring_source_id,
             source_instance_generation, configuration_revision,
             scope_revision, responsibility_kind, state)
        VALUES (%s, %s, %s, %s, 1, 1,
                'validation_and_initial_sync', 'pending')
        """,
        (tenant_id, operation_id, source_id, generation),
    )
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_source
            (tenant_id, monitoring_source_id,
             provider_scope_tenant_binding_id, provider_profile,
             active_source_instance_generation, configuration_revision,
             scope_revision, display_name, credential_binding_ref,
             configured_provider_scope, operational_evidence_state,
             last_sync_operation_id)
        VALUES (%s, %s, %s, 'zabbix', %s, 1, 1, %s, %s, %s::jsonb,
                'reconciliation_required', %s)
        """,
        (tenant_id, source_id, binding_id, generation, display_name,
         credential_binding_ref, scope_json, operation_id),
    )
    await conn.execute(
        """
        UPDATE monitoring.monitoring_source_create_idempotency
           SET state = 'completed', completed_at = transaction_timestamp()
         WHERE tenant_id = %s AND idempotency_key = %s
        """,
        (tenant_id, idempotency_key),
    )
    await conn.commit()

    return {
        "monitoring_source_id": source_id,
        "monitoring_sync_operation_id": operation_id,
        "idempotency_state": "completed",
        "reused": False,
    }


async def list_sources(conn: AsyncConnection, tenant_id: str) -> list[dict]:
    cur = await conn.execute(
        """
        SELECT s.monitoring_source_id, s.display_name,
               s.operational_evidence_state,
               s.configuration_revision, s.scope_revision,
               g.provider_instance_ref, g.provider_base_url,
               s.last_successful_sync_at, s.last_attempt_at
          FROM monitoring.monitoring_source s
          JOIN monitoring.monitoring_source_generation g
            ON g.tenant_id = s.tenant_id
           AND g.monitoring_source_id = s.monitoring_source_id
           AND g.source_instance_generation = s.active_source_instance_generation
         WHERE s.tenant_id = %s
         ORDER BY s.created_at
        """,
        (tenant_id,),
    )
    rows = await cur.fetchall()
    keys = ("monitoring_source_id", "display_name", "operational_evidence_state",
            "configuration_revision", "scope_revision", "provider_instance_ref",
            "provider_base_url", "last_successful_sync_at", "last_attempt_at")
    return [dict(zip(keys, r)) for r in rows]


async def get_source(
    conn: AsyncConnection, tenant_id: str, source_id: str
) -> Optional[dict]:
    cur = await conn.execute(
        """
        SELECT s.monitoring_source_id, s.display_name,
               s.operational_evidence_state, s.credential_binding_ref,
               s.configured_provider_scope,
               s.configuration_revision, s.scope_revision,
               g.provider_instance_ref, g.provider_base_url,
               g.source_instance_generation,
               s.last_successful_sync_at, s.last_attempt_at,
               s.last_sync_operation_id
          FROM monitoring.monitoring_source s
          JOIN monitoring.monitoring_source_generation g
            ON g.tenant_id = s.tenant_id
           AND g.monitoring_source_id = s.monitoring_source_id
           AND g.source_instance_generation = s.active_source_instance_generation
         WHERE s.tenant_id = %s AND s.monitoring_source_id = %s
        """,
        (tenant_id, source_id),
    )
    row = await cur.fetchone()
    if row is None:
        return None
    keys = ("monitoring_source_id", "display_name", "operational_evidence_state",
            "credential_binding_ref", "configured_provider_scope",
            "configuration_revision", "scope_revision", "provider_instance_ref",
            "provider_base_url", "source_instance_generation",
            "last_successful_sync_at", "last_attempt_at", "last_sync_operation_id")
    return dict(zip(keys, row))


# ---------------------------------------------------------------------------
# Validation repository (sync — worker path, implements
# MonitoringValidationRepository invoked synchronously by the domain worker)
# ---------------------------------------------------------------------------


class PgValidationRepository:
    """Claim/complete adapter for the initial validation worker.

    The claim snapshots generation + revisions; completion is accepted
    only if that snapshot is still the current source authority — an
    in-flight result from stale authority cannot update evidence.
    """

    def __init__(self, conn: Connection, tenant_id: str) -> None:
        self._conn = conn
        self._tenant_id = tenant_id

    def claim_initial_validation(
        self, monitoring_sync_operation_id: str, *, claim_token: str
    ) -> InitialValidationClaim:
        cur = self._conn.execute(
            """
            SELECT o.monitoring_source_id, o.source_instance_generation,
                   o.configuration_revision, o.scope_revision,
                   s.provider_scope_tenant_binding_id,
                   g.provider_instance_ref, g.provider_base_url,
                   s.credential_binding_ref, s.configured_provider_scope
              FROM monitoring.monitoring_sync_operation o
              JOIN monitoring.monitoring_source s
                ON s.tenant_id = o.tenant_id
               AND s.monitoring_source_id = o.monitoring_source_id
              JOIN monitoring.monitoring_source_generation g
                ON g.tenant_id = o.tenant_id
               AND g.monitoring_source_id = o.monitoring_source_id
               AND g.source_instance_generation = o.source_instance_generation
             WHERE o.tenant_id = %s
               AND o.monitoring_sync_operation_id = %s
               AND o.state = 'pending'
               AND o.claim_token IS NULL
               AND o.responsibility_kind = 'validation_and_initial_sync'
               AND s.active_source_instance_generation = o.source_instance_generation
               AND s.configuration_revision = o.configuration_revision
               AND s.scope_revision = o.scope_revision
             FOR UPDATE OF o
            """,
            (self._tenant_id, monitoring_sync_operation_id),
        )
        row = cur.fetchone()
        if row is None:
            self._conn.rollback()
            raise ValueError("monitoring.initial_validation_not_claimable")

        (source_id, generation, config_rev, scope_rev, binding_id,
         provider_instance_ref, base_url, cred_ref, scope_json) = row

        cur = self._conn.execute(
            """
            UPDATE monitoring.monitoring_sync_operation
               SET state = 'running', claim_token = %s,
                   started_at = transaction_timestamp()
             WHERE tenant_id = %s
               AND monitoring_sync_operation_id = %s
               AND state = 'pending' AND claim_token IS NULL
            """,
            (claim_token, self._tenant_id, monitoring_sync_operation_id),
        )
        if cur.rowcount != 1:
            self._conn.rollback()
            raise ValueError("monitoring.initial_validation_not_claimable")

        self._conn.commit()

        scope = scope_json if isinstance(scope_json, dict) else json.loads(scope_json)
        return InitialValidationClaim(
            claim_token=claim_token,
            tenant_id=self._tenant_id,
            monitoring_sync_operation_id=monitoring_sync_operation_id,
            monitoring_source_id=source_id,
            provider_scope_tenant_binding_id=binding_id,
            source_instance_generation=generation,
            configuration_revision=config_rev,
            scope_revision=scope_rev,
            provider_instance_ref=provider_instance_ref,
            provider_configuration=ZabbixProviderConfiguration(base_url=base_url),
            credential_binding_ref=cred_ref,
            configured_provider_scope=ConfiguredProviderScope.from_refs(
                scope["host_group_refs"]
            ),
        )

    def complete_initial_validation(
        self,
        claim: InitialValidationClaim,
        result: InitialValidationResult,
        *,
        validation_evidence_id: str,
    ) -> None:
        # Fenced completion: claim must be current AND the source's
        # generation/revisions/binding must still equal the snapshot.
        cur = self._conn.execute(
            """
            SELECT 1
              FROM monitoring.monitoring_sync_operation o
              JOIN monitoring.monitoring_source s
                ON s.tenant_id = o.tenant_id
               AND s.monitoring_source_id = o.monitoring_source_id
             WHERE o.tenant_id = %s
               AND o.monitoring_sync_operation_id = %s
               AND o.state = 'running'
               AND o.claim_token = %s
               AND s.active_source_instance_generation = %s
               AND s.configuration_revision = %s
               AND s.scope_revision = %s
               AND s.provider_scope_tenant_binding_id = %s
             FOR UPDATE OF o, s
            """,
            (
                claim.tenant_id,
                claim.monitoring_sync_operation_id,
                claim.claim_token,
                claim.source_instance_generation,
                claim.configuration_revision,
                claim.scope_revision,
                claim.provider_scope_tenant_binding_id,
            ),
        )
        if cur.fetchone() is None:
            self._conn.rollback()
            raise ValueError("monitoring.initial_validation_claim_lost")

        self._conn.execute(
            """
            INSERT INTO monitoring.monitoring_source_validation_evidence
                (validation_evidence_id, tenant_id, monitoring_source_id,
                 monitoring_sync_operation_id, operational_evidence_state,
                 visible_host_group_refs, missing_host_group_refs,
                 failure_class, egress_decision_ref, credential_generation_ref)
            VALUES (%s, %s, %s, %s, %s, %s::jsonb, %s::jsonb, %s, %s, %s)
            """,
            (
                validation_evidence_id,
                claim.tenant_id,
                claim.monitoring_source_id,
                claim.monitoring_sync_operation_id,
                result.operational_evidence_state.value,
                json.dumps(list(result.visible_host_group_refs)),
                json.dumps(list(result.missing_host_group_refs)),
                result.failure_class.value if result.failure_class else None,
                result.egress_decision_ref,
                result.credential_generation_ref,
            ),
        )

        op_state = result.operation_state.value
        self._conn.execute(
            """
            UPDATE monitoring.monitoring_sync_operation
               SET state = %s, completed_at = transaction_timestamp(),
                   last_error_class = %s
             WHERE tenant_id = %s AND monitoring_sync_operation_id = %s
            """,
            (
                op_state,
                result.failure_class.value if result.failure_class else None,
                claim.tenant_id,
                claim.monitoring_sync_operation_id,
            ),
        )
        self._conn.execute(
            """
            UPDATE monitoring.monitoring_source
               SET operational_evidence_state = %s,
                   last_attempt_at = transaction_timestamp(),
                   last_successful_sync_at = CASE WHEN %s = 'succeeded'
                       THEN transaction_timestamp()
                       ELSE last_successful_sync_at END,
                   updated_at = transaction_timestamp()
             WHERE tenant_id = %s AND monitoring_source_id = %s
            """,
            (
                result.operational_evidence_state.value,
                op_state,
                claim.tenant_id,
                claim.monitoring_source_id,
            ),
        )
        self._conn.commit()


def list_all_pending_validations(conn: Connection) -> list[tuple[str, str]]:
    """All tenants' pending initial validations — (tenant_id, op_id)."""
    cur = conn.execute(
        """
        SELECT tenant_id, monitoring_sync_operation_id
          FROM monitoring.monitoring_sync_operation
         WHERE state = 'pending'
           AND responsibility_kind = 'validation_and_initial_sync'
         ORDER BY created_at
        """
    )
    return [tuple(r) for r in cur.fetchall()]
