"""Capacity metrics — ingestão, thresholds e forecast simples por regressão linear."""
from __future__ import annotations

import math
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator

from shared import access
from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/capacity", tags=["capacity"])

VALID_METRICS = {"cpu", "memory", "disk", "swap", "iops", "bandwidth", "connections", "load"}
MAX_BATCH = 500
FORECAST_POINTS = 100  # data points used for linear regression


def _require_ctx(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    pid = ctx.get("principal_id")
    if not tid or not pid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid, pid


async def _require_operate(request: Request) -> tuple[str, str]:
    tid, pid = _require_ctx(request)
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, pid, tid)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")
    return tid, pid


def _linear_forecast(values: list[float], steps: int = 24) -> list[float]:
    """Simple OLS linear regression to extrapolate `steps` future points."""
    n = len(values)
    if n < 3:
        return []
    xs = list(range(n))
    sx = sum(xs)
    sy = sum(values)
    sxy = sum(x * y for x, y in zip(xs, values))
    sxx = sum(x * x for x in xs)
    denom = n * sxx - sx * sx
    if denom == 0:
        return [values[-1]] * steps
    slope = (n * sxy - sx * sy) / denom
    intercept = (sy - slope * sx) / n
    return [max(0.0, min(100.0, intercept + slope * (n + i))) for i in range(1, steps + 1)]


# ---------------------------------------------------------------------------
# Models

class MetricSample(BaseModel):
    resource_id: str
    resource_name: Optional[str] = None
    metric_name: str
    value: float
    unit: str = "%"

    @field_validator("metric_name")
    @classmethod
    def validate_metric(cls, v: str) -> str:
        if v not in VALID_METRICS:
            raise ValueError(f"metric_name must be one of {sorted(VALID_METRICS)}")
        return v

    @field_validator("value")
    @classmethod
    def validate_value(cls, v: float) -> float:
        if not math.isfinite(v) or v < 0:
            raise ValueError("value must be a non-negative finite number")
        return round(v, 4)

    @field_validator("resource_id")
    @classmethod
    def validate_resource(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("resource_id must not be empty")
        return v.strip()


class MetricBatch(BaseModel):
    samples: list[MetricSample]

    @field_validator("samples")
    @classmethod
    def validate_batch(cls, v: list[MetricSample]) -> list[MetricSample]:
        if not v:
            raise ValueError("at least one sample required")
        if len(v) > MAX_BATCH:
            raise ValueError(f"batch limited to {MAX_BATCH} samples")
        return v


class ThresholdUpsert(BaseModel):
    resource_id: str
    metric_name: str
    warn_pct: float = 70.0
    crit_pct: float = 90.0
    enabled: bool = True

    @field_validator("metric_name")
    @classmethod
    def validate_metric(cls, v: str) -> str:
        if v not in VALID_METRICS:
            raise ValueError(f"metric_name must be one of {sorted(VALID_METRICS)}")
        return v

    @field_validator("warn_pct", "crit_pct")
    @classmethod
    def validate_pct(cls, v: float) -> float:
        if not (0 <= v <= 100):
            raise ValueError("threshold must be between 0 and 100")
        return round(v, 2)


# ---------------------------------------------------------------------------
# Ingest

@router.post("/metrics", status_code=201)
async def ingest_metric(request: Request, body: MetricSample) -> dict:
    tid, pid = await _require_operate(request)
    async with db_tenant_connection(tid) as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.capacity_metric (tenant_id, resource_id, resource_name, metric_name, value, unit)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING metric_id, sampled_at
            """,
            (tid, body.resource_id, body.resource_name, body.metric_name, body.value, body.unit),
        )
        row = await cur.fetchone()
    return {"metric_id": str(row[0]), "sampled_at": row[1].isoformat()}


@router.post("/metrics/batch", status_code=201)
async def ingest_batch(request: Request, body: MetricBatch) -> dict:
    tid, pid = await _require_operate(request)
    async with db_tenant_connection(tid) as conn:
        await conn.executemany(
            """
            INSERT INTO g1.capacity_metric (tenant_id, resource_id, resource_name, metric_name, value, unit)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            [
                (tid, s.resource_id, s.resource_name, s.metric_name, s.value, s.unit)
                for s in body.samples
            ],
        )
    return {"inserted": len(body.samples)}


