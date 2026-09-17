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

from jlmirror_monitoring.host_inventory import (
    HostInventoryClaim,
    HostInventoryResult,
)
from jlmirror_monitoring.metric_current_state import (
    CurrentMetricTarget,
    CurrentStateFailureClass,
    MetricCurrentStateClaim,
    MetricCurrentStateResult,
)
from jlmirror_monitoring.metric_definitions import (
    MetricDefinitionClaim,
    MetricDefinitionFailureClass,
    MetricDefinitionResult,
    canonical_value_kind,
)
from jlmirror_monitoring.metric_definitions import MetricValueKind
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


# ---------------------------------------------------------------------------
# Operation enqueue (async — API path)
# ---------------------------------------------------------------------------


async def enqueue_sync_operation(
    conn: AsyncConnection,
    *,
    tenant_id: str,
    source_id: str,
    responsibility_kind: str,
) -> str:
    """Create a pending sync op snapshotting the source's current
    generation + revisions. Returns the new operation id."""
    cur = await conn.execute(
        """
        SELECT active_source_instance_generation,
               configuration_revision, scope_revision
          FROM monitoring.monitoring_source
         WHERE tenant_id = %s AND monitoring_source_id = %s
        """,
        (tenant_id, source_id),
    )
    row = await cur.fetchone()
    if row is None:
        raise ValueError("monitoring.source_not_found")
    generation, config_rev, scope_rev = row
    op_id = _opaque("mon-sync")
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_sync_operation
            (tenant_id, monitoring_sync_operation_id, monitoring_source_id,
             source_instance_generation, configuration_revision,
             scope_revision, responsibility_kind, state)
        VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending')
        """,
        (tenant_id, op_id, source_id, generation, config_rev, scope_rev,
         responsibility_kind),
    )
    await conn.commit()
    return op_id


async def list_resources(
    conn: AsyncConnection, tenant_id: str, source_id: str
) -> list[dict]:
    cur = await conn.execute(
        """
        SELECT monitoring_resource_id, provider_external_ref, display_name,
               scope_state, presence_state, presence_evidence_state,
               scope_evidence_state, last_observed_at, removed_at
          FROM monitoring.monitoring_resource
         WHERE tenant_id = %s AND monitoring_source_id = %s
         ORDER BY provider_external_ref
        """,
        (tenant_id, source_id),
    )
    rows = await cur.fetchall()
    keys = ("monitoring_resource_id", "provider_external_ref", "display_name",
            "scope_state", "presence_state", "presence_evidence_state",
            "scope_evidence_state", "last_observed_at", "removed_at")
    return [dict(zip(keys, r)) for r in rows]


# ---------------------------------------------------------------------------
# Host inventory repository (sync — worker path, implements
# MonitoringHostInventoryRepository invoked synchronously by the domain)
# ---------------------------------------------------------------------------


class PgHostInventoryRepository:
    """Claim/complete adapter for the host inventory worker.

    Completion is fenced identically to validation. On a complete
    snapshot, resources are upserted (present + in_scope) and absent
    hosts become removed; on a degraded result no resource is removed —
    presence evidence degrades instead (fail closed, no inference).
    """

    def __init__(self, conn: Connection, tenant_id: str) -> None:
        self._conn = conn
        self._tenant_id = tenant_id

    def claim_host_inventory(
        self, monitoring_sync_operation_id: str, *, claim_token: str
    ) -> HostInventoryClaim:
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
               AND o.responsibility_kind = 'host_inventory_sync'
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
            raise ValueError("monitoring.host_inventory_not_claimable")

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
            raise ValueError("monitoring.host_inventory_not_claimable")

        self._conn.commit()

        scope = scope_json if isinstance(scope_json, dict) else json.loads(scope_json)
        return HostInventoryClaim(
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

    def complete_host_inventory(
        self,
        claim: HostInventoryClaim,
        result: HostInventoryResult,
        *,
        snapshot_evidence_id: str,
    ) -> HostInventoryResult:
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
            raise ValueError("monitoring.host_inventory_claim_lost")

        # Immutable snapshot evidence
        self._conn.execute(
            """
            INSERT INTO monitoring.monitoring_host_inventory_snapshot_evidence
                (tenant_id, host_inventory_snapshot_evidence_id,
                 monitoring_sync_operation_id, monitoring_source_id,
                 provider_scope_tenant_binding_id, source_instance_generation,
                 configuration_revision, scope_revision, provider_instance_ref,
                 snapshot_complete, host_count, operational_evidence_state,
                 operation_state, failure_class, egress_decision_ref,
                 credential_generation_ref)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                claim.tenant_id,
                snapshot_evidence_id,
                claim.monitoring_sync_operation_id,
                claim.monitoring_source_id,
                claim.provider_scope_tenant_binding_id,
                claim.source_instance_generation,
                claim.configuration_revision,
                claim.scope_revision,
                claim.provider_instance_ref,
                result.snapshot_complete,
                len(result.hosts),
                result.operational_evidence_state.value,
                result.operation_state.value,
                result.failure_class.value if result.failure_class else None,
                result.egress_decision_ref,
                result.credential_generation_ref,
            ),
        )

        if result.succeeded:
            self._persist_snapshot(claim, result, snapshot_evidence_id)
        else:
            # Degraded — no removals, only evidence degradation
            self._conn.execute(
                """
                UPDATE monitoring.monitoring_resource
                   SET presence_evidence_state = %s,
                       updated_at = transaction_timestamp()
                 WHERE tenant_id = %s AND monitoring_source_id = %s
                   AND source_instance_generation = %s
                   AND presence_state = 'present'
                """,
                (
                    result.operational_evidence_state.value,
                    claim.tenant_id,
                    claim.monitoring_source_id,
                    claim.source_instance_generation,
                ),
            )

        self._conn.execute(
            """
            UPDATE monitoring.monitoring_sync_operation
               SET state = %s, completed_at = transaction_timestamp(),
                   last_error_class = %s,
                   host_inventory_snapshot_evidence_id = %s
             WHERE tenant_id = %s AND monitoring_sync_operation_id = %s
            """,
            (
                result.operation_state.value,
                result.failure_class.value if result.failure_class else None,
                snapshot_evidence_id,
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
                result.operation_state.value,
                claim.tenant_id,
                claim.monitoring_source_id,
            ),
        )
        self._conn.commit()
        return result

    def _persist_snapshot(
        self,
        claim: HostInventoryClaim,
        result: HostInventoryResult,
        snapshot_evidence_id: str,
    ) -> None:
        """Upsert resources + provider evidence for a complete snapshot."""
        seen_refs: list[str] = []
        for host in result.hosts:
            seen_refs.append(host.hostid)
            cur = self._conn.execute(
                """
                SELECT monitoring_resource_id
                  FROM monitoring.monitoring_resource
                 WHERE tenant_id = %s AND monitoring_source_id = %s
                   AND source_instance_generation = %s
                   AND provider_external_ref = %s
                 FOR UPDATE
                """,
                (claim.tenant_id, claim.monitoring_source_id,
                 claim.source_instance_generation, host.hostid),
            )
            row = cur.fetchone()
            if row is None:
                resource_id = _opaque("mon-res")
                self._conn.execute(
                    """
                    INSERT INTO monitoring.monitoring_resource
                        (tenant_id, monitoring_resource_id,
                         monitoring_source_id, source_instance_generation,
                         resource_kind, provider_object_kind,
                         provider_external_ref, display_name, scope_state,
                         scope_projection_revision, scope_evidence_state,
                         presence_state, presence_evidence_state,
                         last_observed_at, last_confirmed_present_at)
                    VALUES (%s, %s, %s, %s, 'host', 'zabbix_host', %s, %s,
                            'in_scope', %s, 'current', 'present', 'current',
                            transaction_timestamp(), transaction_timestamp())
                    """,
                    (claim.tenant_id, resource_id, claim.monitoring_source_id,
                     claim.source_instance_generation, host.hostid,
                     host.display_name, claim.scope_revision),
                )
            else:
                resource_id = row[0]
                self._conn.execute(
                    """
                    UPDATE monitoring.monitoring_resource
                       SET display_name = %s, scope_state = 'in_scope',
                           scope_projection_revision = %s,
                           scope_evidence_state = 'current',
                           presence_state = 'present',
                           presence_evidence_state = 'current',
                           last_observed_at = transaction_timestamp(),
                           last_confirmed_present_at = transaction_timestamp(),
                           removed_at = NULL,
                           updated_at = transaction_timestamp()
                     WHERE tenant_id = %s AND monitoring_resource_id = %s
                    """,
                    (host.display_name, claim.scope_revision,
                     claim.tenant_id, resource_id),
                )

            evidence_id = _opaque("mon-ev")
            self._conn.execute(
                """
                INSERT INTO monitoring.monitoring_resource_provider_evidence
                    (tenant_id, provider_evidence_id,
                     host_inventory_snapshot_evidence_id,
                     monitoring_resource_id, monitoring_source_id,
                     source_instance_generation, provider_object_kind,
                     provider_external_ref, evidence_fingerprint,
                     normalized_evidence, observed_at)
                VALUES (%s, %s, %s, %s, %s, %s, 'zabbix_host', %s, %s,
                        %s::jsonb, transaction_timestamp())
                """,
                (
                    claim.tenant_id, evidence_id, snapshot_evidence_id,
                    resource_id, claim.monitoring_source_id,
                    claim.source_instance_generation, host.hostid,
                    host.evidence_fingerprint(),
                    json.dumps(host.canonical_evidence()),
                ),
            )
            self._conn.execute(
                """
                UPDATE monitoring.monitoring_resource
                   SET latest_provider_evidence_id = %s
                 WHERE tenant_id = %s AND monitoring_resource_id = %s
                """,
                (evidence_id, claim.tenant_id, resource_id),
            )

        # Complete snapshot: resources not seen become removed
        self._conn.execute(
            """
            UPDATE monitoring.monitoring_resource
               SET presence_state = 'removed',
                   removed_at = transaction_timestamp(),
                   presence_evidence_state = 'current',
                   updated_at = transaction_timestamp()
             WHERE tenant_id = %s AND monitoring_source_id = %s
               AND source_instance_generation = %s
               AND presence_state = 'present'
               AND provider_external_ref <> ALL(%s)
            """,
            (
                claim.tenant_id, claim.monitoring_source_id,
                claim.source_instance_generation, seen_refs,
            ),
        )


