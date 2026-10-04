"""G31 SLA breach detection worker.

_process_pending() is called on every tick by run_all.py.
For each tenant with active SLA trackers:
- Response breach: deadline passed + alert unacknowledged → flag + log.
- Resolve breach: deadline passed + alert unresolved → flag + log.

Idempotent: breach flag guards the UPDATE; INSERT uses a unique breach_id
(random, no UNIQUE constraint on the table itself) — at-most-once per flag flip.
"""

from __future__ import annotations

import logging
import secrets

import psycopg

logger = logging.getLogger(__name__)


def _process_pending(conn: psycopg.Connection) -> int:
    breaches = 0

    cur = conn.execute(
        "SELECT DISTINCT tenant_id FROM g1.sla_alert_tracker WHERE resolved_at IS NULL"
    )
    tenants = [r[0] for r in cur.fetchall()]

    for tenant_id in tenants:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id', %s, false)",
            (tenant_id,))

        # Response breach
        rcur = conn.execute(
            """
            SELECT tracker_id, alert_id, sla_id, response_deadline
              FROM g1.sla_alert_tracker
             WHERE tenant_id = %s
               AND acknowledged_at IS NULL
               AND response_breached = false
               AND response_deadline < now()
            """,
            (tenant_id,),
        )
        for tracker_id, alert_id, sla_id, deadline in rcur.fetchall():
            try:
                breach_id = f"slabr:{secrets.token_urlsafe(16)}"
                conn.execute(
                    """
                    INSERT INTO g1.sla_breach
                        (breach_id, tenant_id, alert_id, sla_id,
                         breach_type, deadline_was)
                    VALUES (%s, %s, %s, %s, 'response', %s)
                    """,
                    (breach_id, tenant_id, alert_id, sla_id, deadline),
                )
                conn.execute(
                    "UPDATE g1.sla_alert_tracker SET response_breached=true "
                    "WHERE tracker_id=%s AND response_breached=false",
                    (tracker_id,),
                )
                conn.commit()
                breaches += 1
                logger.warning(
                    "SLA response breach: tenant=%s alert=%s sla=%s",
                    tenant_id, alert_id, sla_id)
            except Exception:
                conn.rollback()
                logger.exception(
                    "Failed to record response breach tracker=%s", tracker_id)

        # Resolve breach
        rcur = conn.execute(
            """
            SELECT tracker_id, alert_id, sla_id, resolve_deadline
              FROM g1.sla_alert_tracker
             WHERE tenant_id = %s
               AND resolved_at IS NULL
               AND resolve_breached = false
               AND resolve_deadline < now()
            """,
            (tenant_id,),
        )
        for tracker_id, alert_id, sla_id, deadline in rcur.fetchall():
            try:
                breach_id = f"slabr:{secrets.token_urlsafe(16)}"
                conn.execute(
                    """
                    INSERT INTO g1.sla_breach
                        (breach_id, tenant_id, alert_id, sla_id,
                         breach_type, deadline_was)
                    VALUES (%s, %s, %s, %s, 'resolve', %s)
                    """,
                    (breach_id, tenant_id, alert_id, sla_id, deadline),
                )
                conn.execute(
                    "UPDATE g1.sla_alert_tracker SET resolve_breached=true "
                    "WHERE tracker_id=%s AND resolve_breached=false",
                    (tracker_id,),
                )
                conn.commit()
                breaches += 1
                logger.warning(
                    "SLA resolve breach: tenant=%s alert=%s sla=%s",
                    tenant_id, alert_id, sla_id)
            except Exception:
                conn.rollback()
                logger.exception(
                    "Failed to record resolve breach tracker=%s", tracker_id)

    return breaches
