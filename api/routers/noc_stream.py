"""NOC live stream — SSE endpoint for real-time NOC dashboard updates.

Streams a combined snapshot (active alerts + monitoring sources) every 5 s.
Uses SSE (text/event-stream) per ADR-011 § 6 carve-out for unidirectional
server-to-browser workloads.  Authentication is inherited from the session
middleware — no additional gate needed.
"""

from __future__ import annotations

import asyncio
import json
from typing import AsyncGenerator

from fastapi import APIRouter, Request
from fastapi.responses import StreamingResponse

from api.routers.monitoring import _authoritative_tenant
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/noc", tags=["noc"])

_INTERVAL = 5  # seconds between snapshots


def _ser(row) -> dict:
    out = dict(row)
    for k, v in out.items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out


async def _snapshot(tenant: str) -> dict:
    async with db_tenant_connection(tenant) as conn:
        acur = await conn.execute(
            """
            SELECT alert_id, lifecycle_state, source_kind,
                   monitoring_source_id, monitoring_resource_id,
                   source_evidence_summary, opened_at, resolved_at
              FROM alerting.alert
             WHERE lifecycle_state = 'active'
             ORDER BY opened_at DESC
             LIMIT 50
            """,
        )
        cols_a = [d.name for d in acur.description]
        alerts = [_ser(dict(zip(cols_a, r))) for r in await acur.fetchall()]

        scur = await conn.execute(
            """
            SELECT monitoring_source_id, display_name, operational_evidence_state
              FROM monitoring.source
             ORDER BY display_name
            """,
        )
        cols_s = [d.name for d in scur.description]
        sources = [_ser(dict(zip(cols_s, r))) for r in await scur.fetchall()]

    return {"alerts": alerts, "sources": sources}


async def _event_stream(tenant: str) -> AsyncGenerator[str, None]:
    try:
        while True:
            try:
                snap = await _snapshot(tenant)
                payload = json.dumps(snap, separators=(",", ":"))
                yield f"data: {payload}\n\n"
            except Exception:
                # DB hiccup — send a heartbeat and retry next cycle
                yield ": ping\n\n"
            await asyncio.sleep(_INTERVAL)
    except (asyncio.CancelledError, GeneratorExit):
        pass


@router.get("/stream")
async def noc_stream(request: Request, tenant_id: str | None = None):
    tenant = _authoritative_tenant(request, tenant_id)
    return StreamingResponse(
        _event_stream(tenant),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
