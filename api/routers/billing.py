"""G26 Billing — invoice management and usage-based billing summary.

Adapter status: GET /api/v1/billing/status
Invoices:       GET/POST /api/v1/billing/invoices
                GET /api/v1/billing/invoices/{id}
                POST /api/v1/billing/invoices/{id}/void
Summary:        GET /api/v1/billing/summary
"""

from __future__ import annotations

import json
import os
import uuid
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared import access
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/billing", tags=["billing"])

_VALID_CURRENCIES = {"BRL", "USD", "EUR"}
_VALID_STATUSES = {"draft", "open", "paid", "void"}


def _require_tenant(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


async def _require_admin(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    principal_id = ctx.get("principal_id")
    tenant_id = ctx.get("tenant_id")
    if not principal_id or not tenant_id:
        raise HTTPException(status_code=403, detail="tenant context required")
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="tenant:admin required")
    return principal_id, tenant_id


# ── Adapter status ─────────────────────────────────────────────────────────────

@router.get("/status")
async def billing_status(request: Request) -> dict:
    """Return the configured billing adapter and its current status."""
    adapter_name = os.environ.get("BILLING_ADAPTER", "stub").lower().strip()
    return {
        "adapter": adapter_name,
        "status": "active",
        "detail": (
            "Stub adapter — usage is metered locally, no external billing provider."
            if adapter_name == "stub"
            else f"Adapter '{adapter_name}' configured."
        ),
    }


# ── Invoices ───────────────────────────────────────────────────────────────────

class InvoiceCreate(BaseModel):
    period_start: str               # ISO 8601 timestamp
    period_end: str
    amount_cents: int = 0
    currency: str = "BRL"
    line_items: list[dict] = []
    due_at: Optional[str] = None


@router.get("/invoices")
async def list_invoices(
    request: Request,
    inv_status: Optional[str] = None,
    limit: int = 50,
) -> list:
    tenant_id = _require_tenant(request)
    if inv_status and inv_status not in _VALID_STATUSES:
        raise HTTPException(status_code=422,
                            detail=f"status must be one of {sorted(_VALID_STATUSES)}")
    if limit < 1 or limit > 200:
        raise HTTPException(status_code=422, detail="limit must be 1-200")

    base = """
        SELECT invoice_id, account_id, period_start, period_end,
               amount_cents, currency, status, due_at, paid_at, created_at
          FROM g1.billing_invoice
         WHERE tenant_id = %s
    """
    params: list = [tenant_id]
    if inv_status:
        base += " AND status = %s"
        params.append(inv_status)
    base += " ORDER BY period_end DESC LIMIT %s"
    params.append(limit)

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(base, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.post("/invoices", status_code=status.HTTP_201_CREATED)
async def create_invoice(request: Request, body: InvoiceCreate) -> dict:
    _principal_id, tenant_id = await _require_admin(request)

    if body.currency not in _VALID_CURRENCIES:
        raise HTTPException(status_code=422,
                            detail=f"currency must be one of {sorted(_VALID_CURRENCIES)}")
    if body.amount_cents < 0:
        raise HTTPException(status_code=422, detail="amount_cents must be >= 0")

    try:
        period_start = datetime.fromisoformat(body.period_start.replace("Z", "+00:00"))
        period_end = datetime.fromisoformat(body.period_end.replace("Z", "+00:00"))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"invalid ISO date: {exc}") from exc
    if period_end <= period_start:
        raise HTTPException(status_code=422, detail="period_end must be after period_start")

    due_at = None
    if body.due_at:
        try:
            due_at = datetime.fromisoformat(body.due_at.replace("Z", "+00:00"))
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=f"invalid due_at: {exc}") from exc

    invoice_id = f"inv:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.billing_invoice
                (invoice_id, tenant_id, period_start, period_end,
                 amount_cents, currency, line_items, due_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (invoice_id, tenant_id, period_start, period_end,
             body.amount_cents, body.currency,
             json.dumps(body.line_items), due_at),
        )
        await conn.commit()
    return {"invoice_id": invoice_id, "status": "draft",
            "amount_cents": body.amount_cents, "currency": body.currency}


