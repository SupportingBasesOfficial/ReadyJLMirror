"""MSP (Managed Service Provider) API.

Allows a principal with delegated_grants on client tenants to see an
aggregated health view of all managed clients without switching context.

A 'client' is any tenant the principal can access via delegated_grant
(via='delegation') that is not their own bound tenant.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import JSONResponse

from shared import access
from shared.db import db_connection, db_tenant_connection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/msp", tags=["msp"])


async def _client_health(tenant_id: str, display_name: str | None) -> dict:
    """Query one client tenant's health summary — runs as a parallel task."""
    try:
        async with db_tenant_connection(tenant_id) as conn:
            cur = await conn.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE lifecycle_state = 'active')            AS active_alerts,
                    COUNT(*) FILTER (
                        WHERE lifecycle_state = 'active'
                          AND (source_evidence_summary->>'severity_class') = 'critical'
                    )                                                              AS critical_alerts,
                    COUNT(*) FILTER (
                        WHERE lifecycle_state = 'active'
                          AND (source_evidence_summary->>'severity_class') IN ('warning','degraded')
                    )                                                              AS warning_alerts
                  FROM alerting.alert
                 WHERE tenant_id = %s
                """,
                (tenant_id,),
            )
            row = await cur.fetchone()
            active   = int(row[0] or 0)
            critical = int(row[1] or 0)
            warning  = int(row[2] or 0)

            src_cur = await conn.execute(
                """
                SELECT COUNT(*) FROM monitoring.monitoring_source
                 WHERE tenant_id = %s AND enabled = true
                """,
                (tenant_id,),
            )
            src_row = await src_cur.fetchone()
            sources = int(src_row[0] or 0)

        if critical > 0:
            health = "critical"
        elif warning > 0 or active > 0:
            health = "warning"
        else:
            health = "ok"

        return {
            "tenant_id": tenant_id,
            "display_name": display_name or tenant_id,
            "health": health,
            "active_alerts": active,
            "critical_alerts": critical,
            "warning_alerts": warning,
            "source_count": sources,
        }
    except Exception:
        logger.exception("msp health query failed for %s", tenant_id)
        return {
            "tenant_id": tenant_id,
            "display_name": display_name or tenant_id,
            "health": "unknown",
            "active_alerts": 0,
            "critical_alerts": 0,
            "warning_alerts": 0,
            "source_count": 0,
        }


@router.get("/clients")
async def list_msp_clients(request: Request) -> JSONResponse:
    """Return health summary for all tenants the principal manages via delegation.

    Excludes the principal's own bound tenant (own infra is shown in NOC).
    Results are fetched in parallel — one DB round-trip per client.
    """
    ctx = request.state.jlmirror_context
    principal_id = ctx.get("principal_id")
    own_tenant   = ctx.get("tenant_id")

    async with db_connection() as conn:
        all_tenants = await access.accessible_tenants(conn, principal_id)

    delegated = [
        t for t in all_tenants
        if t.get("via") == "delegation" and t["tenant_id"] != own_tenant
    ]

    if not delegated:
        return JSONResponse({"clients": [], "own_tenant_id": own_tenant})

    results = await asyncio.gather(*[
        _client_health(t["tenant_id"], t.get("display_name"))
        for t in delegated
    ])

    # Sort: critical first, then warning, then ok, then unknown
    _order = {"critical": 0, "warning": 1, "ok": 2, "unknown": 3}
    sorted_results = sorted(results, key=lambda r: _order.get(r["health"], 3))

    return JSONResponse({"clients": sorted_results, "own_tenant_id": own_tenant})


@router.get("/clients/{client_tenant_id}/detail")
async def get_client_detail(client_tenant_id: str, request: Request) -> JSONResponse:
    """Return recent active alerts for a specific managed client tenant."""
    ctx = request.state.jlmirror_context
    principal_id = ctx.get("principal_id")
    own_tenant = ctx.get("tenant_id")

    async with db_connection() as conn:
        all_tenants = await access.accessible_tenants(conn, principal_id)

    accessible = {
        t["tenant_id"] for t in all_tenants
        if t.get("via") == "delegation" and t["tenant_id"] != own_tenant
    }
    if client_tenant_id not in accessible:
        raise HTTPException(status_code=403, detail="not_authorized_for_client")

    async with db_tenant_connection(client_tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT alert_id,
                   source_kind,
                   lifecycle_state,
                   source_evidence_summary->>'severity_class' AS severity,
                   monitoring_resource_id,
                   opened_at,
                   last_state_change_at
              FROM alerting.alert
             WHERE tenant_id = %s
               AND lifecycle_state = 'active'
             ORDER BY opened_at DESC
             LIMIT 25
            """,
            (client_tenant_id,),
        )
        cols = [d.name for d in cur.description]
        alerts = []
        for r in await cur.fetchall():
            row = dict(zip(cols, r))
            row["opened_at"] = row["opened_at"].isoformat() if row["opened_at"] else None
            row["last_state_change_at"] = (
                row["last_state_change_at"].isoformat()
                if row.get("last_state_change_at") else None
            )
            alerts.append(row)

    return JSONResponse({
        "tenant_id": client_tenant_id,
        "alerts": alerts,
    })
