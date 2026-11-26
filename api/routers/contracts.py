"""Contratos por tenant — CRUD, lançamento de horas, fechamento mensal."""
from __future__ import annotations

import json
from datetime import date, datetime
from decimal import Decimal
from typing import Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, field_validator

from shared import access
from shared.audit import record_audit_event
from shared.db import db_connection

router = APIRouter(prefix="/api/v1/contracts", tags=["contracts"])

VALID_TYPES = {"recurring", "project", "sla", "retainer"}
VALID_STATUSES = {"draft", "active", "suspended", "closed"}
VALID_CLOSURE_STATUSES = {"open", "closed", "invoiced"}


def _require_ctx(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    pid = ctx.get("principal_id")
    if not tid or not pid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid, pid


async def _require_operate(request: Request) -> tuple[str, str]:
    tid, pid = _require_ctx(request)
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, pid, tid)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")
    return tid, pid


def _ser(v):
    if isinstance(v, (date, datetime)):
        return v.isoformat()
    if isinstance(v, Decimal):
        return float(v)
    return v


def _row_to_dict(keys: list[str], row) -> dict:
    return {k: _ser(v) for k, v in zip(keys, row)}


# ---------------------------------------------------------------------------
# Models

class ContractCreate(BaseModel):
    name: str
    contract_type: str = "recurring"
    status: str = "active"
    start_date: date
    end_date: Optional[date] = None
    monthly_hours: Optional[float] = None
    hourly_rate: Optional[float] = None
    currency: str = "BRL"
    client_id: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("name")
    @classmethod
    def validate_name(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("name must not be empty")
        return v.strip()

    @field_validator("contract_type")
    @classmethod
    def validate_type(cls, v: str) -> str:
        if v not in VALID_TYPES:
            raise ValueError(f"contract_type must be one of {sorted(VALID_TYPES)}")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: str) -> str:
        if v not in VALID_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_STATUSES)}")
        return v


class ContractUpdate(BaseModel):
    name: Optional[str] = None
    contract_type: Optional[str] = None
    status: Optional[str] = None
    end_date: Optional[date] = None
    monthly_hours: Optional[float] = None
    hourly_rate: Optional[float] = None
    currency: Optional[str] = None
    client_id: Optional[str] = None
    notes: Optional[str] = None

    @field_validator("contract_type")
    @classmethod
    def validate_type(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VALID_TYPES:
            raise ValueError(f"contract_type must be one of {sorted(VALID_TYPES)}")
        return v

    @field_validator("status")
    @classmethod
    def validate_status(cls, v: Optional[str]) -> Optional[str]:
        if v is not None and v not in VALID_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_STATUSES)}")
        return v


