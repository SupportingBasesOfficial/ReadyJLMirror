"""G13 FinOps hourly usage metering worker.

Aggregates observable usage from monitoring/alerting tables and writes
meter rows to g1.usage_meters. G26 adds a BillingAdapter call after
each local meter write so the seam to a real provider is wired.
"""
from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone

from providers.billing import BillingError, billing_adapter

logger = logging.getLogger("workers.finops")

_adapter = None


def _get_adapter():
    global _adapter
    if _adapter is None:
        try:
            _adapter = billing_adapter()
        except BillingError as exc:
            logger.error("billing: adapter init failed: %s", exc)
            from providers.billing import StubBilling
            _adapter = StubBilling()
    return _adapter

_METER_INTERVAL = 3600  # 1 hour
_last_run: float = 0.0


def _process_pending(conn) -> int:
    global _last_run

    now = time.time()
    if now - _last_run < _METER_INTERVAL:
        return 0

    try:
        count = _run_all_tenants(conn)
        _last_run = time.time()
        return count
    except Exception:
        conn.rollback()
        logger.exception("finops: metering run failed")
        return 0


def _run_all_tenants(conn) -> int:
    cur = conn.execute("SELECT tenant_id FROM g1.tenants LIMIT 20")
    tenants = [row[0] for row in cur.fetchall()]
    total = 0
    for tenant_id in tenants:
        try:
            total += _meter_tenant(conn, tenant_id)
        except Exception:
            conn.rollback()
            logger.exception("finops: tenant %s metering failed", tenant_id)
    return total


def _meter_tenant(conn, tenant_id: str) -> int:
    contract_id = _resolve_contract(conn, tenant_id)
    meters = _compute_meters(conn, tenant_id)
    now_ts = datetime.now(timezone.utc)
    window_start = now_ts.replace(minute=0, second=0, microsecond=0)
    window_end = now_ts

    adapter = _get_adapter()
    count = 0
    for meter_name, quantity in meters:
        usage_id = f"meter-{uuid.uuid4().hex[:16]}"
        conn.execute(
            """
            INSERT INTO g1.usage_meters
                (usage_id, tenant_id, contract_id, meter,
                 quantity, window_start, window_end)
            VALUES (%s, %s, %s, %s, %s,
                    now() - interval '1 hour', now())
            """,
            (usage_id, tenant_id, contract_id, meter_name, quantity),
        )
        try:
            adapter.submit_usage(
                tenant_id=tenant_id,
                meter=meter_name,
                quantity=float(quantity),
                window_start=window_start,
                window_end=window_end,
                contract_id=contract_id,
            )
        except BillingError as exc:
            logger.warning("billing: submit failed tenant=%s meter=%s: %s",
                           tenant_id, meter_name, exc)
        count += 1

    conn.commit()
    logger.info("finops: tenant %s → %d meter rows", tenant_id, count)
    return count


def _resolve_contract(conn, tenant_id: str) -> str | None:
    cur = conn.execute(
        """
        SELECT c.contract_id
          FROM g1.contracts c
          JOIN g1.commercial_accounts ca ON c.account_id = ca.account_id
          JOIN g1.tenants t ON t.organization_id = ca.organization_id
         WHERE t.tenant_id = %s AND c.state = 'active'
         LIMIT 1
        """,
        (tenant_id,),
    )
    row = cur.fetchone()
    return row[0] if row else None


def _compute_meters(conn, tenant_id: str) -> list[tuple[str, int]]:
    results = []

    def count_query(sql, *args):
        cur = conn.execute(sql, args)
        return cur.fetchone()[0] or 0

    results.append((
        "monitoring_sources_active",
        count_query(
            "SELECT count(*) FROM monitoring.monitoring_source WHERE tenant_id = %s",
            tenant_id,
        ),
    ))

    results.append((
        "monitoring_resources_observed",
        count_query(
            """SELECT count(*) FROM monitoring.monitoring_resource
               WHERE tenant_id = %s AND (presence_state IS NULL OR presence_state != 'removed')""",
            tenant_id,
        ),
    ))

    results.append((
        "alerting_alerts_active",
        count_query(
            "SELECT count(*) FROM alerting.alert WHERE tenant_id = %s AND lifecycle_state = 'active'",
            tenant_id,
        ),
    ))

    results.append((
        "alert_transitions_24h",
        count_query(
            """SELECT count(*) FROM alerting.alert_transition t
               JOIN alerting.alert a USING (alert_id)
               WHERE a.tenant_id = %s AND t.occurred_at > now() - interval '24 hours'""",
            tenant_id,
        ),
    ))

    # AIOps findings — graceful if aiops schema missing
    try:
        results.append((
            "aiops_findings_active",
            count_query(
                """SELECT count(*) FROM aiops.finding
                   WHERE tenant_id = %s AND dismissed_at IS NULL AND expires_at > now()""",
                tenant_id,
            ),
        ))
    except Exception:
        results.append(("aiops_findings_active", 0))

    return results
