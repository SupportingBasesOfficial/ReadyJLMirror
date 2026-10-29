"""APM — API Performance Monitoring.

Aggregates latency percentiles (p50/p95/p99), error rate and request volume
per endpoint. Data is written by APMMiddleware in main.py; records are kept
7 days via the /purge endpoint (called by the scheduled worker).
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from shared.db import db_connection

router = APIRouter(prefix="/api/v1/apm", tags=["apm"])


def _get_context(request: Request) -> dict:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None:
        return {"tenant_id": "dev-tenant", "is_platform_admin": False, "principal_id": "dev-operator"}
    return ctx


async def _fetchrow(conn, query: str, params: tuple = ()) -> dict:
    cur = await conn.execute(query, params)
    cols = [d[0] for d in cur.description]
    row = await cur.fetchone()
    return dict(zip(cols, row)) if row else {}


async def _fetchall(conn, query: str, params: tuple = ()) -> list[dict]:
    cur = await conn.execute(query, params)
    cols = [d[0] for d in cur.description]
    rows = await cur.fetchall()
    return [dict(zip(cols, r)) for r in rows]


@router.get("/overview")
async def get_apm_overview(request: Request) -> dict:
    ctx = _get_context(request)
    tenant_id: str | None = ctx.get("tenant_id")
    is_pa: bool = bool(ctx.get("is_platform_admin", False))

    async with db_connection() as conn:
        if is_pa:
            summary = await _fetchrow(conn, """
                SELECT
                    COUNT(*)                                                          AS total_requests,
                    COUNT(*) FILTER (WHERE status_code >= 500)                       AS error_count,
                    COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS client_error_count,
                    ROUND(AVG(duration_ms)::numeric, 2)                              AS avg_ms,
                    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p50_ms,
                    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p95_ms,
                    ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p99_ms
                FROM g1.apm_request_log
                WHERE recorded_at >= now() - interval '24 hours'
            """)
            endpoint_rows = await _fetchall(conn, """
                SELECT
                    method, path,
                    COUNT(*)                                                          AS request_count,
                    COUNT(*) FILTER (WHERE status_code >= 500)                       AS error_count,
                    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p50_ms,
                    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p95_ms,
                    ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p99_ms
                FROM g1.apm_request_log
                WHERE recorded_at >= now() - interval '24 hours'
                GROUP BY method, path
                ORDER BY request_count DESC
                LIMIT 20
            """)
            hourly_rows = await _fetchall(conn, """
                SELECT
                    DATE_TRUNC('hour', recorded_at)             AS hour,
                    COUNT(*)                                    AS requests,
                    COUNT(*) FILTER (WHERE status_code >= 500) AS errors
                FROM g1.apm_request_log
                WHERE recorded_at >= now() - interval '24 hours'
                GROUP BY 1
                ORDER BY 1
            """)
        else:
            summary = await _fetchrow(conn, """
                SELECT
                    COUNT(*)                                                          AS total_requests,
                    COUNT(*) FILTER (WHERE status_code >= 500)                       AS error_count,
                    COUNT(*) FILTER (WHERE status_code >= 400 AND status_code < 500) AS client_error_count,
                    ROUND(AVG(duration_ms)::numeric, 2)                              AS avg_ms,
                    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p50_ms,
                    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p95_ms,
                    ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p99_ms
                FROM g1.apm_request_log
                WHERE tenant_id = %s
                  AND recorded_at >= now() - interval '24 hours'
            """, (tenant_id,))
            endpoint_rows = await _fetchall(conn, """
                SELECT
                    method, path,
                    COUNT(*)                                                          AS request_count,
                    COUNT(*) FILTER (WHERE status_code >= 500)                       AS error_count,
                    ROUND(PERCENTILE_CONT(0.50) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p50_ms,
                    ROUND(PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p95_ms,
                    ROUND(PERCENTILE_CONT(0.99) WITHIN GROUP (ORDER BY duration_ms)::numeric, 2) AS p99_ms
                FROM g1.apm_request_log
                WHERE tenant_id = %s
                  AND recorded_at >= now() - interval '24 hours'
                GROUP BY method, path
                ORDER BY request_count DESC
                LIMIT 20
            """, (tenant_id,))
            hourly_rows = await _fetchall(conn, """
                SELECT
                    DATE_TRUNC('hour', recorded_at)             AS hour,
                    COUNT(*)                                    AS requests,
                    COUNT(*) FILTER (WHERE status_code >= 500) AS errors
                FROM g1.apm_request_log
                WHERE tenant_id = %s
                  AND recorded_at >= now() - interval '24 hours'
                GROUP BY 1
                ORDER BY 1
            """, (tenant_id,))

    return {
        "scope": "platform" if is_pa else "tenant",
        "tenant_id": None if is_pa else tenant_id,
        "summary": {
            "total_requests": int(summary.get("total_requests") or 0),
            "error_count": int(summary.get("error_count") or 0),
            "client_error_count": int(summary.get("client_error_count") or 0),
            "avg_ms": float(summary.get("avg_ms") or 0),
            "p50_ms": float(summary.get("p50_ms") or 0),
            "p95_ms": float(summary.get("p95_ms") or 0),
            "p99_ms": float(summary.get("p99_ms") or 0),
        },
        "endpoints": [
            {
                "method": r["method"],
                "path": r["path"],
                "request_count": int(r["request_count"]),
                "error_count": int(r.get("error_count") or 0),
                "p50_ms": float(r.get("p50_ms") or 0),
                "p95_ms": float(r.get("p95_ms") or 0),
                "p99_ms": float(r.get("p99_ms") or 0),
            }
            for r in endpoint_rows
        ],
        "hourly": [
            {
                "hour": r["hour"].isoformat(),
                "requests": int(r["requests"]),
                "errors": int(r.get("errors") or 0),
            }
            for r in hourly_rows
        ],
    }


@router.delete("/purge")
async def purge_old_logs(request: Request) -> dict:
    """Remove records older than 7 days. Intended for the scheduled worker."""
    ctx = _get_context(request)
    if not ctx.get("is_platform_admin"):
        raise HTTPException(status_code=403, detail="platform_admin required")
    async with db_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM g1.apm_request_log WHERE recorded_at < now() - interval '7 days'"
        )
    return {"deleted": cur.rowcount}