# ---------------------------------------------------------------------------
# Resources (latest values + threshold state)

@router.get("/resources")
async def list_resources(request: Request, hours: int = 1) -> list[dict]:
    tid, _ = _require_ctx(request)
    hours = max(1, min(hours, 168))
    async with db_tenant_connection(tid) as conn:
        cur = await conn.execute(
            """
            WITH latest AS (
                SELECT DISTINCT ON (resource_id, metric_name)
                    resource_id, resource_name, metric_name, value, unit, sampled_at
                FROM g1.capacity_metric
                WHERE tenant_id = %s
                  AND sampled_at >= now() - make_interval(hours => %s)
                ORDER BY resource_id, metric_name, sampled_at DESC
            ),
            thresholds AS (
                SELECT resource_id, metric_name, warn_pct, crit_pct, enabled
                FROM g1.capacity_threshold
                WHERE tenant_id = %s AND enabled = true
            )
            SELECT l.resource_id, l.resource_name, l.metric_name, l.value, l.unit, l.sampled_at,
                   t.warn_pct, t.crit_pct,
                   CASE
                     WHEN t.crit_pct IS NOT NULL AND l.value >= t.crit_pct THEN 'critical'
                     WHEN t.warn_pct IS NOT NULL AND l.value >= t.warn_pct THEN 'warning'
                     ELSE 'ok'
                   END AS state
            FROM latest l
            LEFT JOIN thresholds t USING (resource_id, metric_name)
            ORDER BY l.resource_id, l.metric_name
            """,
            (tid, hours, tid),
        )
        rows = await cur.fetchall()

    # Group by resource
    resources: dict[str, dict] = {}
    for r in rows:
        rid, rname, mname, value, unit, sampled_at, warn, crit, state = r
        if rid not in resources:
            resources[rid] = {"resource_id": rid, "resource_name": rname, "metrics": []}
        resources[rid]["metrics"].append({
            "metric_name": mname,
            "value": float(value) if value is not None else None,
            "unit": unit,
            "sampled_at": sampled_at.isoformat(),
            "warn_pct": float(warn) if warn is not None else None,
            "crit_pct": float(crit) if crit is not None else None,
            "state": state,
        })
    return list(resources.values())


@router.get("/summary")
async def get_summary(request: Request) -> dict:
    tid, _ = _require_ctx(request)
    async with db_tenant_connection(tid) as conn:
        cur = await conn.execute(
            """
            WITH latest AS (
                SELECT DISTINCT ON (resource_id, metric_name)
                    resource_id, metric_name, value
                FROM g1.capacity_metric
                WHERE tenant_id = %s AND sampled_at >= now() - interval '1 hour'
                ORDER BY resource_id, metric_name, sampled_at DESC
            ),
            thresholds AS (
                SELECT resource_id, metric_name, warn_pct, crit_pct
                FROM g1.capacity_threshold
                WHERE tenant_id = %s AND enabled = true
            ),
            states AS (
                SELECT
                  CASE WHEN t.crit_pct IS NOT NULL AND l.value >= t.crit_pct THEN 'critical'
                       WHEN t.warn_pct IS NOT NULL AND l.value >= t.warn_pct THEN 'warning'
                       ELSE 'ok' END AS state
                FROM latest l LEFT JOIN thresholds t USING (resource_id, metric_name)
            )
            SELECT state, COUNT(*) FROM states GROUP BY state
            """,
            (tid, tid),
        )
        rows = await cur.fetchall()
    counts = {"ok": 0, "warning": 0, "critical": 0}
    for row in rows:
        state, cnt = row
        counts[state] = int(cnt)
    return counts


# ---------------------------------------------------------------------------
# Thresholds

@router.get("/thresholds")
async def list_thresholds(request: Request) -> list[dict]:
    tid, _ = _require_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT threshold_id, resource_id, metric_name, warn_pct, crit_pct, enabled, created_at "
            "FROM g1.capacity_threshold WHERE tenant_id = %s ORDER BY resource_id, metric_name",
            (tid,),
        )
        rows = await cur.fetchall()
    return [
        {
            "threshold_id": str(r[0]),
            "resource_id": r[1],
            "metric_name": r[2],
            "warn_pct": float(r[3]),
            "crit_pct": float(r[4]),
            "enabled": r[5],
            "created_at": r[6].isoformat(),
        }
        for r in rows
    ]


