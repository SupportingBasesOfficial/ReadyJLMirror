"""G12 AIOps — advisory findings + algorithmic intelligence API.

Findings are advisory only: ALERT ≠ AIOPS FINDING.
Anomaly, predictions, and capacity endpoints run directly against
monitoring.metric_observation using statistical SQL (Z-score,
linear regression, daily averages) — no external model required.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel
from typing import Optional

from shared.audit import record_audit_event
from shared.db import db_tenant_connection


def _get_context(request: Request) -> dict:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return ctx

router = APIRouter(prefix="/api/v1/aiops", tags=["aiops"])


def _ser_finding(r) -> dict:
    return {
        "finding_id":         r[0],
        "finding_type":       r[1],
        "severity_hint":      r[2],
        "title":              r[3],
        "explanation":        r[4],
        "evidence_refs":      r[5],
        "confidence":         float(r[6]) if r[6] is not None else None,
        "model_id":           r[7],
        "recommended_action": r[8],
        "created_at":         r[9].isoformat(),
        "expires_at":         r[10].isoformat(),
        "dismissed_at":       r[11].isoformat() if r[11] else None,
    }


@router.get("/findings")
async def list_findings(request: Request, limit: int = 50,
                        include_dismissed: bool = False) -> list[dict]:
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]
    limit = min(limit, 200)
    dismissed_clause = "" if include_dismissed else "AND dismissed_at IS NULL"

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            f"""
            SELECT finding_id, finding_type, severity_hint, title,
                   explanation, evidence_refs, confidence, model_id,
                   recommended_action, created_at, expires_at, dismissed_at
              FROM aiops.finding
             WHERE tenant_id = %s
               {dismissed_clause}
               AND expires_at > now()
             ORDER BY created_at DESC
             LIMIT %s
            """,
            (tenant_id, limit),
        )
        rows = await cur.fetchall()

    return [_ser_finding(r) for r in rows]


@router.get("/findings/{finding_id}")
async def get_finding(request: Request, finding_id: str) -> dict:
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT finding_id, finding_type, severity_hint, title,
                   explanation, evidence_refs, confidence, model_id,
                   recommended_action, created_at, expires_at, dismissed_at
              FROM aiops.finding
             WHERE tenant_id = %s AND finding_id = %s
            """,
            (tenant_id, finding_id),
        )
        row = await cur.fetchone()

    if row is None:
        raise HTTPException(status_code=404, detail="finding not found")

    return _ser_finding(row)


