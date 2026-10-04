"""G12 AIOps — advisory findings API.

Read-only. Findings are advisory only: ALERT ≠ AIOPS FINDING.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/aiops", tags=["aiops"])


def _ser_finding(r) -> dict:
    return {
        "finding_id": r[0],
        "finding_type": r[1],
        "severity_hint": r[2],
        "title": r[3],
        "explanation": r[4],
        "evidence_refs": r[5],
        "confidence": float(r[6]) if r[6] is not None else None,
        "model_id": r[7],
        "created_at": r[8].isoformat(),
        "expires_at": r[9].isoformat(),
        "dismissed_at": r[10].isoformat() if r[10] else None,
    }


@router.get("/findings")
async def list_findings(request: Request, limit: int = 50) -> list[dict]:
    ctx = request.state.jlmirror_context
    tenant_id = ctx["tenant_id"]
    limit = min(limit, 200)

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT finding_id, finding_type, severity_hint, title,
                   explanation, evidence_refs, confidence, model_id,
                   created_at, expires_at, dismissed_at
              FROM aiops.finding
             WHERE tenant_id = %s
               AND dismissed_at IS NULL
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
    ctx = request.state.jlmirror_context
    tenant_id = ctx["tenant_id"]

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT finding_id, finding_type, severity_hint, title,
                   explanation, evidence_refs, confidence, model_id,
                   created_at, expires_at, dismissed_at
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
    ctx = request.state.jlmirror_context
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
        await conn.commit()

    if row is None:
        raise HTTPException(
            status_code=404, detail="finding not found or already dismissed")

    return {"finding_id": row[0], "dismissed": True}