def list_all_pending_host_inventory(conn: Connection) -> list[tuple[str, str]]:
    """All tenants' pending host inventory ops — (tenant_id, op_id)."""
    cur = conn.execute(
        """
        SELECT tenant_id, monitoring_sync_operation_id
          FROM monitoring.monitoring_sync_operation
         WHERE state = 'pending'
           AND responsibility_kind = 'host_inventory_sync'
         ORDER BY created_at
        """
    )
    return [tuple(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Metric definition poll — enqueue + repository
# ---------------------------------------------------------------------------


async def enqueue_metric_definition_poll(
    conn: AsyncConnection, *, tenant_id: str, source_id: str
) -> str:
    """Enqueue the next metric_definition_poll op, assigning the next
    poll generation within the source's current epoch."""
    cur = await conn.execute(
        """
        SELECT active_source_instance_generation, configuration_revision,
               scope_revision, item_definition_poll_epoch,
               item_definition_poll_generation
          FROM monitoring.monitoring_source
         WHERE tenant_id = %s AND monitoring_source_id = %s
        """,
        (tenant_id, source_id),
    )
    row = await cur.fetchone()
    if row is None:
        raise ValueError("monitoring.source_not_found")
    generation_id, config_rev, scope_rev, epoch, poll_gen = row
    op_id = _opaque("mon-sync")
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_sync_operation
            (tenant_id, monitoring_sync_operation_id, monitoring_source_id,
             source_instance_generation, configuration_revision,
             scope_revision, responsibility_kind, state,
             item_definition_poll_epoch, item_definition_poll_generation)
        VALUES (%s, %s, %s, %s, %s, %s, 'metric_definition_poll', 'pending',
                %s, %s)
        """,
        (tenant_id, op_id, source_id, generation_id, config_rev, scope_rev,
         epoch, poll_gen + 1),
    )
    await conn.commit()
    return op_id


async def list_metric_definitions(
    conn: AsyncConnection, tenant_id: str, source_id: str
) -> list[dict]:
    cur = await conn.execute(
        """
        SELECT d.metric_definition_id, d.name, d.value_kind, d.unit,
               d.scope_state, d.definition_state, d.definition_evidence_state,
               b.provider_external_ref, b.provider_host_ref, b.provider_key,
               b.native_value_type, b.provider_operational_state
          FROM monitoring.metric_definition d
          JOIN monitoring.metric_definition_provider_binding b
            ON b.tenant_id = d.tenant_id
           AND b.metric_definition_id = d.metric_definition_id
         WHERE d.tenant_id = %s AND d.monitoring_source_id = %s
         ORDER BY b.provider_external_ref
        """,
        (tenant_id, source_id),
    )
    rows = await cur.fetchall()
    keys = ("metric_definition_id", "name", "value_kind", "unit",
            "scope_state", "definition_state", "definition_evidence_state",
            "provider_external_ref", "provider_host_ref", "provider_key",
            "native_value_type", "provider_operational_state")
    return [dict(zip(keys, r)) for r in rows]


class PgMetricDefinitionRepository:
    """Claim/complete adapter for the metric definition worker.

    Poll ordering fence: the op carries (epoch, generation); completion
    requires the source to still sit at the predecessor generation in
    the same epoch, then the source advances to the claimed generation
    on any completion — the slot is consumed, ordering stays strictly
    monotonic.
    """

    def __init__(self, conn: Connection, tenant_id: str) -> None:
        self._conn = conn
        self._tenant_id = tenant_id

    def claim_metric_definitions(
        self, monitoring_sync_operation_id: str, *, claim_token: str
    ) -> MetricDefinitionClaim:
        cur = self._conn.execute(
            """
            SELECT o.monitoring_source_id, o.source_instance_generation,
                   o.configuration_revision, o.scope_revision,
                   o.item_definition_poll_epoch, o.item_definition_poll_generation,
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
               AND o.responsibility_kind = 'metric_definition_poll'
               AND s.active_source_instance_generation = o.source_instance_generation
               AND s.configuration_revision = o.configuration_revision
               AND s.scope_revision = o.scope_revision
               AND s.item_definition_poll_epoch = o.item_definition_poll_epoch
               AND s.item_definition_poll_generation
                   = o.item_definition_poll_generation - 1
             FOR UPDATE OF o
            """,
            (self._tenant_id, monitoring_sync_operation_id),
        )
        row = cur.fetchone()
        if row is None:
            self._conn.rollback()
            raise ValueError("monitoring.metric_definition_not_claimable")

        (source_id, generation, config_rev, scope_rev, epoch, poll_gen,
         binding_id, provider_instance_ref, base_url, cred_ref,
         scope_json) = row

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
            raise ValueError("monitoring.metric_definition_not_claimable")

        self._conn.commit()

        scope = scope_json if isinstance(scope_json, dict) else json.loads(scope_json)
        return MetricDefinitionClaim(
            claim_token=claim_token,
            tenant_id=self._tenant_id,
            monitoring_sync_operation_id=monitoring_sync_operation_id,
            monitoring_source_id=source_id,
            provider_scope_tenant_binding_id=binding_id,
            source_instance_generation=generation,
            configuration_revision=config_rev,
            scope_revision=scope_rev,
            item_definition_poll_epoch=epoch,
            item_definition_poll_generation=poll_gen,
            provider_instance_ref=provider_instance_ref,
            provider_configuration=ZabbixProviderConfiguration(base_url=base_url),
            credential_binding_ref=cred_ref,
            configured_provider_scope=ConfiguredProviderScope.from_refs(
                scope["host_group_refs"]
            ),
        )

    def complete_metric_definitions(
        self,
        claim: MetricDefinitionClaim,
        result: MetricDefinitionResult,
        *,
        snapshot_evidence_id: str,
    ) -> MetricDefinitionResult:
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
               AND s.item_definition_poll_epoch = %s
               AND s.item_definition_poll_generation = %s - 1
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
                claim.item_definition_poll_epoch,
                claim.item_definition_poll_generation,
            ),
        )
        if cur.fetchone() is None:
            self._conn.rollback()
            raise ValueError("monitoring.metric_definition_claim_lost")

        # Host association fence: every item's hostid must be a canonical
        # resource of this source generation — fail closed otherwise.
        effective = result
        if result.succeeded:
            host_refs = {item.hostid for item in result.items}
            if host_refs:
                cur = self._conn.execute(
                    """
                    SELECT provider_external_ref
                      FROM monitoring.monitoring_resource
                     WHERE tenant_id = %s AND monitoring_source_id = %s
                       AND source_instance_generation = %s
                       AND provider_external_ref = ANY(%s)
                       AND presence_state = 'present'
                    """,
                    (claim.tenant_id, claim.monitoring_source_id,
                     claim.source_instance_generation, list(host_refs)),
                )
                present = {r[0] for r in cur.fetchall()}
                if host_refs - present:
                    from dataclasses import replace
                    from jlmirror_monitoring.source import (
                        OperationalEvidenceState, SyncOperationState,
                    )
                    effective = replace(
                        result,
                        operational_evidence_state=OperationalEvidenceState.INCOMPLETE,
                        operation_state=SyncOperationState.RECONCILIATION_REQUIRED,
                        snapshot_complete=False,
                        failure_class=MetricDefinitionFailureClass.HOST_ASSOCIATION_INVALID,
                    )

        self._conn.execute(
            """
            INSERT INTO monitoring.monitoring_metric_definition_snapshot_evidence
                (tenant_id, metric_definition_snapshot_evidence_id,
                 monitoring_sync_operation_id, monitoring_source_id,
                 source_instance_generation, configuration_revision,
                 scope_revision, item_definition_poll_epoch,
                 item_definition_poll_generation, snapshot_complete,
                 item_count, operational_evidence_state, operation_state,
                 failure_class, egress_decision_ref, credential_generation_ref)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                claim.tenant_id, snapshot_evidence_id,
                claim.monitoring_sync_operation_id,
                claim.monitoring_source_id,
                claim.source_instance_generation,
                claim.configuration_revision, claim.scope_revision,
                claim.item_definition_poll_epoch,
                claim.item_definition_poll_generation,
                effective.snapshot_complete, len(effective.items),
                effective.operational_evidence_state.value,
                effective.operation_state.value,
                effective.failure_class.value if effective.failure_class else None,
                effective.egress_decision_ref,
                effective.credential_generation_ref,
            ),
        )

        if effective.succeeded:
            self._persist_item_snapshot(claim, effective, snapshot_evidence_id)
        else:
            self._conn.execute(
                """
                UPDATE monitoring.metric_definition
                   SET definition_evidence_state = %s,
                       updated_at = transaction_timestamp()
                 WHERE tenant_id = %s AND monitoring_source_id = %s
                   AND source_instance_generation = %s
                   AND definition_state = 'active'
                """,
                (
                    effective.operational_evidence_state.value,
                    claim.tenant_id, claim.monitoring_source_id,
                    claim.source_instance_generation,
                ),
            )

        # Consume the poll slot on any completion — strict monotonic order
        self._conn.execute(
            """
            UPDATE monitoring.monitoring_source
               SET item_definition_poll_generation = %s,
                   operational_evidence_state = %s,
                   last_attempt_at = transaction_timestamp(),
                   last_successful_sync_at = CASE WHEN %s = 'succeeded'
                       THEN transaction_timestamp()
                       ELSE last_successful_sync_at END,
                   updated_at = transaction_timestamp()
             WHERE tenant_id = %s AND monitoring_source_id = %s
            """,
            (
                claim.item_definition_poll_generation,
                effective.operational_evidence_state.value,
                effective.operation_state.value,
                claim.tenant_id, claim.monitoring_source_id,
            ),
        )
        self._conn.execute(
            """
            UPDATE monitoring.monitoring_sync_operation
               SET state = %s, completed_at = transaction_timestamp(),
                   last_error_class = %s,
                   metric_definition_snapshot_evidence_id = %s
             WHERE tenant_id = %s AND monitoring_sync_operation_id = %s
            """,
            (
                effective.operation_state.value,
                effective.failure_class.value if effective.failure_class else None,
                snapshot_evidence_id,
                claim.tenant_id, claim.monitoring_sync_operation_id,
            ),
        )
        self._conn.commit()
        return effective

    def _persist_item_snapshot(
        self,
        claim: MetricDefinitionClaim,
        result: MetricDefinitionResult,
        snapshot_evidence_id: str,
    ) -> None:
        """Upsert metric definitions + bindings + item evidence."""
        # hostid -> resource_id map for this source generation
        cur = self._conn.execute(
            """
            SELECT provider_external_ref, monitoring_resource_id
              FROM monitoring.monitoring_resource
             WHERE tenant_id = %s AND monitoring_source_id = %s
               AND source_instance_generation = %s
            """,
            (claim.tenant_id, claim.monitoring_source_id,
             claim.source_instance_generation),
        )
        host_map = {r[0]: r[1] for r in cur.fetchall()}

        seen_refs: list[str] = []
        for item in result.items:
            seen_refs.append(item.itemid)
            resource_id = host_map[item.hostid]

            cur = self._conn.execute(
                """
                SELECT b.metric_definition_id, b.native_value_type
                  FROM monitoring.metric_definition_provider_binding b
                 WHERE b.tenant_id = %s AND b.monitoring_source_id = %s
                   AND b.source_instance_generation = %s
                   AND b.provider_external_ref = %s
                 FOR UPDATE
                """,
                (claim.tenant_id, claim.monitoring_source_id,
                 claim.source_instance_generation, item.itemid),
            )
            existing = cur.fetchone()
            value_kind = canonical_value_kind(item.native_value_type).value

            if existing is None:
                definition_id = _opaque("mon-def")
                self._conn.execute(
                    """
                    INSERT INTO monitoring.metric_definition
                        (tenant_id, metric_definition_id,
                         monitoring_resource_id, monitoring_source_id,
                         source_instance_generation, name, value_kind, unit,
                         scope_state, scope_projection_revision,
                         scope_evidence_state, definition_state,
                         definition_evidence_state,
                         last_confirmed_present_poll_epoch,
                         last_confirmed_present_poll_generation)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s,
                            'in_scope', %s, 'current', 'active', 'current',
                            %s, %s)
                    """,
                    (claim.tenant_id, definition_id, resource_id,
                     claim.monitoring_source_id,
                     claim.source_instance_generation, item.name, value_kind,
                     item.unit, claim.scope_revision,
                     claim.item_definition_poll_epoch,
                     claim.item_definition_poll_generation),
                )
                self._conn.execute(
                    """
                    INSERT INTO monitoring.metric_definition_provider_binding
                        (tenant_id, metric_definition_id,
                         monitoring_resource_id, monitoring_source_id,
                         source_instance_generation, provider_profile,
                         provider_object_kind, provider_external_ref,
                         provider_host_ref, provider_key, native_value_type,
                         provider_operational_state, evidence_state)
                    VALUES (%s, %s, %s, %s, %s, 'zabbix', 'zabbix_item',
                            %s, %s, %s, %s, %s, 'current')
                    """,
                    (claim.tenant_id, definition_id, resource_id,
                     claim.monitoring_source_id,
                     claim.source_instance_generation, item.itemid,
                     item.hostid, item.key,
                     item.native_value_type.value,
                     item.operational_state.value),
                )
            else:
                definition_id, prior_native = existing
                # Value-kind drift: native type changed — fail closed,
                # mark binding + definition evidence as reconciliation
                drift = prior_native != item.native_value_type.value
                ev_state = "reconciliation_required" if drift else "current"
                self._conn.execute(
                    """
                    UPDATE monitoring.metric_definition
                       SET name = %s, unit = %s,
                           scope_state = 'in_scope',
                           scope_projection_revision = %s,
                           scope_evidence_state = 'current',
                           definition_state = 'active',
                           definition_evidence_state = %s,
                           retired_poll_epoch = NULL,
                           retired_poll_generation = NULL,
                           last_confirmed_present_poll_epoch = %s,
                           last_confirmed_present_poll_generation = %s,
                           updated_at = transaction_timestamp()
                     WHERE tenant_id = %s AND metric_definition_id = %s
                    """,
                    (item.name, item.unit, claim.scope_revision, ev_state,
                     claim.item_definition_poll_epoch,
                     claim.item_definition_poll_generation,
                     claim.tenant_id, definition_id),
                )
                self._conn.execute(
                    """
                    UPDATE monitoring.metric_definition_provider_binding
                       SET provider_host_ref = %s, provider_key = %s,
                           native_value_type = %s,
                           provider_operational_state = %s,
                           evidence_state = %s,
                           updated_at = transaction_timestamp()
                     WHERE tenant_id = %s AND metric_definition_id = %s
                    """,
                    (item.hostid, item.key, item.native_value_type.value,
                     item.operational_state.value, ev_state,
                     claim.tenant_id, definition_id),
                )

            evidence_id = _opaque("mon-imev")
            self._conn.execute(
                """
                INSERT INTO monitoring.monitoring_metric_definition_provider_evidence
                    (tenant_id, provider_evidence_id,
                     metric_definition_snapshot_evidence_id,
                     metric_definition_id, provider_external_ref,
                     normalized_evidence, observed_at)
                VALUES (%s, %s, %s, %s, %s, %s::jsonb, transaction_timestamp())
                """,
                (
                    claim.tenant_id, evidence_id, snapshot_evidence_id,
                    definition_id, item.itemid,
                    json.dumps({
                        "itemid": item.itemid, "hostid": item.hostid,
                        "name": item.name, "key": item.key, "unit": item.unit,
                        "native_value_type": item.native_value_type.value,
                        "operational_state": item.operational_state.value,
                    }),
                ),
            )

        # Complete snapshot: unseen active definitions retire
        self._conn.execute(
            """
            UPDATE monitoring.metric_definition
               SET definition_state = 'retired',
                   retired_poll_epoch = %s,
                   retired_poll_generation = %s,
                   updated_at = transaction_timestamp()
             WHERE tenant_id = %s AND monitoring_source_id = %s
               AND source_instance_generation = %s
               AND definition_state = 'active'
               AND metric_definition_id NOT IN (
                   SELECT metric_definition_id
                     FROM monitoring.metric_definition_provider_binding
                    WHERE tenant_id = %s AND monitoring_source_id = %s
                      AND source_instance_generation = %s
                      AND provider_external_ref = ANY(%s)
               )
            """,
            (
                claim.item_definition_poll_epoch,
                claim.item_definition_poll_generation,
                claim.tenant_id, claim.monitoring_source_id,
                claim.source_instance_generation,
                claim.tenant_id, claim.monitoring_source_id,
                claim.source_instance_generation, seen_refs,
            ),
        )


