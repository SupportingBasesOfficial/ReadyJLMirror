"""G13 FinOps — usage metering and entitlement visibility API.

Read-only. No pricing, no quota enforcement.
"""
from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request


def _get_context(request: Request) -> dict:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None:
        raise HTTPException(status_code=401, detail="authentication required")
    return ctx

from shared.db import db_connection

router = APIRouter(prefix="/api/v1/finops", tags=["finops"])


@router.get("/summary")
async def finops_summary(request: Request) -> dict:
    """Contract + entitlements + latest meter snapshot for the tenant."""
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]

    async with db_connection() as conn:
        # Contract
        cur = await conn.execute(
            """
            SELECT c.contract_id, c.plan_ref, c.state,
                   c.effective_from, c.effective_until
              FROM g1.contracts c
              JOIN g1.commercial_accounts ca ON c.account_id = ca.account_id
              JOIN g1.tenants t ON t.organization_id = ca.organization_id
             WHERE t.tenant_id = %s AND c.state = 'active'
             LIMIT 1
            """,
            (tenant_id,),
        )
        contract_row = await cur.fetchone()

        contract = None
        if contract_row:
            contract = {
                "contract_id": contract_row[0],
                "plan_ref": contract_row[1],
                "state": contract_row[2],
                "effective_from": contract_row[3].isoformat() if contract_row[3] else None,
                "effective_until": contract_row[4].isoformat() if contract_row[4] else None,
            }

        # Entitlements
        cur = await conn.execute(
            """
            SELECT e.entitlement_id, e.capability, e.state
              FROM g1.entitlements e
              JOIN g1.contracts c ON e.contract_id = c.contract_id
              JOIN g1.commercial_accounts ca ON c.account_id = ca.account_id
              JOIN g1.tenants t ON t.organization_id = ca.organization_id
             WHERE t.tenant_id = %s AND e.state = 'active' AND c.state = 'active'
             ORDER BY e.capability
            """,
            (tenant_id,),
        )
        entitlement_rows = await cur.fetchall()
        entitlements = [
            {"entitlement_id": r[0], "capability": r[1], "state": r[2]}
            for r in entitlement_rows
        ]

        # Latest meter snapshot (most recent reading per meter)
        cur = await conn.execute(
            """
            SELECT DISTINCT ON (meter)
                   meter, quantity, window_end
              FROM g1.usage_meters
             WHERE tenant_id = %s
               AND window_end > now() - interval '7 days'
             ORDER BY meter, window_end DESC
            """,
            (tenant_id,),
        )
        snapshot_rows = await cur.fetchall()
        snapshot = [
            {
                "meter": r[0],
                "quantity": float(r[1]),
                "window_end": r[2].isoformat(),
            }
            for r in snapshot_rows
        ]

    return {
        "tenant_id": tenant_id,
        "contract": contract,
        "entitlements": entitlements,
        "meter_snapshot": snapshot,
    }


@router.get("/usage")
async def finops_usage(
    request: Request,
    days: int = 7,
    limit: int = 200,
) -> list[dict]:
    """Meter history for the tenant (default last 7 days)."""
    ctx = _get_context(request)
    tenant_id = ctx["tenant_id"]
    days = min(max(days, 1), 90)
    limit = min(limit, 500)

    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT usage_id, meter, quantity, window_start, window_end, created_at
              FROM g1.usage_meters
             WHERE tenant_id = %s
               AND window_end > now() - (%s || ' days')::interval
             ORDER BY window_end DESC, meter
             LIMIT %s
            """,
            (tenant_id, str(days), limit),
        )
        rows = await cur.fetchall()

    return [
        {
            "usage_id": r[0],
            "meter": r[1],
            "quantity": float(r[2]),
            "window_start": r[3].isoformat(),
            "window_end": r[4].isoformat(),
            "created_at": r[5].isoformat(),
        }
        for r in rows
    ]
