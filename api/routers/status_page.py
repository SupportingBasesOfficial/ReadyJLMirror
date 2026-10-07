"""G24 Public Status Page endpoints.

Operators configure the tenant's public status page (slug, name, on/off)
via /api/v1/platform/status-page (authenticated).

The page itself is served at /status/{slug} without authentication — any
visitor can check a tenant's operational status by their public slug.
"""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.db import db_connection, db_tenant_connection

logger = logging.getLogger(__name__)

_public_router = APIRouter(tags=["status-page-public"])


@_public_router.get("/status/{slug}")
async def public_status_page(slug: str) -> dict:
    """Return operational status for a tenant by their public slug.

    No authentication required — this is the public-facing endpoint.
    Returns 404 when the slug doesn't exist or the page is disabled.
    """
    slug = slug.strip().lower()
    if not slug or not slug.replace("-", "").isalnum():
        raise HTTPException(status_code=404, detail="not_found")

    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT tenant_id, public_name, enabled
              FROM g1.tenant_status_config
             WHERE status_slug = %s
            """,
            (slug,),
        )
        row = await cur.fetchone()

    if row is None or not row[2]:
        raise HTTPException(status_code=404, detail="not_found")

    tenant_id, public_name, _ = row

    try:
        async with db_tenant_connection(tenant_id) as conn:
            cur = await conn.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE lifecycle_state = 'active')           AS active_alerts,
                    COUNT(*) FILTER (
                        WHERE lifecycle_state = 'active'
                          AND (source_evidence_summary->>'severity_class') = 'critical'
                    )                                                             AS critical_alerts,
                    COUNT(*) FILTER (
                        WHERE lifecycle_state = 'active'
                          AND (source_evidence_summary->>'severity_class') IN ('warning','degraded')
                    )                                                             AS warning_alerts,
                    COUNT(*) FILTER (WHERE lifecycle_state = 'active'
                          AND (source_evidence_summary->>'severity_class') = 'info'
                    )                                                             AS info_alerts
                  FROM alerting.alert
                 WHERE tenant_id = %s
                """,
                (tenant_id,),
            )
            counts = await cur.fetchone()
            active, critical, warning, info = (int(c or 0) for c in counts)

            src_cur = await conn.execute(
                """
                SELECT COUNT(*) FROM monitoring.monitoring_source
                 WHERE tenant_id = %s AND enabled = true
                """,
                (tenant_id,),
            )
            src_row = await src_cur.fetchone()
            sources = int(src_row[0] or 0)
    except Exception:
        logger.exception("status_page: health query failed tenant=%s", tenant_id)
        return {
            "slug": slug,
            "public_name": public_name,
            "overall_status": "unknown",
            "active_alerts": 0,
            "critical_alerts": 0,
            "warning_alerts": 0,
            "info_alerts": 0,
            "source_count": 0,
        }

    if critical > 0:
        overall = "major_outage"
    elif warning > 0:
        overall = "partial_outage"
    elif active > 0:
        overall = "degraded"
    else:
        overall = "operational"

    return {
        "slug": slug,
        "public_name": public_name,
        "overall_status": overall,
        "active_alerts": active,
        "critical_alerts": critical,
        "warning_alerts": warning,
        "info_alerts": info,
        "source_count": sources,
    }


router = APIRouter(prefix="/api/v1/platform", tags=["status-page"])


class StatusPageConfig(BaseModel):
    status_slug: str
    public_name: str
    enabled: bool = True
    components: list[dict] = []


@router.get("/status-page")
async def get_status_page_config(request: Request,
                                 tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT status_slug, public_name, enabled, updated_at, components
              FROM g1.tenant_status_config
             WHERE tenant_id = %s
            """, (tenant,))
        row = await cur.fetchone()
    if row is None:
        return {"configured": False}
    return {
        "configured": True,
        "status_slug": row[0],
        "public_name": row[1],
        "enabled": row[2],
        "updated_at": row[3].isoformat(),
        "public_url": f"/status/{row[0]}",
        "components": row[4] if row[4] is not None else [],
    }


@router.put("/status-page", status_code=status.HTTP_200_OK)
async def upsert_status_page_config(request: Request,
                                    body: StatusPageConfig,
                                    tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    slug = body.status_slug.strip().lower()
    if not slug or not slug.replace("-", "").isalnum():
        raise HTTPException(
            status_code=422,
            detail="status_slug must be alphanumeric (hyphens allowed)")
    if not body.public_name.strip():
        raise HTTPException(status_code=422,
                            detail="public_name must not be empty")
    async with db_tenant_connection(tenant) as conn:
        try:
            await conn.execute(
                """
                INSERT INTO g1.tenant_status_config
                    (tenant_id, status_slug, public_name, enabled,
                     components, updated_at)
                VALUES (%s, %s, %s, %s, %s, now())
                ON CONFLICT (tenant_id) DO UPDATE
                SET status_slug  = EXCLUDED.status_slug,
                    public_name  = EXCLUDED.public_name,
                    enabled      = EXCLUDED.enabled,
                    components   = EXCLUDED.components,
                    updated_at   = now()
                """,
                (tenant, slug, body.public_name.strip(), body.enabled,
                 json.dumps(body.components)))
            await conn.commit()
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(
                    status_code=409,
                    detail=f"slug '{slug}' is already in use")
            raise
    return {
        "configured": True,
        "status_slug": slug,
        "public_name": body.public_name.strip(),
        "enabled": body.enabled,
        "public_url": f"/status/{slug}",
        "components": body.components,
    }