def list_all_pending_metric_polls(conn: Connection) -> list[tuple[str, str]]:
    """All tenants' pending metric_definition_poll ops — (tenant_id, op_id)."""
    cur = conn.execute(
        """
        SELECT tenant_id, monitoring_sync_operation_id
          FROM monitoring.monitoring_sync_operation
         WHERE state = 'pending'
           AND responsibility_kind = 'metric_definition_poll'
         ORDER BY created_at
        """
    )
    return [tuple(r) for r in cur.fetchall()]


# ---------------------------------------------------------------------------
# Metric current state — enqueue + repository
# ---------------------------------------------------------------------------


async def enqueue_current_state_poll(
    conn: AsyncConnection, *, tenant_id: str, source_id: str
) -> str:
    """Enqueue the next current_state_poll op with the next poll
    generation within the source's current epoch."""
    cur = await conn.execute(
        """
        SELECT active_source_instance_generation, configuration_revision,
               scope_revision, current_state_poll_epoch,
               current_state_poll_generation
          FROM monitoring.monitoring_source
         WHERE tenant_id = %s AND monitoring_source_id = %s
        """,
        (tenant_id, source_id),
    )
    row = await cur.fetchone()
    if row is None:
        raise ValueError("monitoring.source_not_found")
    generation_id, config_rev, scope_rev, epoch, poll_gen = row
    op_id = _opaque("mon-sync")
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_sync_operation
            (tenant_id, monitoring_sync_operation_id, monitoring_source_id,
             source_instance_generation, configuration_revision,
             scope_revision, responsibility_kind, state,
             current_state_poll_epoch, current_state_poll_generation)
        VALUES (%s, %s, %s, %s, %s, %s, 'current_state_poll', 'pending',
                %s, %s)
        """,
        (tenant_id, op_id, source_id, generation_id, config_rev, scope_rev,
         epoch, poll_gen + 1),
    )
    await conn.commit()
    return op_id


async def list_current_states(
    conn: AsyncConnection, tenant_id: str, source_id: str
) -> list[dict]:
    cur = await conn.execute(
        """
        SELECT c.metric_definition_id, d.name, c.value_kind,
               c.canonical_value, c.evidence_state, c.observed_at,
               c.accepted_at, c.projection_revision,
               c.current_state_poll_epoch, c.current_state_poll_generation
          FROM monitoring.metric_current_state c
          JOIN monitoring.metric_definition d
            ON d.tenant_id = c.tenant_id
           AND d.metric_definition_id = c.metric_definition_id
         WHERE c.tenant_id = %s AND c.monitoring_source_id = %s
         ORDER BY d.name
        """,
        (tenant_id, source_id),
    )
    rows = await cur.fetchall()
    keys = ("metric_definition_id", "name", "value_kind", "canonical_value",
            "evidence_state", "observed_at", "accepted_at",
            "projection_revision", "current_state_poll_epoch",
            "current_state_poll_generation")
    return [dict(zip(keys, r)) for r in rows]


class PgMetricCurrentStateRepository:
    """Claim/complete adapter for the metric current-state worker.

    Targets are built from definitions that are pollable under current
    authority (active + current binding + in_scope). Completion:
      - inserts deduplicated observation acceptance envelopes
      - advances metric_current_state only on newer provider clock
      - records immutable transitions
      - marks unreturned targets stale (no fabricated values)
      - consumes the poll slot on any completion
    """

    def __init__(self, conn: Connection, tenant_id: str) -> None:
        self._conn = conn
        self._tenant_id = tenant_id

    def claim_metric_current_state(
        self, monitoring_sync_operation_id: str, *, claim_token: str
    ) -> MetricCurrentStateClaim:
        cur = self._conn.execute(
            """
            SELECT o.monitoring_source_id, o.source_instance_generation,
                   o.configuration_revision, o.scope_revision,
                   o.current_state_poll_epoch, o.current_state_poll_generation,
                   s.provider_scope_tenant_binding_id,
                   g.provider_instance_ref, g.provider_base_url,
                   s.credential_binding_ref
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
               AND o.responsibility_kind = 'current_state_poll'
               AND s.active_source_instance_generation = o.source_instance_generation
               AND s.configuration_revision = o.configuration_revision
               AND s.scope_revision = o.scope_revision
               AND s.current_state_poll_epoch = o.current_state_poll_epoch
               AND s.current_state_poll_generation
                   = o.current_state_poll_generation - 1
             FOR UPDATE OF o
            """,
            (self._tenant_id, monitoring_sync_operation_id),
        )
        row = cur.fetchone()
        if row is None:
            self._conn.rollback()
            raise ValueError("monitoring.current_state_not_claimable")

        (source_id, generation, config_rev, scope_rev, epoch, poll_gen,
         binding_id, provider_instance_ref, base_url, cred_ref) = row

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
            raise ValueError("monitoring.current_state_not_claimable")

        # Targets: pollable definitions under current authority
        cur = self._conn.execute(
            """
            SELECT d.metric_definition_id, d.monitoring_resource_id,
                   b.provider_external_ref, d.value_kind
              FROM monitoring.metric_definition d
              JOIN monitoring.metric_definition_provider_binding b
                ON b.tenant_id = d.tenant_id
               AND b.metric_definition_id = d.metric_definition_id
             WHERE d.tenant_id = %s AND d.monitoring_source_id = %s
               AND d.source_instance_generation = %s
               AND d.definition_state = 'active'
               AND d.definition_evidence_state = 'current'
               AND d.scope_state = 'in_scope'
               AND b.evidence_state = 'current'
             ORDER BY b.provider_external_ref
            """,
            (self._tenant_id, source_id, generation),
        )
        targets = tuple(
            CurrentMetricTarget(
                metric_definition_id=r[0],
                monitoring_resource_id=r[1],
                provider_external_ref=r[2],
                value_kind=MetricValueKind(r[3]),
            )
            for r in cur.fetchall()
        )

        self._conn.commit()
        return MetricCurrentStateClaim(
            claim_token=claim_token,
            tenant_id=self._tenant_id,
            monitoring_sync_operation_id=monitoring_sync_operation_id,
            monitoring_source_id=source_id,
            source_instance_generation=generation,
            configuration_revision=config_rev,
            scope_revision=scope_rev,
            current_state_poll_epoch=epoch,
            current_state_poll_generation=poll_gen,
            provider_instance_ref=provider_instance_ref,
            provider_configuration=ZabbixProviderConfiguration(base_url=base_url),
            credential_binding_ref=cred_ref,
            targets=targets,
        )

    def complete_metric_current_state(
        self,
        claim: MetricCurrentStateClaim,
        result: MetricCurrentStateResult,
    ) -> MetricCurrentStateResult:
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
               AND s.current_state_poll_epoch = %s
               AND s.current_state_poll_generation = %s - 1
             FOR UPDATE OF o, s
            """,
            (
                claim.tenant_id,
                claim.monitoring_sync_operation_id,
                claim.claim_token,
                claim.source_instance_generation,
                claim.configuration_revision,
                claim.scope_revision,
                claim.current_state_poll_epoch,
                claim.current_state_poll_generation,
            ),
        )
        if cur.fetchone() is None:
            self._conn.rollback()
            raise ValueError("monitoring.current_state_claim_lost")

        if result.succeeded:
            self._persist_observations(claim, result)

        # Consume the poll slot + update source evidence on any completion
        self._conn.execute(
            """
            UPDATE monitoring.monitoring_source
               SET current_state_poll_generation = %s,
                   operational_evidence_state = %s,
                   last_attempt_at = transaction_timestamp(),
                   last_successful_sync_at = CASE WHEN %s = 'succeeded'
                       THEN transaction_timestamp()
                       ELSE last_successful_sync_at END,
                   updated_at = transaction_timestamp()
             WHERE tenant_id = %s AND monitoring_source_id = %s
            """,
            (
                claim.current_state_poll_generation,
                result.operational_evidence_state.value,
                result.operation_state.value,
                claim.tenant_id, claim.monitoring_source_id,
            ),
        )
        self._conn.execute(
            """
            UPDATE monitoring.monitoring_sync_operation
               SET state = %s, completed_at = transaction_timestamp(),
                   last_error_class = %s
             WHERE tenant_id = %s AND monitoring_sync_operation_id = %s
            """,
            (
                result.operation_state.value,
                result.failure_class.value if result.failure_class else None,
                claim.tenant_id, claim.monitoring_sync_operation_id,
            ),
        )
        self._conn.commit()
        return result

    def _persist_observations(
        self,
        claim: MetricCurrentStateClaim,
        result: MetricCurrentStateResult,
    ) -> None:
        from datetime import datetime, timezone

        returned_defs = set()
        for obs in result.accepted_observations:
            returned_defs.add(obs.metric_definition_id)
            observed_at = datetime.fromtimestamp(
                obs.observed_at_epoch_seconds
                + obs.observed_at_nanoseconds / 1_000_000_000,
                tz=timezone.utc,
            )
            # Acceptance envelope — dedup on provider clock replay
            cur = self._conn.execute(
                """
                INSERT INTO monitoring.monitoring_metric_observation_acceptance
                    (tenant_id, observation_id, monitoring_sync_operation_id,
                     monitoring_source_id, source_instance_generation,
                     monitoring_resource_id, metric_definition_id,
                     provider_profile, provider_external_ref, provider_clock,
                     provider_ns, observed_at, value_kind, canonical_value,
                     configuration_revision, scope_revision,
                     current_state_poll_epoch, current_state_poll_generation)
                VALUES (%s, %s, %s, %s, %s, %s, %s, 'zabbix', %s, %s, %s,
                        %s, %s, %s::jsonb, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, monitoring_source_id,
                             source_instance_generation, provider_external_ref,
                             provider_clock, provider_ns)
                DO NOTHING
                RETURNING observation_id
                """,
                (
                    claim.tenant_id, obs.observation_id,
                    claim.monitoring_sync_operation_id,
                    claim.monitoring_source_id,
                    claim.source_instance_generation,
                    obs.monitoring_resource_id, obs.metric_definition_id,
                    obs.provider_external_ref,
                    obs.observed_at_epoch_seconds,
                    obs.observed_at_nanoseconds,
                    observed_at, obs.value_kind.value,
                    _canonical_value_json(obs.canonical_value),
                    claim.configuration_revision, claim.scope_revision,
                    claim.current_state_poll_epoch,
                    claim.current_state_poll_generation,
                ),
            )
            row = cur.fetchone()
            if row is None:
                # Duplicate observation (same provider clock replayed) —
                # already accepted; no projection advance.
                continue
            observation_id = row[0]

            # Advance the projection only on newer provider clock
            cur = self._conn.execute(
                """
                SELECT c.current_observation_id, c.projection_revision,
                       a.provider_clock, a.provider_ns
                  FROM monitoring.metric_current_state c
                  JOIN monitoring.monitoring_metric_observation_acceptance a
                    ON a.tenant_id = c.tenant_id
                   AND a.observation_id = c.current_observation_id
                 WHERE c.tenant_id = %s AND c.metric_definition_id = %s
                 FOR UPDATE OF c
                """,
                (claim.tenant_id, obs.metric_definition_id),
            )
            existing = cur.fetchone()

            if existing is None:
                self._conn.execute(
                    """
                    INSERT INTO monitoring.metric_current_state
                        (tenant_id, metric_definition_id,
                         monitoring_resource_id, monitoring_source_id,
                         source_instance_generation, current_observation_id,
                         observed_at, accepted_at, value_kind,
                         canonical_value, evidence_state,
                         projection_revision, current_state_poll_epoch,
                         current_state_poll_generation, last_changed_at)
                    VALUES (%s, %s, %s, %s, %s, %s, %s,
                            transaction_timestamp(), %s, %s::jsonb, 'current',
                            1, %s, %s, transaction_timestamp())
                    """,
                    (claim.tenant_id, obs.metric_definition_id,
                     obs.monitoring_resource_id, claim.monitoring_source_id,
                     claim.source_instance_generation, observation_id,
                     observed_at, obs.value_kind.value,
                     _canonical_value_json(obs.canonical_value),
                     claim.current_state_poll_epoch,
                     claim.current_state_poll_generation),
                )
                self._conn.execute(
                    """
                    INSERT INTO monitoring.monitoring_metric_current_state_transition
                        (tenant_id, current_state_transition_id,
                         metric_definition_id, monitoring_resource_id,
                         monitoring_source_id, source_instance_generation,
                         from_observation_id, to_observation_id,
                         projection_revision, evidence_state)
                    VALUES (%s, %s, %s, %s, %s, %s, NULL, %s, 1, 'current')
                    """,
                    (claim.tenant_id, _opaque("mon-trans"),
                     obs.metric_definition_id, obs.monitoring_resource_id,
                     claim.monitoring_source_id,
                     claim.source_instance_generation, observation_id),
                )
            else:
                (prior_obs_id, prior_rev, prior_clock, prior_ns) = existing
                newer = (
                    obs.observed_at_epoch_seconds > prior_clock
                    or (obs.observed_at_epoch_seconds == prior_clock
                        and obs.observed_at_nanoseconds > prior_ns)
                )
                if not newer:
                    continue  # older/equal sample — no projection advance
                new_rev = prior_rev + 1
                self._conn.execute(
                    """
                    UPDATE monitoring.metric_current_state
                       SET current_observation_id = %s, observed_at = %s,
                           accepted_at = transaction_timestamp(),
                           value_kind = %s, canonical_value = %s::jsonb,
                           evidence_state = 'current',
                           projection_revision = %s,
                           current_state_poll_epoch = %s,
                           current_state_poll_generation = %s,
                           last_changed_at = transaction_timestamp(),
                           updated_at = transaction_timestamp()
                     WHERE tenant_id = %s AND metric_definition_id = %s
                    """,
                    (observation_id, observed_at, obs.value_kind.value,
                     _canonical_value_json(obs.canonical_value), new_rev,
                     claim.current_state_poll_epoch,
                     claim.current_state_poll_generation,
                     claim.tenant_id, obs.metric_definition_id),
                )
                self._conn.execute(
                    """
                    INSERT INTO monitoring.monitoring_metric_current_state_transition
                        (tenant_id, current_state_transition_id,
                         metric_definition_id, monitoring_resource_id,
                         monitoring_source_id, source_instance_generation,
                         from_observation_id, to_observation_id,
                         projection_revision, evidence_state)
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, 'current')
                    """,
                    (claim.tenant_id, _opaque("mon-trans"),
                     obs.metric_definition_id, obs.monitoring_resource_id,
                     claim.monitoring_source_id,
                     claim.source_instance_generation, prior_obs_id,
                     observation_id, new_rev),
                )

        # Coverage degradation: claimed targets with no returned sample
        # become stale — no fabricated values.
        unreturned = [
            t.metric_definition_id for t in claim.targets
            if t.metric_definition_id not in returned_defs
        ]
        if unreturned:
            self._conn.execute(
                """
                UPDATE monitoring.metric_current_state
                   SET evidence_state = 'stale',
                       updated_at = transaction_timestamp()
                 WHERE tenant_id = %s AND metric_definition_id = ANY(%s)
                """,
                (claim.tenant_id, unreturned),
            )


def _canonical_value_json(value) -> str:
    """Serialize a canonical metric value to JSONB-safe text."""
    from decimal import Decimal
    if isinstance(value, Decimal):
        return json.dumps(str(value))
    return json.dumps(value)


def list_all_pending_current_polls(conn: Connection) -> list[tuple[str, str]]:
    """All tenants' pending current_state_poll ops — (tenant_id, op_id)."""
    cur = conn.execute(
        """
        SELECT tenant_id, monitoring_sync_operation_id
          FROM monitoring.monitoring_sync_operation
         WHERE state = 'pending'
           AND responsibility_kind = 'current_state_poll'
         ORDER BY created_at
        """
    )
    return [tuple(r) for r in cur.fetchall()]