@router.get("/invoices/{invoice_id}")
async def get_invoice(request: Request, invoice_id: str) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT invoice_id, account_id, period_start, period_end,
                   amount_cents, currency, status, line_items,
                   due_at, paid_at, created_at, updated_at
              FROM g1.billing_invoice
             WHERE tenant_id=%s AND invoice_id=%s
            """,
            (tenant_id, invoice_id),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="invoice not found")
    cols = ["invoice_id", "account_id", "period_start", "period_end",
            "amount_cents", "currency", "status", "line_items",
            "due_at", "paid_at", "created_at", "updated_at"]
    data = dict(zip(cols, row))
    # Ensure line_items is a list (psycopg may return dict or str)
    if isinstance(data["line_items"], str):
        data["line_items"] = json.loads(data["line_items"])
    return data


@router.post("/invoices/{invoice_id}/mark-paid")
async def mark_invoice_paid(request: Request, invoice_id: str) -> dict:
    _principal_id, tenant_id = await _require_admin(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT status FROM g1.billing_invoice "
            "WHERE tenant_id=%s AND invoice_id=%s",
            (tenant_id, invoice_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="invoice not found")
        if row[0] not in ("draft", "open"):
            raise HTTPException(status_code=409,
                                detail=f"cannot mark a '{row[0]}' invoice as paid")
        await conn.execute(
            "UPDATE g1.billing_invoice "
            "SET status='paid', paid_at=now(), updated_at=now() "
            "WHERE invoice_id=%s",
            (invoice_id,),
        )
        await conn.commit()
    return {"invoice_id": invoice_id, "status": "paid"}


@router.post("/invoices/{invoice_id}/void")
async def void_invoice(request: Request, invoice_id: str) -> dict:
    _principal_id, tenant_id = await _require_admin(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT status FROM g1.billing_invoice "
            "WHERE tenant_id=%s AND invoice_id=%s",
            (tenant_id, invoice_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="invoice not found")
        if row[0] == "paid":
            raise HTTPException(status_code=409, detail="cannot void a paid invoice")
        if row[0] == "void":
            raise HTTPException(status_code=409, detail="invoice is already void")
        await conn.execute(
            "UPDATE g1.billing_invoice "
            "SET status='void', updated_at=now() "
            "WHERE invoice_id=%s",
            (invoice_id,),
        )
        await conn.commit()
    return {"invoice_id": invoice_id, "status": "void"}


# ── Billing summary ────────────────────────────────────────────────────────────

@router.get("/summary")
async def billing_summary(request: Request) -> dict:
    """Return billing summary: open invoices + current-month usage meters."""
    tenant_id = _require_tenant(request)

    async with db_tenant_connection(tenant_id) as conn:
        # Open / unpaid invoices total
        inv_cur = await conn.execute(
            """
            SELECT COUNT(*) AS open_count,
                   COALESCE(SUM(amount_cents), 0) AS open_amount_cents,
                   currency
              FROM g1.billing_invoice
             WHERE tenant_id=%s AND status IN ('draft', 'open')
             GROUP BY currency
            """,
            (tenant_id,),
        )
        open_invoices = [
            {"count": r[0], "amount_cents": r[1], "currency": r[2]}
            for r in await inv_cur.fetchall()
        ]

        # Current-month usage
        usage_cur = await conn.execute(
            """
            SELECT meter,
                   SUM(quantity)   AS total_quantity,
                   MIN(window_start) AS since
              FROM g1.usage_meters
             WHERE tenant_id=%s
               AND window_start >= date_trunc('month', now())
             GROUP BY meter
             ORDER BY meter
            """,
            (tenant_id,),
        )
        usage = [
            {"meter": r[0], "total_quantity": float(r[1]),
             "since": r[2].isoformat() if r[2] else None}
            for r in await usage_cur.fetchall()
        ]

        # Last paid invoice
        last_cur = await conn.execute(
            """
            SELECT invoice_id, amount_cents, currency, paid_at
              FROM g1.billing_invoice
             WHERE tenant_id=%s AND status='paid'
             ORDER BY paid_at DESC LIMIT 1
            """,
            (tenant_id,),
        )
        last_paid_row = await last_cur.fetchone()
        last_paid = None
        if last_paid_row:
            last_paid = {
                "invoice_id": last_paid_row[0],
                "amount_cents": last_paid_row[1],
                "currency": last_paid_row[2],
                "paid_at": last_paid_row[3].isoformat() if last_paid_row[3] else None,
            }

    adapter_name = os.environ.get("BILLING_ADAPTER", "stub").lower()
    return {
        "adapter": adapter_name,
        "open_invoices": open_invoices,
        "current_month_usage": usage,
        "last_paid_invoice": last_paid,
    }
