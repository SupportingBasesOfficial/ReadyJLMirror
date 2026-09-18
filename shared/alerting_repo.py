"""Alerting core repository (authorization: wave4.alerting-core-model@1).

Implements the canonical transition machinery — the ONLY write path
for alert state. Every semantic change is one immutable transition
record plus a projection update committed atomically in the caller's
transaction.

Enforced invariants (beyond the SQL CHECKs):
- lifecycle: NULL->active (seq 1), active->resolved (seq 2); resolved
  is terminal and never reopens;
- idempotent replay: the same (tenant, alert, seq) transition with the
  same meaning dedupes; same identity with different meaning is an
  integrity failure;
- closed source-kind discriminant: problem requires problem_id;
  health requires monitoring_resource_id and forbids problem_id;
- policy_id + immutable policy_version required on every transition;
- source currentness is re-read before effectful decisions — stale
  evidence fails closed.

No automatic creation/resolution exists — policy evaluation is a
separately gated authorization.
"""

from __future__ import annotations

import json
from datetime import datetime, timezone

from psycopg import AsyncConnection


class AlertingError(Exception):
    """Domain-level rejection of an alert transition."""


class IntegrityFailure(AlertingError):
    """Same transition identity with different immutable meaning."""


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


async def _existing_transition(
        conn: AsyncConnection, tenant_id: str, transition_id: str):
    cur = await conn.execute(
        """
        SELECT alert_transition_id, alert_id, transition_seq, from_state,
               to_state, transition_reason, source_kind, source_transition_id,
               source_projection_revision, policy_id, policy_version,
               causation_id, correlation_id
          FROM alerting.alert_transition
         WHERE tenant_id = %s AND alert_transition_id = %s
        """,
        (tenant_id, transition_id))
    row = await cur.fetchone()
    if row is None:
        return None
    keys = ("alert_transition_id", "alert_id", "transition_seq",
            "from_state", "to_state", "transition_reason", "source_kind",
            "source_transition_id", "source_projection_revision",
            "policy_id", "policy_version", "causation_id",
            "correlation_id")
    return dict(zip(keys, row))


def _check_source_integrity(
        source_kind: str, problem_id: str | None,
        resource_id: str | None) -> None:
    if source_kind == "monitoring_problem":
        if not problem_id:
            raise AlertingError(
                "monitoring_problem source requires problem_id")
    elif source_kind == "monitoring_health_projection":
        if not resource_id:
            raise AlertingError(
                "monitoring_health_projection source requires "
                "monitoring_resource_id")
        if problem_id:
            raise AlertingError(
                "health projection source must not carry problem_id")
    else:
        raise AlertingError(f"unknown source_kind: {source_kind}")


async def _verify_source_current(
        conn: AsyncConnection, tenant_id: str, source_kind: str,
        source_id: str, generation: str, resource_id: str | None,
        problem_id: str | None, claimed_revision: int) -> None:
    """Re-read the authoritative Monitoring projection and prove the
    supplied source revision is still current — stale evidence fails
    closed (never optimistic creation/resolution)."""
    if source_kind == "monitoring_problem":
        cur = await conn.execute(
            """
            SELECT projection_revision
              FROM monitoring.monitoring_problem
             WHERE tenant_id = %s AND problem_id = %s
               AND monitoring_source_id = %s
               AND source_instance_generation = %s
            """,
            (tenant_id, problem_id, source_id, generation))
    else:
        cur = await conn.execute(
            """
            SELECT projection_revision
              FROM monitoring.health_projection
             WHERE tenant_id = %s AND monitoring_resource_id = %s
               AND monitoring_source_id = %s
               AND source_instance_generation = %s
            """,
            (tenant_id, resource_id, source_id, generation))
    row = await cur.fetchone()
    if row is None:
        raise AlertingError(
            "source projection not found — evidence cannot be proven current")
    if row[0] != claimed_revision:
        raise AlertingError(
            f"stale source evidence: current revision {row[0]} != "
            f"claimed {claimed_revision}")


