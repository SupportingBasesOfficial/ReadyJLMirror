"""Config Drift auto-scan worker — runs for all active tenants each tick.

Mirrors the logic in api/routers/config_drift.py POST /scan but runs
synchronously via psycopg and processes every tenant with baselines.
"""

from __future__ import annotations

import logging
import uuid

import psycopg

logger = logging.getLogger("workers.config_drift")


def _scan_tenant(conn: psycopg.Connection, tenant_id: str) -> int:
    conn.execute(
        "SELECT set_config('jlmirror.tenant_id', %s, false)", (tenant_id,))

    cur = conn.execute(
        """
        SELECT baseline_id, source_id, resource_ref, config_key, expected_value
          FROM monitoring.config_baseline
         WHERE tenant_id = %s
        """,
        (tenant_id,),
    )
    baselines = cur.fetchall()
    if not baselines:
        conn.rollback()
        return 0

    new_drifts = 0
    for (bid, source_id, resource_ref, config_key, expected) in baselines:
        # Latest metric observation for this resource + key
        cur2 = conn.execute(
            """
            SELECT CAST(value AS TEXT)
              FROM monitoring.metric_observation
             WHERE tenant_id = %s AND source_id = %s
               AND resource_ref = %s AND item_key = %s
             ORDER BY observed_at DESC
             LIMIT 1
            """,
            (tenant_id, source_id, resource_ref, config_key),
        )
        row = cur2.fetchone()
        if row is None:
            continue

        actual = str(row[0]).strip()
        if actual == str(expected).strip():
            continue

        # Skip if an open event already exists for this baseline
        cur3 = conn.execute(
            """
            SELECT 1 FROM monitoring.config_drift_event
             WHERE baseline_id = %s AND tenant_id = %s AND state = 'open'
             LIMIT 1
            """,
            (bid, tenant_id),
        )
        if cur3.fetchone():
            continue

        drift_id = str(uuid.uuid4())
        conn.execute(
            """
            INSERT INTO monitoring.config_drift_event
                (drift_id, baseline_id, tenant_id, source_id,
                 resource_ref, config_key, expected_value, actual_value)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (drift_id, bid, tenant_id, source_id,
             resource_ref, config_key, expected, actual),
        )
        new_drifts += 1
        logger.info(
            "drift detected tenant=%s resource=%s key=%s expected=%r actual=%r",
            tenant_id, resource_ref, config_key, expected, actual,
        )

    if new_drifts:
        conn.commit()
    else:
        conn.rollback()
    return new_drifts


def _process_pending(conn: psycopg.Connection) -> int:
    try:
        cur = conn.execute(
            "SELECT tenant_id FROM g1.tenants WHERE state='active'")
        tenants = [r[0] for r in cur.fetchall()]
        conn.rollback()
    except Exception:
        conn.rollback()
        logger.exception("config_drift: failed to list tenants")
        return 0

    total = 0
    for tenant_id in tenants:
        try:
            total += _scan_tenant(conn, tenant_id)
        except Exception:
            conn.rollback()
            logger.exception("config_drift scan failed tenant=%s", tenant_id)
    return total