@router.post("/thresholds", status_code=201)
async def upsert_threshold(request: Request, body: ThresholdUpsert) -> dict:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.capacity_threshold
                (tenant_id, resource_id, metric_name, warn_pct, crit_pct, enabled, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, resource_id, metric_name)
            DO UPDATE SET warn_pct = EXCLUDED.warn_pct, crit_pct = EXCLUDED.crit_pct,
                          enabled = EXCLUDED.enabled
            RETURNING threshold_id
            """,
            (tid, body.resource_id, body.metric_name, body.warn_pct, body.crit_pct, body.enabled, pid),
        )
        row = await cur.fetchone()
        await record_audit_event(conn, pid, tid, "capacity.threshold_upserted",
                                 {"resource_id": body.resource_id, "metric_name": body.metric_name,
                                  "warn_pct": body.warn_pct, "crit_pct": body.crit_pct})
    return {"threshold_id": str(row[0])}


@router.delete("/thresholds/{threshold_id}", status_code=204)
async def delete_threshold(request: Request, threshold_id: str) -> None:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM g1.capacity_threshold WHERE threshold_id = %s AND tenant_id = %s RETURNING threshold_id",
            (threshold_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="not found")
        await record_audit_event(conn, pid, tid, "capacity.threshold_deleted", {"threshold_id": threshold_id})


# ---------------------------------------------------------------------------
# Forecast

@router.get("/forecast")
async def get_forecast(request: Request, resource_id: str, metric_name: str, hours_ahead: int = 24) -> dict:
    tid, _ = _require_ctx(request)
    if metric_name not in VALID_METRICS:
        raise HTTPException(status_code=422, detail=f"metric_name must be one of {sorted(VALID_METRICS)}")
    hours_ahead = max(1, min(hours_ahead, 168))

    async with db_tenant_connection(tid) as conn:
        cur = await conn.execute(
            """
            SELECT value, sampled_at FROM g1.capacity_metric
            WHERE tenant_id = %s AND resource_id = %s AND metric_name = %s
              AND sampled_at >= now() - interval '7 days'
            ORDER BY sampled_at ASC
            LIMIT %s
            """,
            (tid, resource_id, metric_name, FORECAST_POINTS),
        )
        rows = await cur.fetchall()

    if len(rows) < 3:
        return {"resource_id": resource_id, "metric_name": metric_name, "forecast": [], "insufficient_data": True}

    values = [float(r[0]) for r in rows]
    forecast = _linear_forecast(values, steps=hours_ahead)

    return {
        "resource_id": resource_id,
        "metric_name": metric_name,
        "current_value": values[-1],
        "forecast": [{"step": i + 1, "value": round(v, 2)} for i, v in enumerate(forecast)],
        "trend": "increasing" if forecast[-1] > values[-1] else "decreasing" if forecast[-1] < values[-1] else "stable",
        "insufficient_data": False,
    }


# ---------------------------------------------------------------------------
# Trend (time-series for chart)

@router.get("/trend")
async def get_trend(request: Request, resource_id: str, metric_name: str, hours: int = 24) -> list[dict]:
    tid, _ = _require_ctx(request)
    hours = max(1, min(hours, 168))
    async with db_tenant_connection(tid) as conn:
        cur = await conn.execute(
            """
            SELECT
                time_bucket('1 hour', sampled_at) AS bucket,
                AVG(value)::numeric(10,2) AS avg_value,
                MAX(value)::numeric(10,2) AS max_value
            FROM g1.capacity_metric
            WHERE tenant_id = %s AND resource_id = %s AND metric_name = %s
              AND sampled_at >= now() - make_interval(hours => %s)
            GROUP BY bucket
            ORDER BY bucket ASC
            """,
            (tid, resource_id, metric_name, hours),
        )
        rows = await cur.fetchall()
    return [
        {
            "bucket": r[0].isoformat(),
            "avg": float(r[1]) if r[1] is not None else None,
            "max": float(r[2]) if r[2] is not None else None,
        }
        for r in rows
    ]