async def commit_alert_transition(
    conn: AsyncConnection,
    tenant_id: str,
    *,
    alert_transition_id: str,
    alert_id: str,
    to_state: str,
    transition_reason: str,
    source_kind: str,
    monitoring_source_id: str,
    source_instance_generation: str,
    monitoring_resource_id: str | None,
    problem_id: str | None,
    source_transition_id: str,
    source_projection_revision: int,
    policy_id: str,
    policy_version: int,
    correlation_id: str,
    causation_id: str | None = None,
) -> dict:
    """Commit one immutable lifecycle transition + projection update
    atomically. Idempotent on replay of the same accepted identity."""
    if to_state not in ("active", "resolved"):
        raise AlertingError(f"illegal to_state: {to_state}")
    if not policy_id or not policy_version:
        raise AlertingError("policy_id and policy_version are required")
    _check_source_integrity(
        source_kind, problem_id, monitoring_resource_id)

    # Idempotent replay by exact transition identity.
    existing = await _existing_transition(
        conn, tenant_id, alert_transition_id)
    if existing is not None:
        same = (
            existing["alert_id"] == alert_id
            and existing["to_state"] == to_state
            and existing["source_kind"] == source_kind
            and existing["source_transition_id"] == source_transition_id
            and existing["source_projection_revision"]
            == source_projection_revision
            and existing["policy_id"] == policy_id
            and existing["policy_version"] == policy_version)
        if not same:
            raise IntegrityFailure(
                f"transition {alert_transition_id} replayed with "
                "different immutable meaning")
        return await get_alert(conn, tenant_id, alert_id)

    # Current-state read of the alert projection (for update).
    cur = await conn.execute(
        """
        SELECT lifecycle_state, opened_at, projection_revision,
               last_transition_id
          FROM alerting.alert
         WHERE tenant_id = %s AND alert_id = %s
         FOR UPDATE
        """,
        (tenant_id, alert_id))
    alert = await cur.fetchone()

    if to_state == "active":
        if alert is not None:
            raise AlertingError(
                f"alert {alert_id} already exists ({alert[0]}) — "
                "create is not idempotent across different identities")
        seq, from_state = 1, None
        opened_at = _utcnow()
        await conn.execute(
            """
            INSERT INTO alerting.alert
                (tenant_id, alert_id, lifecycle_state, source_kind,
                 monitoring_source_id, source_instance_generation,
                 monitoring_resource_id, problem_id,
                 source_projection_revision, source_transition_id,
                 policy_id, policy_version, opened_at, last_confirmed_at,
                 projection_revision, created_by_transition_id,
                 last_transition_id)
            VALUES (%s, %s, 'active', %s, %s, %s, %s, %s, %s, %s,
                    %s, %s, %s, %s, 1, %s, %s)
            """,
            (tenant_id, alert_id, source_kind, monitoring_source_id,
             source_instance_generation, monitoring_resource_id,
             problem_id, source_projection_revision,
             source_transition_id, policy_id, policy_version,
             opened_at, opened_at, alert_transition_id,
             alert_transition_id))
    else:  # resolved
        if alert is None:
            raise AlertingError(
                f"cannot resolve unknown alert {alert_id}")
        if alert[0] == "resolved":
            raise AlertingError(
                f"alert {alert_id} is resolved — terminal state "
                "never reopens")
        seq, from_state = 2, "active"
        # Resolution must use current source evidence — re-read and
        # prove the claimed revision is still the authority.
        await _verify_source_current(
            conn, tenant_id, source_kind, monitoring_source_id,
            source_instance_generation, monitoring_resource_id,
            problem_id, source_projection_revision)
        resolved_at = _utcnow()
        await conn.execute(
            """
            UPDATE alerting.alert
               SET lifecycle_state = 'resolved', resolved_at = %s,
                   last_confirmed_at = %s,
                   projection_revision = projection_revision + 1,
                   last_transition_id = %s, updated_at = %s
             WHERE tenant_id = %s AND alert_id = %s
            """,
            (resolved_at, resolved_at, alert_transition_id,
             resolved_at, tenant_id, alert_id))

    await conn.execute(
        """
        INSERT INTO alerting.alert_transition
            (tenant_id, alert_transition_id, alert_id, transition_seq,
             from_state, to_state, transition_reason, source_kind,
             source_transition_id, source_projection_revision,
             policy_id, policy_version, correlation_id, causation_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
        """,
        (tenant_id, alert_transition_id, alert_id, seq, from_state,
         to_state, transition_reason, source_kind, source_transition_id,
         source_projection_revision, policy_id, policy_version,
         correlation_id, causation_id))

    # Accountability evidence commits atomically with the transition.
    await conn.execute(
        """
        INSERT INTO audit.audit_event
            (tenant_id, audit_event_id, action, actor_kind,
             subject_type, subject_id, detail, correlation_id)
        VALUES (%s, %s, %s, 'operator', 'alert', %s, %s::jsonb, %s)
        """,
        (tenant_id, f"aud_{alert_transition_id}",
         f"alerting.transition.{to_state}", alert_id,
         json.dumps({
             "from_state": from_state, "to_state": to_state,
             "transition_reason": transition_reason,
             "policy_id": policy_id, "policy_version": policy_version,
             "source_kind": source_kind}),
         correlation_id))

    return await get_alert(conn, tenant_id, alert_id)