class HourEntry(BaseModel):
    description: str
    hours: float
    entry_date: Optional[date] = None

    @field_validator("hours")
    @classmethod
    def validate_hours(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("hours must be positive")
        if v > 24:
            raise ValueError("hours must be <= 24 per entry")
        return v

    @field_validator("description")
    @classmethod
    def validate_desc(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("description must not be empty")
        return v.strip()


class ClosureCreate(BaseModel):
    period_start: date
    period_end: date
    notes: Optional[str] = None


# ---------------------------------------------------------------------------
# Endpoints — Contracts

@router.get("")
async def list_contracts(request: Request, status: Optional[str] = None) -> list[dict]:
    tid, _ = _require_ctx(request)
    async with db_connection() as conn:
        if status:
            cur = await conn.execute(
                """
                SELECT c.contract_id, c.name, c.contract_type, c.status,
                       c.start_date, c.end_date, c.monthly_hours, c.hourly_rate,
                       c.currency, c.client_id, c.created_at,
                       COALESCE(SUM(h.hours), 0) AS used_hours_total
                FROM g1.contract c
                LEFT JOIN g1.contract_hour_entry h ON h.contract_id = c.contract_id
                WHERE c.tenant_id = %s AND c.status = %s
                GROUP BY c.contract_id
                ORDER BY c.created_at DESC
                """,
                (tid, status),
            )
        else:
            cur = await conn.execute(
                """
                SELECT c.contract_id, c.name, c.contract_type, c.status,
                       c.start_date, c.end_date, c.monthly_hours, c.hourly_rate,
                       c.currency, c.client_id, c.created_at,
                       COALESCE(SUM(h.hours), 0) AS used_hours_total
                FROM g1.contract c
                LEFT JOIN g1.contract_hour_entry h ON h.contract_id = c.contract_id
                WHERE c.tenant_id = %s
                GROUP BY c.contract_id
                ORDER BY c.created_at DESC
                """,
                (tid,),
            )
        rows = await cur.fetchall()
    keys = ["contract_id", "name", "contract_type", "status", "start_date", "end_date",
            "monthly_hours", "hourly_rate", "currency", "client_id", "created_at", "used_hours_total"]
    return [_row_to_dict(keys, r) for r in rows]


@router.post("", status_code=201)
async def create_contract(request: Request, body: ContractCreate) -> dict:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.contract
                (tenant_id, name, contract_type, status, start_date, end_date,
                 monthly_hours, hourly_rate, currency, client_id, notes, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING contract_id, created_at
            """,
            (tid, body.name, body.contract_type, body.status, body.start_date,
             body.end_date, body.monthly_hours, body.hourly_rate, body.currency,
             body.client_id, body.notes, pid),
        )
        row = await cur.fetchone()
        await record_audit_event(conn, pid, tid, "contract.created",
                                 {"contract_id": str(row[0]), "name": body.name})
    return {"contract_id": str(row[0]), "created_at": row[1].isoformat()}


@router.get("/{contract_id}")
async def get_contract(request: Request, contract_id: str) -> dict:
    tid, _ = _require_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT c.contract_id, c.name, c.contract_type, c.status,
                   c.start_date, c.end_date, c.monthly_hours, c.hourly_rate,
                   c.currency, c.client_id, c.notes, c.created_at, c.created_by,
                   COALESCE(SUM(h.hours), 0) AS used_hours_total
            FROM g1.contract c
            LEFT JOIN g1.contract_hour_entry h ON h.contract_id = c.contract_id
            WHERE c.contract_id = %s AND c.tenant_id = %s
            GROUP BY c.contract_id
            """,
            (contract_id, tid),
        )
        row = await cur.fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="not found")
    keys = ["contract_id", "name", "contract_type", "status", "start_date", "end_date",
            "monthly_hours", "hourly_rate", "currency", "client_id", "notes",
            "created_at", "created_by", "used_hours_total"]
    return _row_to_dict(keys, row)


@router.put("/{contract_id}")
async def update_contract(request: Request, contract_id: str, body: ContractUpdate) -> dict:
    tid, pid = await _require_operate(request)
    updates: list[str] = []
    params: list = []

    for field, col in [("name", "name"), ("contract_type", "contract_type"),
                       ("status", "status"), ("end_date", "end_date"),
                       ("monthly_hours", "monthly_hours"), ("hourly_rate", "hourly_rate"),
                       ("currency", "currency"), ("client_id", "client_id"), ("notes", "notes")]:
        val = getattr(body, field)
        if val is not None:
            updates.append(f"{col} = %s")
            params.append(val)

    if not updates:
        raise HTTPException(status_code=422, detail="nothing to update")

    params.extend([contract_id, tid])
    async with db_connection() as conn:
        cur = await conn.execute(
            f"UPDATE g1.contract SET {', '.join(updates)} "
            "WHERE contract_id = %s AND tenant_id = %s RETURNING contract_id",
            params,
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="not found")
        await record_audit_event(conn, pid, tid, "contract.updated",
                                 {"contract_id": contract_id, **body.model_dump(exclude_none=True)})
    return {"contract_id": str(row[0])}


@router.delete("/{contract_id}", status_code=204)
async def delete_contract(request: Request, contract_id: str) -> None:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM g1.contract WHERE contract_id = %s AND tenant_id = %s RETURNING contract_id",
            (contract_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="not found")
        await record_audit_event(conn, pid, tid, "contract.deleted", {"contract_id": contract_id})


# ---------------------------------------------------------------------------
# Endpoints — Hours

@router.get("/{contract_id}/hours")
async def list_hours(request: Request, contract_id: str, limit: int = 100, offset: int = 0) -> list[dict]:
    tid, _ = _require_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.contract WHERE contract_id = %s AND tenant_id = %s",
            (contract_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="not found")
        cur2 = await conn.execute(
            """
            SELECT entry_id, description, hours, entry_date, recorded_by, created_at
            FROM g1.contract_hour_entry
            WHERE contract_id = %s
            ORDER BY entry_date DESC, created_at DESC
            LIMIT %s OFFSET %s
            """,
            (contract_id, min(limit, 500), offset),
        )
        rows = await cur2.fetchall()
    keys = ["entry_id", "description", "hours", "entry_date", "recorded_by", "created_at"]
    return [_row_to_dict(keys, r) for r in rows]


@router.post("/{contract_id}/hours", status_code=201)
async def add_hours(request: Request, contract_id: str, body: HourEntry) -> dict:
    tid, pid = await _require_operate(request)
    entry_date = body.entry_date or date.today()
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.contract WHERE contract_id = %s AND tenant_id = %s AND status = 'active'",
            (contract_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="contract not found or not active")
        cur2 = await conn.execute(
            """
            INSERT INTO g1.contract_hour_entry
                (contract_id, tenant_id, description, hours, entry_date, recorded_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            RETURNING entry_id, created_at
            """,
            (contract_id, tid, body.description, body.hours, entry_date, pid),
        )
        row = await cur2.fetchone()
        await record_audit_event(conn, pid, tid, "contract.hours_added",
                                 {"contract_id": contract_id, "hours": body.hours, "date": str(entry_date)})
    return {"entry_id": str(row[0]), "created_at": row[1].isoformat()}


@router.delete("/{contract_id}/hours/{entry_id}", status_code=204)
async def delete_hour_entry(request: Request, contract_id: str, entry_id: str) -> None:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM g1.contract_hour_entry WHERE entry_id = %s AND contract_id = %s AND tenant_id = %s RETURNING entry_id",
            (entry_id, contract_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="not found")
        await record_audit_event(conn, pid, tid, "contract.hours_deleted", {"entry_id": entry_id})


# ---------------------------------------------------------------------------
# Endpoints — Closures

@router.get("/{contract_id}/closures")
async def list_closures(request: Request, contract_id: str) -> list[dict]:
    tid, _ = _require_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.contract WHERE contract_id = %s AND tenant_id = %s",
            (contract_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="not found")
        cur2 = await conn.execute(
            """
            SELECT closure_id, period_start, period_end, contracted_hours,
                   used_hours, total_amount, status, closed_at, notes, created_at
            FROM g1.contract_closure
            WHERE contract_id = %s
            ORDER BY period_start DESC
            """,
            (contract_id,),
        )
        rows = await cur2.fetchall()
    keys = ["closure_id", "period_start", "period_end", "contracted_hours",
            "used_hours", "total_amount", "status", "closed_at", "notes", "created_at"]
    return [_row_to_dict(keys, r) for r in rows]


@router.post("/{contract_id}/closures", status_code=201)
async def create_closure(request: Request, contract_id: str, body: ClosureCreate) -> dict:
    tid, pid = await _require_operate(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT monthly_hours, hourly_rate FROM g1.contract WHERE contract_id = %s AND tenant_id = %s",
            (contract_id, tid),
        )
        contract_row = await cur.fetchone()
        if not contract_row:
            raise HTTPException(status_code=404, detail="not found")
        monthly_hours, hourly_rate = contract_row

        # Sum hours in period
        cur2 = await conn.execute(
            "SELECT COALESCE(SUM(hours), 0) FROM g1.contract_hour_entry "
            "WHERE contract_id = %s AND entry_date BETWEEN %s AND %s",
            (contract_id, body.period_start, body.period_end),
        )
        used_hours = float((await cur2.fetchone())[0])
        total_amount = (used_hours * float(hourly_rate)) if hourly_rate else None

        cur3 = await conn.execute(
            """
            INSERT INTO g1.contract_closure
                (contract_id, tenant_id, period_start, period_end,
                 contracted_hours, used_hours, total_amount, notes)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            RETURNING closure_id, created_at
            """,
            (contract_id, tid, body.period_start, body.period_end,
             monthly_hours, used_hours, total_amount, body.notes),
        )
        row = await cur3.fetchone()
        await record_audit_event(conn, pid, tid, "contract.closure_created",
                                 {"contract_id": contract_id, "period": f"{body.period_start}/{body.period_end}",
                                  "used_hours": used_hours})
    return {
        "closure_id": str(row[0]),
        "used_hours": used_hours,
        "total_amount": total_amount,
        "created_at": row[1].isoformat(),
    }


@router.put("/{contract_id}/closures/{closure_id}")
async def update_closure_status(request: Request, contract_id: str, closure_id: str, status: str) -> dict:
    tid, pid = await _require_operate(request)
    if status not in VALID_CLOSURE_STATUSES:
        raise HTTPException(status_code=422, detail=f"status must be one of {sorted(VALID_CLOSURE_STATUSES)}")
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            UPDATE g1.contract_closure
            SET status = %s,
                closed_at = CASE WHEN %s IN ('closed','invoiced') THEN now() ELSE closed_at END,
                closed_by = CASE WHEN %s IN ('closed','invoiced') THEN %s ELSE closed_by END
            WHERE closure_id = %s AND contract_id = %s AND tenant_id = %s
            RETURNING closure_id
            """,
            (status, status, status, pid, closure_id, contract_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="not found")
        await record_audit_event(conn, pid, tid, "contract.closure_updated",
                                 {"closure_id": closure_id, "status": status})
    return {"closure_id": closure_id, "status": status}