@router.post("/findings/{finding_id}/dismiss")
async def dismiss_finding(request: Request, finding_id: str) -> dict:
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            UPDATE aiops.finding
               SET dismissed_at = now()
             WHERE tenant_id = %s
               AND finding_id = %s
               AND dismissed_at IS NULL
            RETURNING finding_id
            """,
            (tenant_id, finding_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(
                status_code=404, detail="finding not found or already dismissed")
        principal_id = ctx.get("principal_id")
        await record_audit_event(
            conn, tenant_id,
            action="aiops.finding.dismissed",
            actor_kind="principal", actor_id=principal_id,
            subject_type="aiops_finding", subject_id=row[0])
        await conn.commit()

    return {"finding_id": row[0], "dismissed": True}


# ---------------------------------------------------------------------------
# Anomaly Detection — Z-score over metric_observation history
# ---------------------------------------------------------------------------

@router.get("/anomalies")
async def list_anomalies(
    request: Request,
    window_hours: int = Query(default=24, ge=1, le=168),
    threshold: float = Query(default=2.5, ge=1.0, le=10.0),
    source_id: str | None = None,
    limit: int = Query(default=100, le=500),
) -> dict:
    """Detect anomalous metric values using Z-score over historical baseline.

    baseline window = window_hours * 2; anomaly window = window_hours.
    Returns observations where |z_score| > threshold.
    """
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]
    limit = min(limit, 500)

    source_clause = "AND mo.monitoring_source_id = %s" if source_id else ""
    params_stats: list = [tenant_id, window_hours * 2]
    params_recent: list = [tenant_id, window_hours]
    params_join: list = [tenant_id, tenant_id, threshold, limit]
    if source_id:
        params_stats.insert(2, source_id)
        params_recent.insert(2, source_id)

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            f"""
            WITH stats AS (
              SELECT
                mo.monitoring_resource_id,
                mo.metric_definition_id,
                AVG((mo.canonical_value #>> '{{}}')::numeric)    AS mean,
                STDDEV((mo.canonical_value #>> '{{}}')::numeric) AS stddev,
                COUNT(*) AS n
              FROM monitoring.metric_observation mo
             WHERE mo.tenant_id = %s
               AND mo.value_kind IN ('number','integer')
               AND mo.observed_at > now() - make_interval(hours => %s)
               {source_clause}
             GROUP BY mo.monitoring_resource_id, mo.metric_definition_id
            HAVING STDDEV((mo.canonical_value #>> '{{}}')::numeric) > 0
               AND COUNT(*) >= 10
            ),
            recent AS (
              SELECT
                mo.monitoring_resource_id, mo.metric_definition_id,
                (mo.canonical_value #>> '{{}}')::numeric AS value,
                mo.observed_at
              FROM monitoring.metric_observation mo
             WHERE mo.tenant_id = %s
               AND mo.value_kind IN ('number','integer')
               AND mo.observed_at > now() - make_interval(hours => %s)
               {source_clause}
            )
            SELECT
              r.monitoring_resource_id, r.metric_definition_id,
              r.value, r.observed_at,
              s.mean, s.stddev,
              ABS(r.value - s.mean) / s.stddev AS z_score,
              res.display_name  AS resource_name,
              md.name           AS metric_name,
              md.unit
            FROM recent r
            JOIN stats s USING (monitoring_resource_id, metric_definition_id)
            JOIN monitoring.monitoring_resource res
              ON res.tenant_id = %s
             AND res.monitoring_resource_id = r.monitoring_resource_id
            JOIN monitoring.metric_definition md
              ON md.tenant_id = %s
             AND md.metric_definition_id = r.metric_definition_id
           WHERE ABS(r.value - s.mean) / s.stddev > %s
           ORDER BY z_score DESC
           LIMIT %s
            """,
            params_stats + params_recent + params_join,
        )
        rows = await cur.fetchall()

    anomalies = [
        {
            "resource_id":   r[0],
            "metric_id":     r[1],
            "value":         float(r[2]),
            "observed_at":   r[3].isoformat(),
            "mean":          float(r[4]),
            "stddev":        float(r[5]),
            "z_score":       float(r[6]),
            "resource_name": r[7],
            "metric_name":   r[8],
            "unit":          r[9] or "",
        }
        for r in rows
    ]
    return {
        "window_hours": window_hours,
        "threshold":    threshold,
        "count":        len(anomalies),
        "anomalies":    anomalies,
    }


# ---------------------------------------------------------------------------
# Predictive Failure — linear regression (PostgreSQL regr_* aggregates)
# ---------------------------------------------------------------------------

_CRITICAL_THRESHOLD = 90.0  # % — warn when value projected to cross this

@router.get("/predictions")
async def list_predictions(
    request: Request,
    horizon_hours: int = Query(default=72, ge=1, le=720),
    source_id: str | None = None,
) -> dict:
    """Predict metric exhaustion using PostgreSQL linear regression.

    Only metrics with R² > 0.5 and positive slope over the last 7 days are
    included. Predicts when the value will cross 90 % (configurable threshold).
    """
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]

    source_clause = "AND mo.monitoring_source_id = %s" if source_id else ""
    base_params: list = [tenant_id]
    if source_id:
        base_params.append(source_id)
    base_params += [tenant_id, tenant_id]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            f"""
            SELECT
              mo.monitoring_resource_id,
              mo.metric_definition_id,
              regr_slope(
                (mo.canonical_value #>> '{{}}')::numeric,
                EXTRACT(EPOCH FROM mo.observed_at)
              )                                                       AS slope,
              regr_intercept(
                (mo.canonical_value #>> '{{}}')::numeric,
                EXTRACT(EPOCH FROM mo.observed_at)
              )                                                       AS intercept,
              regr_r2(
                (mo.canonical_value #>> '{{}}')::numeric,
                EXTRACT(EPOCH FROM mo.observed_at)
              )                                                       AS r_squared,
              MAX((mo.canonical_value #>> '{{}}')::numeric)           AS current_value,
              MAX(mo.observed_at)                                     AS last_seen,
              res.display_name                                        AS resource_name,
              md.name                                                 AS metric_name,
              md.unit
            FROM monitoring.metric_observation mo
            JOIN monitoring.monitoring_resource res
              ON res.tenant_id = %s
             AND res.monitoring_resource_id = mo.monitoring_resource_id
            JOIN monitoring.metric_definition md
              ON md.tenant_id = %s
             AND md.metric_definition_id = mo.metric_definition_id
            WHERE mo.tenant_id = %s
              AND mo.value_kind IN ('number','integer')
              AND mo.observed_at > now() - INTERVAL '7 days'
              {source_clause}
            GROUP BY mo.monitoring_resource_id, mo.metric_definition_id,
                     res.display_name, md.name, md.unit
           HAVING regr_r2(
                    (mo.canonical_value #>> '{{}}')::numeric,
                    EXTRACT(EPOCH FROM mo.observed_at)
                  ) > 0.5
              AND regr_slope(
                    (mo.canonical_value #>> '{{}}')::numeric,
                    EXTRACT(EPOCH FROM mo.observed_at)
                  ) > 0
           ORDER BY regr_slope(
                      (mo.canonical_value #>> '{{}}')::numeric,
                      EXTRACT(EPOCH FROM mo.observed_at)
                    ) / NULLIF(
                      (100.0 - MAX((mo.canonical_value #>> '{{}}')::numeric)), 0
                    ) DESC NULLS LAST
           LIMIT 50
            """,
            [tenant_id, tenant_id, tenant_id] + ([source_id] if source_id else []),
        )
        rows = await cur.fetchall()

    now_epoch = datetime.now(timezone.utc).timestamp()
    predictions = []
    for r in rows:
        slope = float(r[2])         # units per second (regression x = epoch)
        intercept = float(r[3])     # y-intercept: value = slope * epoch + intercept
        r2 = float(r[4])
        current = float(r[5])
        last_seen = r[6]
        resource_name = r[7]
        metric_name = r[8]
        unit = r[9] or ""

        slope_per_hour = slope * 3600
        predicted_critical_at = None
        hours_to_critical = None
        if slope > 0:
            # Use regression line to find when value reaches threshold:
            # threshold = slope * t_epoch + intercept  →  t = (threshold - intercept) / slope
            t_critical_epoch = (_CRITICAL_THRESHOLD - intercept) / slope
            hours_to_critical = (t_critical_epoch - now_epoch) / 3600
            if hours_to_critical < 0:
                # Trend line already crossed threshold — report as imminent
                hours_to_critical = 0.0
                predicted_critical_at = datetime.now(timezone.utc).isoformat()
            elif hours_to_critical <= horizon_hours:
                predicted_critical_at = (
                    datetime.now(timezone.utc)
                    + timedelta(hours=hours_to_critical)
                ).isoformat()

        predictions.append({
            "resource_id":          r[0],
            "metric_id":            r[1],
            "resource_name":        resource_name,
            "metric_name":          metric_name,
            "unit":                 unit,
            "current_value":        current,
            "slope_per_hour":       slope_per_hour,
            "confidence":           r2,
            "predicted_critical_at": predicted_critical_at,
            "hours_to_critical":    hours_to_critical,
            "last_seen":            last_seen.isoformat() if last_seen else None,
        })

    return {
        "horizon_hours": horizon_hours,
        "threshold_pct": _CRITICAL_THRESHOLD,
        "count":         len(predictions),
        "predictions":   predictions,
    }


# ---------------------------------------------------------------------------
# Capacity Planning — daily averages + 30/60/90-day forecast
# ---------------------------------------------------------------------------

@router.get("/capacity")
async def capacity_overview(
    request: Request,
    source_id: str | None = None,
    metric_key: str | None = None,
) -> dict:
    """30-day daily average history + linear trend forecast at 30/60/90 days.

    Identifies resources projected to exceed 80 % within 30 days.
    """
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]

    source_clause = "AND mo.monitoring_source_id = %s" if source_id else ""
    params: list = [tenant_id, tenant_id, tenant_id]
    if source_id:
        params.insert(1, source_id)
    if metric_key:
        params.insert(2, f"%{metric_key}%")

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            f"""
            WITH daily AS (
              SELECT
                mo.monitoring_resource_id,
                mo.metric_definition_id,
                DATE_TRUNC('day', mo.observed_at) AS day,
                AVG((mo.canonical_value #>> '{{}}')::numeric) AS avg_value
              FROM monitoring.metric_observation mo
             WHERE mo.tenant_id = %s
               AND mo.value_kind IN ('number','integer')
               AND mo.observed_at > now() - INTERVAL '30 days'
               {source_clause}
             GROUP BY mo.monitoring_resource_id, mo.metric_definition_id,
                      DATE_TRUNC('day', mo.observed_at)
            ),
            regression AS (
              SELECT
                d.monitoring_resource_id,
                d.metric_definition_id,
                regr_slope(d.avg_value, EXTRACT(EPOCH FROM d.day))     AS slope,
                regr_intercept(d.avg_value, EXTRACT(EPOCH FROM d.day)) AS intercept,
                regr_r2(d.avg_value, EXTRACT(EPOCH FROM d.day))        AS r2,
                MAX(d.avg_value)                                        AS current_avg,
                COUNT(*)                                                AS day_count
              FROM daily d
             GROUP BY d.monitoring_resource_id, d.metric_definition_id
            )
            SELECT
              rg.monitoring_resource_id,
              rg.metric_definition_id,
              rg.slope, rg.intercept, rg.r2,
              rg.current_avg, rg.day_count,
              res.display_name AS resource_name,
              md.name          AS metric_name,
              md.unit,
              (SELECT json_agg(
                json_build_object('day', sub.day, 'avg', sub.avg_value)
                ORDER BY sub.day
              )
               FROM daily sub
              WHERE sub.monitoring_resource_id = rg.monitoring_resource_id
                AND sub.metric_definition_id   = rg.metric_definition_id
              ) AS history
            FROM regression rg
            JOIN monitoring.monitoring_resource res
              ON res.tenant_id = %s
             AND res.monitoring_resource_id = rg.monitoring_resource_id
            JOIN monitoring.metric_definition md
              ON md.tenant_id = %s
             AND md.metric_definition_id = rg.metric_definition_id
            {("WHERE md.name ILIKE %s" if metric_key else "")}
           ORDER BY rg.current_avg DESC
           LIMIT 50
            """,
            params,
        )
        rows = await cur.fetchall()

    now_epoch = datetime.now(timezone.utc).timestamp()
    secs_30d = 30 * 86400
    secs_60d = 60 * 86400
    secs_90d = 90 * 86400

    items = []
    at_risk = 0
    for r in rows:
        slope = float(r[2]) if r[2] is not None else 0.0
        intercept = float(r[3]) if r[3] is not None else 0.0
        r2 = float(r[4]) if r[4] is not None else 0.0
        current_avg = float(r[5])

        def forecast(delta_s: float) -> float | None:
            if r2 < 0.3:
                return None
            return slope * (now_epoch + delta_s) + intercept

        f30 = forecast(secs_30d)
        f60 = forecast(secs_60d)
        f90 = forecast(secs_90d)

        risk = f30 is not None and f30 > 80.0
        if risk:
            at_risk += 1

        history_raw = r[10] or []
        history = [
            {"day": h["day"], "avg": float(h["avg"])}
            for h in history_raw
        ]

        items.append({
            "resource_id":    r[0],
            "metric_id":      r[1],
            "resource_name":  r[7],
            "metric_name":    r[8],
            "unit":           r[9] or "",
            "current_avg":    current_avg,
            "slope_per_day":  slope * 86400,
            "r_squared":      r2,
            "forecast_30d":   round(f30, 2) if f30 is not None else None,
            "forecast_60d":   round(f60, 2) if f60 is not None else None,
            "forecast_90d":   round(f90, 2) if f90 is not None else None,
            "at_risk":        risk,
            "day_count":      int(r[6]),
            "history":        history,
        })

    return {
        "total":   len(items),
        "at_risk": at_risk,
        "items":   items,
    }


# ---------------------------------------------------------------------------
# Prediction Lifecycle — mitigated / occurred / false_positive
# ---------------------------------------------------------------------------

_OUTCOMES = {"mitigated", "occurred", "false_positive"}


class RecordOutcome(BaseModel):
    resource_id: str
    metric_id: str
    outcome: str
    note: Optional[str] = ""


@router.post("/predictions/outcomes", status_code=status.HTTP_201_CREATED)
async def record_prediction_outcome(
    request: Request, body: RecordOutcome
) -> dict:
    """Record or update the lifecycle outcome for a predicted resource/metric pair.

    Uses INSERT … ON CONFLICT DO UPDATE so calling again updates in place.
    Only principals with monitoring:operate or tenant:admin may record outcomes.
    """
    from shared import access
    from shared.db import db_connection

    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]
    principal_id = ctx.get("principal_id", "unknown")

    if body.outcome not in _OUTCOMES:
        raise HTTPException(
            status_code=422,
            detail=f"outcome must be one of {sorted(_OUTCOMES)}",
        )
    if not body.resource_id or not body.metric_id:
        raise HTTPException(status_code=422, detail="resource_id and metric_id are required")

    async with db_connection() as pconn:
        perms = await access.effective_permissions(pconn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            INSERT INTO aiops.prediction_outcome
                (tenant_id, resource_id, metric_id, outcome, note, recorded_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, resource_id, metric_id) DO UPDATE
               SET outcome = EXCLUDED.outcome,
                   note = EXCLUDED.note,
                   recorded_at = now(),
                   recorded_by = EXCLUDED.recorded_by
            RETURNING outcome_id
            """,
            (tenant_id, body.resource_id, body.metric_id,
             body.outcome, body.note or "", principal_id),
        )
        row = await cur.fetchone()
        await record_audit_event(
            conn, tenant_id,
            action="aiops.prediction.outcome_recorded",
            actor_kind="principal", actor_id=principal_id,
            subject_type="prediction_outcome", subject_id=str(row[0]),
            detail={"outcome": body.outcome, "resource_id": body.resource_id},
        )
        await conn.commit()

    return {
        "outcome_id": str(row[0]),
        "resource_id": body.resource_id,
        "metric_id": body.metric_id,
        "outcome": body.outcome,
    }


@router.delete("/predictions/outcomes/{resource_id}/{metric_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def clear_prediction_outcome(
    request: Request, resource_id: str, metric_id: str
) -> None:
    """Remove a recorded outcome, returning the prediction to 'active' state."""
    from shared import access
    from shared.db import db_connection

    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]
    principal_id = ctx.get("principal_id", "unknown")

    async with db_connection() as pconn:
        perms = await access.effective_permissions(pconn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "DELETE FROM aiops.prediction_outcome "
            "WHERE tenant_id=%s AND resource_id=%s AND metric_id=%s",
            (tenant_id, resource_id, metric_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="outcome not found")
        await conn.commit()


@router.get("/predictions/outcomes")
async def list_prediction_outcomes(request: Request) -> list[dict]:
    """List all recorded prediction outcomes for the current tenant."""
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT outcome_id, resource_id, metric_id, outcome,
                   note, recorded_at, recorded_by
              FROM aiops.prediction_outcome
             WHERE tenant_id = %s
             ORDER BY recorded_at DESC
            """,
            (tenant_id,),
        )
        rows = await cur.fetchall()

    return [
        {
            "outcome_id":  str(r[0]),
            "resource_id": r[1],
            "metric_id":   r[2],
            "outcome":     r[3],
            "note":        r[4],
            "recorded_at": r[5].isoformat(),
            "recorded_by": r[6],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Anomaly False-Positive marking
# ---------------------------------------------------------------------------

class MarkFalsePositive(BaseModel):
    resource_id: str
    metric_id: str
    note: Optional[str] = ""


def _require_operate(ctx: dict):
    return ctx["tenant_id"], ctx.get("principal_id", "unknown")


@router.post("/anomalies/false-positives", status_code=status.HTTP_201_CREATED)
async def mark_anomaly_false_positive(
    request: Request, body: MarkFalsePositive
) -> dict:
    from shared import access
    from shared.db import db_connection

    ctx = _get_context(request)
    tenant_id, principal_id = _require_operate(ctx)

    async with db_connection() as pconn:
        perms = await access.effective_permissions(pconn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            INSERT INTO aiops.anomaly_false_positive
                (tenant_id, resource_id, metric_id, note, marked_by)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, resource_id, metric_id) DO UPDATE
               SET note      = EXCLUDED.note,
                   marked_at = now(),
                   marked_by = EXCLUDED.marked_by
            RETURNING fp_id
            """,
            (tenant_id, body.resource_id, body.metric_id, body.note or "", principal_id),
        )
        row = await cur.fetchone()
        await record_audit_event(
            conn, tenant_id,
            action="aiops.anomaly.false_positive_marked",
            actor_kind="principal", actor_id=principal_id,
            subject_type="anomaly_fp", subject_id=str(row[0]),
            detail={"resource_id": body.resource_id, "metric_id": body.metric_id},
        )
        await conn.commit()

    return {"fp_id": str(row[0]), "resource_id": body.resource_id, "metric_id": body.metric_id}


@router.delete("/anomalies/false-positives/{resource_id}/{metric_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def clear_anomaly_false_positive(
    request: Request, resource_id: str, metric_id: str
) -> None:
    from shared import access
    from shared.db import db_connection

    ctx = _get_context(request)
    tenant_id, principal_id = _require_operate(ctx)

    async with db_connection() as pconn:
        perms = await access.effective_permissions(pconn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "DELETE FROM aiops.anomaly_false_positive "
            "WHERE tenant_id=%s AND resource_id=%s AND metric_id=%s",
            (tenant_id, resource_id, metric_id),
        )
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="false positive not found")
        await conn.commit()


@router.get("/anomalies/false-positives")
async def list_anomaly_false_positives(request: Request) -> list[dict]:
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT fp_id, resource_id, metric_id, note, marked_at, marked_by
              FROM aiops.anomaly_false_positive
             WHERE tenant_id = %s
             ORDER BY marked_at DESC
            """,
            (tenant_id,),
        )
        rows = await cur.fetchall()

    return [
        {
            "fp_id":       str(r[0]),
            "resource_id": r[1],
            "metric_id":   r[2],
            "note":        r[3],
            "marked_at":   r[4].isoformat(),
            "marked_by":   r[5],
        }
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Anomaly Config — per-resource/metric threshold + enable/disable
# ---------------------------------------------------------------------------

class AnomalyConfigUpdate(BaseModel):
    enabled: bool = True
    threshold: Optional[float] = None


@router.put("/anomalies/config/{resource_id}/{metric_id}")
async def upsert_anomaly_config(
    request: Request,
    resource_id: str,
    metric_id: str,
    body: AnomalyConfigUpdate,
) -> dict:
    from shared import access
    from shared.db import db_connection

    ctx = _get_context(request)
    tenant_id, principal_id = _require_operate(ctx)

    async with db_connection() as pconn:
        perms = await access.effective_permissions(pconn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")

    if body.threshold is not None and not (1.0 <= body.threshold <= 10.0):
        raise HTTPException(status_code=422, detail="threshold must be between 1.0 and 10.0")

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            INSERT INTO aiops.anomaly_config
                (tenant_id, resource_id, metric_id, enabled, threshold, updated_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, resource_id, metric_id) DO UPDATE
               SET enabled    = EXCLUDED.enabled,
                   threshold  = EXCLUDED.threshold,
                   updated_at = now(),
                   updated_by = EXCLUDED.updated_by
            RETURNING config_id, enabled, threshold, updated_at
            """,
            (tenant_id, resource_id, metric_id, body.enabled, body.threshold, principal_id),
        )
        row = await cur.fetchone()
        await conn.commit()

    return {
        "config_id":   str(row[0]),
        "resource_id": resource_id,
        "metric_id":   metric_id,
        "enabled":     row[1],
        "threshold":   float(row[2]) if row[2] is not None else None,
        "updated_at":  row[3].isoformat(),
    }


@router.delete("/anomalies/config/{resource_id}/{metric_id}",
               status_code=status.HTTP_204_NO_CONTENT)
async def reset_anomaly_config(
    request: Request, resource_id: str, metric_id: str
) -> None:
    from shared import access
    from shared.db import db_connection

    ctx = _get_context(request)
    tenant_id, principal_id = _require_operate(ctx)

    async with db_connection() as pconn:
        perms = await access.effective_permissions(pconn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")

    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            "DELETE FROM aiops.anomaly_config "
            "WHERE tenant_id=%s AND resource_id=%s AND metric_id=%s",
            (tenant_id, resource_id, metric_id),
        )
        await conn.commit()


@router.get("/anomalies/configs")
async def list_anomaly_configs(request: Request) -> list[dict]:
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT config_id, resource_id, metric_id, enabled, threshold, updated_at, updated_by
              FROM aiops.anomaly_config
             WHERE tenant_id = %s
             ORDER BY updated_at DESC
            """,
            (tenant_id,),
        )
        rows = await cur.fetchall()

    return [
        {
            "config_id":   str(r[0]),
            "resource_id": r[1],
            "metric_id":   r[2],
            "enabled":     r[3],
            "threshold":   float(r[4]) if r[4] is not None else None,
            "updated_at":  r[5].isoformat(),
            "updated_by":  r[6],
        }
        for r in rows
    ]
