"""Audit trail writer (SEC-AUD): record immutable accountability
evidence in the SAME transaction as the mutation it describes.

    async with db_tenant_connection(tenant) as conn:
        await repo.mutate(conn, ...)
        await record_audit_event(
            conn, tenant, action="monitoring.operation.requeued",
            actor_kind="operator", actor_id=principal_id,
            subject_type="sync_operation", subject_id=op_id,
            detail={"from_state": "reconciliation_required"})
        await conn.commit()

Never write secrets, tokens or raw provider payloads into `detail` —
bounded identifiers and decision evidence only.
"""

from __future__ import annotations

import json
import secrets

from psycopg import AsyncConnection


def new_audit_id() -> str:
    return f"aud_{secrets.token_urlsafe(16)}"


async def record_audit_event(
    conn: AsyncConnection,
    tenant_id: str,
    *,
    action: str,
    actor_kind: str,
    subject_type: str,
    subject_id: str,
    actor_id: str | None = None,
    detail: dict | None = None,
    correlation_id: str | None = None,
    audit_event_id: str | None = None,
) -> str:
    """Append one immutable audit event; returns its id."""
    event_id = audit_event_id or new_audit_id()
    await conn.execute(
        """
        INSERT INTO audit.audit_event
            (tenant_id, audit_event_id, action, actor_kind, actor_id,
             subject_type, subject_id, detail, correlation_id)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s::jsonb, %s)
        """,
        (tenant_id, event_id, action, actor_kind, actor_id,
         subject_type, subject_id, json.dumps(detail or {}),
         correlation_id))
    return event_id


async def list_audit_events(
    conn: AsyncConnection,
    tenant_id: str,
    *,
    action: str | None = None,
    subject_type: str | None = None,
    subject_id: str | None = None,
    limit: int = 100,
) -> list[dict]:
    clauses = ["tenant_id = %s"]
    params: list = [tenant_id]
    if action:
        clauses.append("action = %s")
        params.append(action)
    if subject_type:
        clauses.append("subject_type = %s")
        params.append(subject_type)
    if subject_id:
        clauses.append("subject_id = %s")
        params.append(subject_id)
    params.append(min(limit, 200))
    cur = await conn.execute(
        f"""
        SELECT audit_event_id, action, actor_kind, actor_id,
               subject_type, subject_id, detail, correlation_id,
               occurred_at
          FROM audit.audit_event
         WHERE {' AND '.join(clauses)}
         ORDER BY occurred_at DESC
         LIMIT %s
        """,
        tuple(params))
    keys = ("audit_event_id", "action", "actor_kind", "actor_id",
            "subject_type", "subject_id", "detail", "correlation_id",
            "occurred_at")
    return [dict(zip(keys, r)) for r in await cur.fetchall()]