async def get_alert(
        conn: AsyncConnection, tenant_id: str, alert_id: str) -> dict | None:
    cur = await conn.execute(
        """
        SELECT alert_id, lifecycle_state, source_kind,
               monitoring_source_id, source_instance_generation,
               monitoring_resource_id, problem_id,
               source_projection_revision, source_transition_id,
               policy_id, policy_version, opened_at, resolved_at,
               last_confirmed_at, projection_revision,
               created_by_transition_id, last_transition_id
          FROM alerting.alert
         WHERE tenant_id = %s AND alert_id = %s
        """,
        (tenant_id, alert_id))
    row = await cur.fetchone()
    if row is None:
        return None
    keys = ("alert_id", "lifecycle_state", "source_kind",
            "monitoring_source_id", "source_instance_generation",
            "monitoring_resource_id", "problem_id",
            "source_projection_revision", "source_transition_id",
            "policy_id", "policy_version", "opened_at", "resolved_at",
            "last_confirmed_at", "projection_revision",
            "created_by_transition_id", "last_transition_id")
    return dict(zip(keys, row))


async def list_alerts(
        conn: AsyncConnection, tenant_id: str,
        lifecycle_state: str | None = None,
        source_id: str | None = None,
        limit: int = 50) -> list[dict]:
    clauses = ["tenant_id = %s"]
    params: list = [tenant_id]
    if lifecycle_state:
        clauses.append("lifecycle_state = %s")
        params.append(lifecycle_state)
    if source_id:
        clauses.append("monitoring_source_id = %s")
        params.append(source_id)
    params.append(min(limit, 200))
    cur = await conn.execute(
        f"""
        SELECT alert_id, lifecycle_state, source_kind,
               monitoring_source_id, monitoring_resource_id, problem_id,
               source_projection_revision, policy_id, policy_version,
               opened_at, resolved_at, last_confirmed_at,
               projection_revision
          FROM alerting.alert
         WHERE {' AND '.join(clauses)}
         ORDER BY opened_at DESC
         LIMIT %s
        """,
        tuple(params))
    keys = ("alert_id", "lifecycle_state", "source_kind",
            "monitoring_source_id", "monitoring_resource_id",
            "problem_id", "source_projection_revision", "policy_id",
            "policy_version", "opened_at", "resolved_at",
            "last_confirmed_at", "projection_revision")
    return [dict(zip(keys, r)) for r in await cur.fetchall()]


async def list_alert_transitions(
        conn: AsyncConnection, tenant_id: str, alert_id: str) -> list[dict]:
    cur = await conn.execute(
        """
        SELECT alert_transition_id, transition_seq, from_state, to_state,
               transition_reason, source_kind, source_transition_id,
               source_projection_revision, policy_id, policy_version,
               occurred_at, correlation_id, causation_id
          FROM alerting.alert_transition
         WHERE tenant_id = %s AND alert_id = %s
         ORDER BY transition_seq
        """,
        (tenant_id, alert_id))
    keys = ("alert_transition_id", "transition_seq", "from_state",
            "to_state", "transition_reason", "source_kind",
            "source_transition_id", "source_projection_revision",
            "policy_id", "policy_version", "occurred_at",
            "correlation_id", "causation_id")
    return [dict(zip(keys, r)) for r in await cur.fetchall()]
