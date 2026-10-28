"""Config Drift Detection — baseline comparison for monitored resources.

Tenants define expected values (baselines) for device/resource configuration
keys. A scan compares current observed values against baselines and records
drift events. Operators can acknowledge or resolve events.
"""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared.audit import record_audit_event
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/drift", tags=["drift"])


def _require_tenant(request: Request) -> str:
    tid = (getattr(request.state, "jlmirror_context", None) or {}).get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


def _principal(request: Request) -> str:
    return ((getattr(request.state, "jlmirror_context", None) or {})
            .get("principal_id") or "unknown")


# ── Models ─────────────────────────────────────────────────────────────────


class CreateBaseline(BaseModel):
    source_id: str
    resource_ref: str
    config_key: str
    expected_value: str


# ── Baselines ──────────────────────────────────────────────────────────────


@router.get("/baselines")
async def list_baselines(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT baseline_id, source_id, resource_ref, config_key,
                   expected_value, captured_at, captured_by
              FROM monitoring.config_baseline
             WHERE tenant_id = %s
             ORDER BY resource_ref, config_key
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.post("/baselines", status_code=status.HTTP_201_CREATED)
async def create_baseline(request: Request, body: CreateBaseline) -> dict:
    tenant_id = _require_tenant(request)
    actor = _principal(request)
    baseline_id = str(uuid.uuid4())
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO monitoring.config_baseline
                (baseline_id, tenant_id, source_id, resource_ref,
                 config_key, expected_value, captured_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, source_id, resource_ref, config_key)
            DO UPDATE SET expected_value = EXCLUDED.expected_value,
                          captured_at    = NOW(),
                          captured_by    = EXCLUDED.captured_by
            RETURNING baseline_id
            """,
            (baseline_id, tenant_id, body.source_id, body.resource_ref,
             body.config_key, body.expected_value, actor),
        )
        await record_audit_event(
            conn, tenant_id,
            action="drift.baseline.created",
            actor_kind="human_browser_session", actor_id=actor,
            subject_type="config_baseline", subject_id=baseline_id,
        )
        await conn.commit()
    return {"baseline_id": baseline_id, "status": "ok"}


@router.delete("/baselines/{baseline_id}")
async def delete_baseline(request: Request, baseline_id: str) -> dict:
    tenant_id = _require_tenant(request)
    actor = _principal(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "DELETE FROM monitoring.config_baseline "
            "WHERE baseline_id = %s AND tenant_id = %s",
            (baseline_id, tenant_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="baseline not found")
        await record_audit_event(
            conn, tenant_id,
            action="drift.baseline.deleted",
            actor_kind="human_browser_session", actor_id=actor,
            subject_type="config_baseline", subject_id=baseline_id,
        )
        await conn.commit()
    return {"baseline_id": baseline_id, "deleted": True}


# ── Scan ───────────────────────────────────────────────────────────────────


@router.post("/scan")
async def run_scan(request: Request) -> dict:
    """Compare all baselines against the most recent observed value.

    For each baseline, fetch the latest metric_observation matching
    (tenant_id, source_id, resource_ref, item_key=config_key). If the
    current value differs from expected_value, record a drift event
    (de-duplicated: skip if an open event already exists for same baseline).
    """
    tenant_id = _require_tenant(request)
    actor = _principal(request)
    new_events: list[dict] = []

    async with db_tenant_connection(tenant_id) as conn:
        # Fetch baselines
        cur = await conn.execute(
            """
            SELECT baseline_id, source_id, resource_ref,
                   config_key, expected_value
              FROM monitoring.config_baseline
             WHERE tenant_id = %s
            """,
            (tenant_id,),
        )
        baselines = await cur.fetchall()
        scanned = len(baselines)

        for (bid, source_id, resource_ref, config_key, expected) in baselines:
            # Latest observation for this resource+key
            cur2 = await conn.execute(
                """
                SELECT CAST(value AS TEXT)
                  FROM monitoring.metric_observation
                 WHERE tenant_id = %s
                   AND source_id = %s
                   AND resource_ref = %s
                   AND item_key = %s
                 ORDER BY observed_at DESC
                 LIMIT 1
                """,
                (tenant_id, source_id, resource_ref, config_key),
            )
            row = await cur2.fetchone()
            if row is None:
                continue  # no data yet for this metric

            actual = str(row[0]).strip()
            if actual == expected.strip():
                continue  # no drift

            # Skip if open event already exists for this baseline
            cur3 = await conn.execute(
                """
                SELECT 1 FROM monitoring.config_drift_event
                 WHERE baseline_id = %s AND tenant_id = %s AND state = 'open'
                 LIMIT 1
                """,
                (bid, tenant_id),
            )
            if await cur3.fetchone():
                continue

            drift_id = str(uuid.uuid4())
            await conn.execute(
                """
                INSERT INTO monitoring.config_drift_event
                    (drift_id, baseline_id, tenant_id, source_id,
                     resource_ref, config_key, expected_value, actual_value)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (drift_id, bid, tenant_id, source_id,
                 resource_ref, config_key, expected, actual),
            )
            new_events.append({
                "drift_id": drift_id,
                "resource_ref": resource_ref,
                "config_key": config_key,
                "expected": expected,
                "actual": actual,
            })

        await record_audit_event(
            conn, tenant_id,
            action="drift.scan.completed",
            actor_kind="human_browser_session", actor_id=actor,
            subject_type="tenant", subject_id=tenant_id,
        )
        await conn.commit()

    return {
        "scanned": scanned,
        "drifts_found": len(new_events),
        "new_events": new_events,
    }


