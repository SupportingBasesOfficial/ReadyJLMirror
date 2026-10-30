"""Client Portal — read-only simplified view for MSP end-clients.

Exposes only tenant-scoped data (alerts, incidents, SLA) with no
operational configuration. Clients see exactly their own tenant data.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from api.routers.itsm import _INVOKER_ROLE
from shared.db import db_connection

router = APIRouter(prefix="/api/v1/portal", tags=["client-portal"])


def _require_tenant(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


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
async def get_overview(request: Request) -> dict:
    tenant_id = _require_tenant(request)
    async with db_connection() as conn:
        tenant_row = await _fetchrow(
            conn,
            "SELECT display_name FROM g1.tenants WHERE tenant_id = %s",
            (tenant_id,),
        )
        tenant_name = tenant_row.get("display_name") or tenant_id

        alerts_row = await _fetchrow(
            conn,
            """
            SELECT
                COUNT(*) FILTER (WHERE lifecycle_state = 'active')   AS active,
                COUNT(*) FILTER (WHERE lifecycle_state = 'active'
                    AND severity = 'critical')                        AS critical,
                COUNT(*) FILTER (WHERE lifecycle_state = 'resolved'
                    AND resolved_at >= now() - interval '24 hours')  AS resolved_24h
            FROM alerting.alert
            WHERE tenant_id = %s
            """,
            (tenant_id,),
        )

        open_incidents = 0
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_INVOKER_ROLE}")
                row = await _fetchrow(
                    conn,
                    """
                    SELECT COUNT(*) AS cnt FROM itsm.incident
                    WHERE tenant_id = %s
                      AND lifecycle_state NOT IN ('resolved', 'closed')
                    """,
                    (tenant_id,),
                )
                open_incidents = int(row.get("cnt") or 0)
        except Exception:
            pass

        sla_row: dict = {}
        try:
            sla_row = await _fetchrow(
                conn,
                """
                SELECT
                    COUNT(*)                                  AS total,
                    COUNT(*) FILTER (WHERE met = true)        AS met
                FROM g1.sla_breach
                WHERE tenant_id = %s
                  AND checked_at >= now() - interval '30 days'
                """,
                (tenant_id,),
            )
        except Exception:
            pass

        total_sla = int(sla_row.get("total") or 0)
        met_sla = int(sla_row.get("met") or 0)
        sla_pct = round(met_sla / total_sla * 100, 1) if total_sla > 0 else None

    return {
        "tenant_name": tenant_name,
        "alerts": {
            "active": int(alerts_row.get("active") or 0),
            "critical": int(alerts_row.get("critical") or 0),
            "resolved_24h": int(alerts_row.get("resolved_24h") or 0),
        },
        "open_incidents": open_incidents,
        "sla_compliance_pct": sla_pct,
    }


@router.get("/alerts")
async def list_alerts(request: Request, state: str = "active") -> list:
    tenant_id = _require_tenant(request)
    async with db_connection() as conn:
        rows = await _fetchall(
            conn,
            """
            SELECT
                alert_id,
                title,
                severity,
                lifecycle_state,
                fired_at,
                resolved_at
            FROM alerting.alert
            WHERE tenant_id = %s
              AND lifecycle_state = %s
            ORDER BY fired_at DESC
            LIMIT 100
            """,
            (tenant_id, state),
        )
    return [
        {
            "alert_id": str(r["alert_id"]),
            "title": r["title"],
            "severity": r["severity"],
            "state": r["lifecycle_state"],
            "fired_at": r["fired_at"].isoformat() if r["fired_at"] else None,
            "resolved_at": r["resolved_at"].isoformat() if r["resolved_at"] else None,
        }
        for r in rows
    ]


@router.get("/incidents")
async def list_incidents(request: Request, state: str = "open") -> list:
    tenant_id = _require_tenant(request)
    rows: list[dict] = []
    async with db_connection() as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_INVOKER_ROLE}")
                filter_clause = (
                    "AND lifecycle_state NOT IN ('resolved', 'closed')"
                    if state == "open"
                    else "AND lifecycle_state = %s"
                )
                params = (tenant_id, state) if state != "open" else (tenant_id,)
                rows = await _fetchall(
                    conn,
                    f"""
                    SELECT incident_id, title, severity, lifecycle_state,
                           detected_at, resolved_at
                    FROM itsm.incident
                    WHERE tenant_id = %s
                      {filter_clause}
                    ORDER BY detected_at DESC
                    LIMIT 50
                    """,
                    params,
                )
        except Exception:
            pass
    return [
        {
            "incident_id": str(r["incident_id"]),
            "title": r["title"],
            "severity": r["severity"],
            "state": r["lifecycle_state"],
            "detected_at": r["detected_at"].isoformat() if r["detected_at"] else None,
            "resolved_at": r["resolved_at"].isoformat() if r["resolved_at"] else None,
        }
        for r in rows
    ]


@router.get("/sla")
async def list_sla(request: Request) -> list:
    tenant_id = _require_tenant(request)
    rows: list[dict] = []
    async with db_connection() as conn:
        try:
            rows = await _fetchall(
                conn,
                """
                SELECT
                    p.sla_id,
                    p.name,
                    p.severity_match,
                    p.response_secs,
                    p.resolve_secs,
                    COUNT(b.breach_id)                                   AS total_checks,
                    COUNT(b.breach_id) FILTER (WHERE b.met = true)       AS met_count
                FROM g1.sla_policy p
                LEFT JOIN g1.sla_breach b
                    ON b.sla_id = p.sla_id
                   AND b.tenant_id = %s
                   AND b.checked_at >= now() - interval '30 days'
                WHERE p.tenant_id = %s
                  AND p.enabled = true
                GROUP BY p.sla_id, p.name, p.severity_match, p.response_secs, p.resolve_secs
                ORDER BY p.name
                """,
                (tenant_id, tenant_id),
            )
        except Exception:
            pass
    return [
        {
            "sla_id": str(r["sla_id"]),
            "name": r["name"],
            "severity_match": r["severity_match"],
            "response_secs": r["response_secs"],
            "resolve_secs": r["resolve_secs"],
            "total_checks": int(r.get("total_checks") or 0),
            "met_count": int(r.get("met_count") or 0),
            "compliance_pct": (
                round(int(r.get("met_count") or 0) / int(r["total_checks"]) * 100, 1)
                if int(r.get("total_checks") or 0) > 0 else None
            ),
        }
        for r in rows
    ]


@router.get("/status")
async def get_status(request: Request) -> dict:
    tenant_id = _require_tenant(request)
    async with db_connection() as conn:
        critical_row = await _fetchrow(
            conn,
            """
            SELECT COUNT(*) AS cnt FROM alerting.alert
            WHERE tenant_id = %s AND lifecycle_state = 'active' AND severity = 'critical'
            """,
            (tenant_id,),
        )
        high_row = await _fetchrow(
            conn,
            """
            SELECT COUNT(*) AS cnt FROM alerting.alert
            WHERE tenant_id = %s AND lifecycle_state = 'active' AND severity = 'high'
            """,
            (tenant_id,),
        )

    critical = int(critical_row.get("cnt") or 0)
    high = int(high_row.get("cnt") or 0)

    if critical > 0:
        overall = "outage"
        label = "Interrupção"
    elif high > 0:
        overall = "degraded"
        label = "Degradado"
    else:
        overall = "operational"
        label = "Operacional"

    return {"status": overall, "label": label, "critical_alerts": critical, "high_alerts": high}
