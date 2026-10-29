"""Executive Dashboard — global KPI overview for management.

Accessible to tenant admins (scoped to their tenant) and platform
admins (cross-tenant aggregation). Incidents are fetched through the
g10 SECURITY DEFINER boundary.
"""

from __future__ import annotations

from fastapi import APIRouter, Request

from api.routers.itsm import _INVOKER_ROLE
from shared.db import db_connection

router = APIRouter(prefix="/api/v1/executive", tags=["executive"])


def _get_context(request: Request) -> dict:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None:
        return {"tenant_id": "dev-tenant", "is_platform_admin": False,
                "principal_id": "dev-operator"}
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
async def get_overview(request: Request) -> dict:
    ctx = _get_context(request)
    tenant_id: str | None = ctx.get("tenant_id")
    is_platform_admin: bool = bool(ctx.get("is_platform_admin", False))

    async with db_connection() as conn:
        # ── Alerts ──────────────────────────────────────────────────────────
        if is_platform_admin:
            alerts_row = await _fetchrow(conn, """
                SELECT
                    COUNT(*) FILTER (WHERE lifecycle_state = 'active')       AS active,
                    COUNT(*) FILTER (WHERE lifecycle_state = 'resolved'
                        AND resolved_at >= now() - interval '24 hours')       AS resolved_24h,
                    COUNT(*)                                                   AS total
                FROM alerting.alert
            """)
        else:
            alerts_row = await _fetchrow(conn, """
                SELECT
                    COUNT(*) FILTER (WHERE lifecycle_state = 'active')       AS active,
                    COUNT(*) FILTER (WHERE lifecycle_state = 'resolved'
                        AND resolved_at >= now() - interval '24 hours')       AS resolved_24h,
                    COUNT(*)                                                   AS total
                FROM alerting.alert
                WHERE tenant_id = %s
            """, (tenant_id,))

        alerts = {
            "active": int(alerts_row.get("active") or 0),
            "resolved_24h": int(alerts_row.get("resolved_24h") or 0),
            "total": int(alerts_row.get("total") or 0),
        }

        # ── Incidents (via invoker boundary) ─────────────────────────────────
        incident_counts = {"open": 0, "in_progress": 0, "resolved": 0, "closed": 0}
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_INVOKER_ROLE}")
                if is_platform_admin:
                    rows = await _fetchall(conn, """
                        SELECT lifecycle_state, COUNT(*) AS cnt
                        FROM itsm.incident
                        GROUP BY lifecycle_state
                    """)
                else:
                    rows = await _fetchall(conn, """
                        SELECT lifecycle_state, COUNT(*) AS cnt
                        FROM itsm.incident
                        WHERE tenant_id = %s
                        GROUP BY lifecycle_state
                    """, (tenant_id,))
                for r in rows:
                    state = r["lifecycle_state"]
                    if state in incident_counts:
                        incident_counts[state] = int(r["cnt"])
        except Exception:
            pass

        incidents = incident_counts

        # ── Changes ─────────────────────────────────────────────────────────
        if is_platform_admin:
            changes_row = await _fetchrow(conn, """
                SELECT
                    COUNT(*) FILTER (WHERE state = 'draft')           AS draft,
                    COUNT(*) FILTER (WHERE state = 'review')          AS review,
                    COUNT(*) FILTER (WHERE state = 'approved')        AS approved,
                    COUNT(*) FILTER (WHERE state = 'scheduled')       AS scheduled,
                    COUNT(*) FILTER (WHERE state = 'implementing')    AS implementing,
                    COUNT(*) FILTER (WHERE state = 'complete')        AS complete,
                    COUNT(*) FILTER (WHERE state = 'cancelled')       AS cancelled
                FROM g1.change_request
            """)
        else:
            changes_row = await _fetchrow(conn, """
                SELECT
                    COUNT(*) FILTER (WHERE state = 'draft')           AS draft,
                    COUNT(*) FILTER (WHERE state = 'review')          AS review,
                    COUNT(*) FILTER (WHERE state = 'approved')        AS approved,
                    COUNT(*) FILTER (WHERE state = 'scheduled')       AS scheduled,
                    COUNT(*) FILTER (WHERE state = 'implementing')    AS implementing,
                    COUNT(*) FILTER (WHERE state = 'complete')        AS complete,
                    COUNT(*) FILTER (WHERE state = 'cancelled')       AS cancelled
                FROM g1.change_request
                WHERE tenant_id = %s
            """, (tenant_id,))

        changes = {k: int(changes_row.get(k) or 0) for k in (
            "draft", "review", "approved", "scheduled",
            "implementing", "complete", "cancelled"
        )}

        # ── Monitoring Sources ───────────────────────────────────────────────
        if is_platform_admin:
            sources_row = await _fetchrow(conn, """
                SELECT
                    COUNT(*)                                                                AS total,
                    COUNT(*) FILTER (WHERE operational_evidence_state = 'current')         AS enabled,
                    COUNT(*) FILTER (WHERE operational_evidence_state <> 'current')        AS disabled
                FROM monitoring.monitoring_source
            """)
        else:
            sources_row = await _fetchrow(conn, """
                SELECT
                    COUNT(*)                                                                AS total,
                    COUNT(*) FILTER (WHERE operational_evidence_state = 'current')         AS enabled,
                    COUNT(*) FILTER (WHERE operational_evidence_state <> 'current')        AS disabled
                FROM monitoring.monitoring_source
                WHERE tenant_id = %s
            """, (tenant_id,))

        sources = {
            "total": int(sources_row.get("total") or 0),
            "enabled": int(sources_row.get("enabled") or 0),
            "disabled": int(sources_row.get("disabled") or 0),
        }

        # ── SLA Breaches (last 30 days) ──────────────────────────────────────
        if is_platform_admin:
            sla_row = await _fetchrow(conn, """
                SELECT COUNT(*) AS breaches
                FROM g1.sla_breach
                WHERE breached_at >= now() - interval '30 days'
            """)
        else:
            sla_row = await _fetchrow(conn, """
                SELECT COUNT(*) AS breaches
                FROM g1.sla_breach
                WHERE tenant_id = %s
                  AND breached_at >= now() - interval '30 days'
            """, (tenant_id,))

        sla_breaches_30d = int(sla_row.get("breaches") or 0)

        # ── Top Tenants by Alert Volume (platform_admin only) ────────────────
        top_tenants: list[dict] = []
        if is_platform_admin:
            rows = await _fetchall(conn, """
                SELECT t.tenant_id, t.display_name,
                       COUNT(*) FILTER (WHERE a.lifecycle_state = 'active') AS active_alerts,
                       COUNT(*)                                               AS total_alerts
                FROM g1.tenants t
                LEFT JOIN alerting.alert a USING (tenant_id)
                GROUP BY t.tenant_id, t.display_name
                ORDER BY active_alerts DESC, total_alerts DESC
                LIMIT 10
            """)
            top_tenants = [
                {
                    "tenant_id": r["tenant_id"],
                    "display_name": r["display_name"],
                    "active_alerts": int(r.get("active_alerts") or 0),
                    "total_alerts": int(r.get("total_alerts") or 0),
                }
                for r in rows
            ]

    return {
        "scope": "platform" if is_platform_admin else "tenant",
        "tenant_id": None if is_platform_admin else tenant_id,
        "alerts": alerts,
        "incidents": incidents,
        "changes": changes,
        "monitoring_sources": sources,
        "sla_breaches_30d": sla_breaches_30d,
        "top_tenants": top_tenants,
    }