# ── Events ─────────────────────────────────────────────────────────────────


@router.get("/events")
async def list_events(
    request: Request,
    state: Optional[str] = None,
    source_id: Optional[str] = None,
) -> list:
    tenant_id = _require_tenant(request)
    filters = ["tenant_id = %s"]
    params: list = [tenant_id]
    if state:
        filters.append("state = %s")
        params.append(state)
    if source_id:
        filters.append("source_id = %s")
        params.append(source_id)
    where = " AND ".join(filters)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            f"""
            SELECT drift_id, baseline_id, source_id, resource_ref,
                   config_key, expected_value, actual_value,
                   detected_at, acknowledged_at, acknowledged_by, state
              FROM monitoring.config_drift_event
             WHERE {where}
             ORDER BY detected_at DESC
             LIMIT 200
            """,
            params,
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.post("/events/{drift_id}/acknowledge")
async def acknowledge_event(request: Request, drift_id: str) -> dict:
    tenant_id = _require_tenant(request)
    actor = _principal(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            UPDATE monitoring.config_drift_event
               SET state = 'acknowledged',
                   acknowledged_at = NOW(),
                   acknowledged_by = %s
             WHERE drift_id = %s AND tenant_id = %s AND state = 'open'
            """,
            (actor, drift_id, tenant_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404,
                                detail="drift event not found or not open")
        await record_audit_event(
            conn, tenant_id,
            action="drift.event.acknowledged",
            actor_kind="human_browser_session", actor_id=actor,
            subject_type="config_drift_event", subject_id=drift_id,
        )
        await conn.commit()
    return {"drift_id": drift_id, "state": "acknowledged"}


@router.post("/events/{drift_id}/resolve")
async def resolve_event(request: Request, drift_id: str) -> dict:
    tenant_id = _require_tenant(request)
    actor = _principal(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            UPDATE monitoring.config_drift_event
               SET state = 'resolved'
             WHERE drift_id = %s AND tenant_id = %s
               AND state IN ('open', 'acknowledged')
            """,
            (drift_id, tenant_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404,
                                detail="drift event not found or already resolved")
        await record_audit_event(
            conn, tenant_id,
            action="drift.event.resolved",
            actor_kind="human_browser_session", actor_id=actor,
            subject_type="config_drift_event", subject_id=drift_id,
        )
        await conn.commit()
    return {"drift_id": drift_id, "state": "resolved"}


# ── Summary ────────────────────────────────────────────────────────────────


@router.get("/summary")
async def get_summary(request: Request) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT COUNT(*) FROM monitoring.config_baseline WHERE tenant_id = %s",
            (tenant_id,),
        )
        total_baselines = (await cur.fetchone())[0]

        cur2 = await conn.execute(
            "SELECT COUNT(*) FROM monitoring.config_drift_event "
            "WHERE tenant_id = %s AND state = 'open'",
            (tenant_id,),
        )
        open_drifts = (await cur2.fetchone())[0]

        cur3 = await conn.execute(
            "SELECT MAX(detected_at) FROM monitoring.config_drift_event "
            "WHERE tenant_id = %s",
            (tenant_id,),
        )
        last_row = await cur3.fetchone()
        last_scan_at = last_row[0].isoformat() if last_row and last_row[0] else None

    return {
        "total_baselines": total_baselines,
        "open_drifts": open_drifts,
        "last_scan_at": last_scan_at,
    }
