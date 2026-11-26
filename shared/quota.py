"""G13 Phase 3 — plan-based quota enforcement.

check_quota() is injected at every resource-creation endpoint.
It is a read-only gate: when the limit is not breached it returns
immediately without any DB write. When a limit IS breached it fires
a background task (_record_and_notify) that persists the event and
collects notification contacts, then raises HTTP 402.

Quota resolution:
  g1.contracts  (tenant → plan_ref, state='active')
    └─ g1.plan_quotas  (plan_id + quota_key → quota_value)

quota_value = -1  → unlimited (always pass).
No active contract or no matching quota row → unlimited (always pass).
"""

from __future__ import annotations

import asyncio
import logging
import secrets

from fastapi import HTTPException, status

from shared.audit import record_audit_event
from shared.db import db_connection

logger = logging.getLogger(__name__)


async def check_quota(
    conn,
    tenant_id: str,
    quota_key: str,
    current_count: int,
) -> None:
    """Hard-block creation when the plan quota is exhausted.

    Call inside the creation endpoint's existing DB connection context,
    before the actual INSERT. No writes happen when the quota is not
    exceeded — this is purely a SELECT gate.

    Raises HTTP 402 with body::

        {"code": "quota_exceeded", "quota_key": "...",
         "limit": N, "current": N}
    """
    cur = await conn.execute(
        """
        SELECT pq.quota_value
          FROM g1.tenants t
          JOIN g1.commercial_accounts ca
            ON ca.organization_id = t.organization_id
          JOIN g1.contracts c
            ON c.account_id = ca.account_id
           AND c.state = 'active'
          JOIN g1.plan_quotas pq
            ON pq.plan_id = c.plan_ref
           AND pq.quota_key = %s
         WHERE t.tenant_id = %s
         ORDER BY pq.quota_value DESC
         LIMIT 1
        """,
        (quota_key, tenant_id),
    )
    row = await cur.fetchone()
    if row is None or row[0] == -1:
        return  # unlimited or no plan configured

    limit: int = row[0]
    if current_count >= limit:
        # Fire-and-forget: persist event + collect contacts.
        # Uses its own connection to avoid polluting the caller's tx.
        asyncio.create_task(
            _record_and_notify(tenant_id, quota_key, current_count, limit)
        )
        raise HTTPException(
            status_code=status.HTTP_402_PAYMENT_REQUIRED,
            detail={
                "code": "quota_exceeded",
                "quota_key": quota_key,
                "limit": limit,
                "current": current_count,
            },
        )


# ---------------------------------------------------------------------------
# Background: persist event + collect notification contacts
# ---------------------------------------------------------------------------


async def _record_and_notify(
    tenant_id: str,
    quota_key: str,
    current_count: int,
    limit: int,
) -> None:
    """Persist quota_event + audit row + log notification recipients.

    Runs as a background asyncio task — never blocks the HTTP response.
    All DB work is in its own connection/transaction.
    """
    event_id = f"qev_{secrets.token_urlsafe(12)}"
    try:
        async with db_connection() as conn:
            # Durable audit trail
            await record_audit_event(
                conn, tenant_id,
                action="quota.exceeded",
                actor_kind="system",
                actor_id="quota_enforcement",
                subject_type="quota",
                subject_id=quota_key,
                detail={
                    "quota_event_id": event_id,
                    "quota_key": quota_key,
                    "limit": limit,
                    "current": current_count,
                },
            )

            # Persist quota event row
            await conn.execute(
                """
                INSERT INTO g1.quota_events
                    (quota_event_id, tenant_id, quota_key,
                     current_count, quota_limit)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (event_id, tenant_id, quota_key, current_count, limit),
            )

            # --- Collect notification recipients ---

            # 1. JL platform admins
            cur = await conn.execute(
                """
                SELECT p.email, p.display_name
                  FROM g1.principals p
                 WHERE p.kind = 'platform_admin_principal'
                   AND p.active = TRUE
                   AND p.email IS NOT NULL
                """,
            )
            jl_admins = await cur.fetchall()

            # 2. Tenant's own admins (responsible)
            cur = await conn.execute(
                """
                SELECT p.email, p.display_name
                  FROM g1.principals p
                  JOIN g1.tenant_memberships tm
                    ON tm.principal_id = p.principal_id
                 WHERE tm.tenant_id = %s
                   AND tm.role = 'admin'
                   AND p.active = TRUE
                   AND p.email IS NOT NULL
                """,
                (tenant_id,),
            )
            tenant_admins = await cur.fetchall()

            # 3. If tenant belongs to a client_company, also notify
            #    the MSP org admins (best-effort — may return 0 rows
            #    when the relationship doesn't exist).
            cur = await conn.execute(
                """
                SELECT DISTINCT p.email, p.display_name
                  FROM g1.client_companies cc
                  JOIN g1.tenant_memberships tm
                    ON tm.tenant_id = cc.msp_tenant_id
                  JOIN g1.principals p
                    ON p.principal_id = tm.principal_id
                 WHERE cc.client_tenant_id = %s
                   AND tm.role = 'admin'
                   AND p.active = TRUE
                   AND p.email IS NOT NULL
                """,
                (tenant_id,),
            )
            msp_admins = await cur.fetchall()

            # Mark notification dispatched
            await conn.execute(
                "UPDATE g1.quota_events SET notified_at = now() "
                "WHERE quota_event_id = %s",
                (event_id,),
            )
            await conn.commit()

        # Structured notification log — real delivery hooks into the
        # G9 notification adapter in Phase 3b (email_smtp / whatsapp).
        logger.warning(
            "quota_exceeded_notification_dispatched "
            "event_id=%s tenant=%s quota_key=%s current=%d limit=%d "
            "jl_admins=%r tenant_admins=%r msp_admins=%r",
            event_id, tenant_id, quota_key, current_count, limit,
            [r[0] for r in jl_admins],
            [r[0] for r in tenant_admins],
            [r[0] for r in msp_admins],
        )

    except Exception:  # noqa: BLE001
        logger.exception(
            "quota_notification_failed event_id=%s tenant=%s quota_key=%s",
            event_id, tenant_id, quota_key,
        )
