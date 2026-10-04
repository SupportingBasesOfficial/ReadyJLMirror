"""G30 ITSM Change Management API."""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/itsm", tags=["changes"])


# ── Models ────────────────────────────────────────────────────────────────────

class CreateRFC(BaseModel):
    title: str
    description: str = ""
    category: str = "normal"
    risk: str = "medium"
    planned_start: Optional[str] = None
    planned_end: Optional[str] = None
    incident_id: Optional[str] = None


class UpdateRFC(BaseModel):
    title: Optional[str] = None
    description: Optional[str] = None
    category: Optional[str] = None
    risk: Optional[str] = None
    state: Optional[str] = None
    planned_start: Optional[str] = None
    planned_end: Optional[str] = None


class CreateTask(BaseModel):
    title: str
    assignee_ref: Optional[str] = None


class UpdateTask(BaseModel):
    title: Optional[str] = None
    state: Optional[str] = None
    assignee_ref: Optional[str] = None


class RecordApproval(BaseModel):
    approver_ref: str
    decision: str          # 'approved' | 'rejected'
    notes: Optional[str] = None


_VALID_CATEGORIES  = {"standard", "normal", "emergency"}
_VALID_RISKS       = {"low", "medium", "high", "critical"}
_VALID_STATES      = {"draft", "review", "approved", "scheduled",
                      "implementing", "complete", "cancelled"}
_VALID_TASK_STATES = {"open", "in_progress", "done", "skipped"}
_VALID_DECISIONS   = {"approved", "rejected"}


def _require_tenant(request: Request) -> str:
    ctx = request.state.jlmirror_context
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


def _require_principal(request: Request) -> str:
    ctx = request.state.jlmirror_context
    pid = ctx.get("principal_id")
    if not pid:
        raise HTTPException(status_code=403, detail="principal context required")
    return pid


# ── RFC CRUD ─────────────────────────────────────────────────────────────────

@router.get("/changes")
async def list_changes(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT rfc_id, title, category, risk, state,
                   planned_start, planned_end, incident_id,
                   created_by, created_at, updated_at
              FROM g1.change_request
             WHERE tenant_id = %s
             ORDER BY created_at DESC
             LIMIT 200
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/changes", status_code=status.HTTP_201_CREATED)
async def create_change(request: Request, body: CreateRFC) -> dict:
    tenant_id = _require_tenant(request)
    principal = _require_principal(request)

    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title is required")
    if len(title) > 200:
        raise HTTPException(status_code=422, detail="title max 200 chars")
    if body.category not in _VALID_CATEGORIES:
        raise HTTPException(status_code=422, detail=f"invalid category: {body.category}")
    if body.risk not in _VALID_RISKS:
        raise HTTPException(status_code=422, detail=f"invalid risk: {body.risk}")

    rfc_id = f"rfc:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.change_request
                (rfc_id, tenant_id, title, description, category, risk,
                 planned_start, planned_end, incident_id, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (rfc_id, tenant_id, title, body.description or "",
             body.category, body.risk,
             body.planned_start, body.planned_end,
             body.incident_id, principal),
        )
        await conn.commit()
    return {"rfc_id": rfc_id, "state": "draft"}


@router.get("/changes/{rfc_id}")
async def get_change(request: Request, rfc_id: str) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            """
            SELECT rfc_id, title, description, category, risk, state,
                   planned_start, planned_end, incident_id,
                   created_by, created_at, updated_at
              FROM g1.change_request
             WHERE tenant_id = %s AND rfc_id = %s
            """,
            (tenant_id, rfc_id),
        )
        r = await row.fetchone()
        if r is None:
            raise HTTPException(status_code=404, detail="RFC not found")
        cols = [d[0] for d in row.description]
        rfc = dict(zip(cols, r))

        tasks_cur = await conn.execute(
            """
            SELECT task_id, title, state, assignee_ref, created_at, updated_at
              FROM g1.change_task
             WHERE rfc_id = %s
             ORDER BY created_at
            """,
            (rfc_id,),
        )
        tcols = [d[0] for d in tasks_cur.description]
        rfc["tasks"] = [dict(zip(tcols, t)) for t in await tasks_cur.fetchall()]

        appr_cur = await conn.execute(
            """
            SELECT approval_id, approver_ref, decision, notes, decided_at, created_at
              FROM g1.change_approval
             WHERE rfc_id = %s
             ORDER BY created_at
            """,
            (rfc_id,),
        )
        acols = [d[0] for d in appr_cur.description]
        rfc["approvals"] = [dict(zip(acols, a)) for a in await appr_cur.fetchall()]

    return rfc


@router.put("/changes/{rfc_id}")
async def update_change(request: Request, rfc_id: str, body: UpdateRFC) -> dict:
    tenant_id = _require_tenant(request)
    if body.category and body.category not in _VALID_CATEGORIES:
        raise HTTPException(status_code=422, detail=f"invalid category: {body.category}")
    if body.risk and body.risk not in _VALID_RISKS:
        raise HTTPException(status_code=422, detail=f"invalid risk: {body.risk}")
    if body.state and body.state not in _VALID_STATES:
        raise HTTPException(status_code=422, detail=f"invalid state: {body.state}")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT rfc_id FROM g1.change_request WHERE tenant_id=%s AND rfc_id=%s",
            (tenant_id, rfc_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="RFC not found")

        sets, vals = [], []
        for field in ("title", "description", "category", "risk",
                      "state", "planned_start", "planned_end"):
            v = getattr(body, field)
            if v is not None:
                sets.append(f"{field} = %s")
                vals.append(v)
        if not sets:
            return {"rfc_id": rfc_id, "updated": False}

        sets.append("updated_at = now()")
        vals.extend([tenant_id, rfc_id])
        await conn.execute(
            f"UPDATE g1.change_request SET {', '.join(sets)} "
            f"WHERE tenant_id=%s AND rfc_id=%s",
            vals,
        )
        await conn.commit()
    return {"rfc_id": rfc_id, "updated": True}


# ── Tasks ─────────────────────────────────────────────────────────────────────

@router.post("/changes/{rfc_id}/tasks", status_code=status.HTTP_201_CREATED)
async def create_task(request: Request, rfc_id: str, body: CreateTask) -> dict:
    tenant_id = _require_tenant(request)
    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title required")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT rfc_id FROM g1.change_request WHERE tenant_id=%s AND rfc_id=%s",
            (tenant_id, rfc_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="RFC not found")

        task_id = f"ctask:{uuid.uuid4()}"
        await conn.execute(
            """
            INSERT INTO g1.change_task (task_id, rfc_id, tenant_id, title, assignee_ref)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (task_id, rfc_id, tenant_id, title, body.assignee_ref),
        )
        await conn.commit()
    return {"task_id": task_id, "state": "open"}


@router.put("/changes/{rfc_id}/tasks/{task_id}")
async def update_task(request: Request, rfc_id: str,
                      task_id: str, body: UpdateTask) -> dict:
    tenant_id = _require_tenant(request)
    if body.state and body.state not in _VALID_TASK_STATES:
        raise HTTPException(status_code=422, detail=f"invalid state: {body.state}")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT task_id FROM g1.change_task "
            "WHERE rfc_id=%s AND task_id=%s AND tenant_id=%s",
            (rfc_id, task_id, tenant_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="task not found")

        sets, vals = [], []
        for field in ("title", "state", "assignee_ref"):
            v = getattr(body, field)
            if v is not None:
                sets.append(f"{field} = %s")
                vals.append(v)
        if not sets:
            return {"task_id": task_id, "updated": False}
        sets.append("updated_at = now()")
        vals.extend([rfc_id, task_id, tenant_id])
        await conn.execute(
            f"UPDATE g1.change_task SET {', '.join(sets)} "
            f"WHERE rfc_id=%s AND task_id=%s AND tenant_id=%s",
            vals,
        )
        await conn.commit()
    return {"task_id": task_id, "updated": True}


# ── Approvals ─────────────────────────────────────────────────────────────────

@router.post("/changes/{rfc_id}/approvals", status_code=status.HTTP_201_CREATED)
async def record_approval(request: Request, rfc_id: str,
                          body: RecordApproval) -> dict:
    tenant_id = _require_tenant(request)
    if body.decision not in _VALID_DECISIONS:
        raise HTTPException(status_code=422,
                            detail="decision must be approved or rejected")
    if not body.approver_ref.strip():
        raise HTTPException(status_code=422, detail="approver_ref required")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT rfc_id FROM g1.change_request WHERE tenant_id=%s AND rfc_id=%s",
            (tenant_id, rfc_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="RFC not found")

        approval_id = f"capproval:{uuid.uuid4()}"
        await conn.execute(
            """
            INSERT INTO g1.change_approval
                (approval_id, rfc_id, tenant_id, approver_ref,
                 decision, notes, decided_at)
            VALUES (%s, %s, %s, %s, %s, %s, now())
            """,
            (approval_id, rfc_id, tenant_id,
             body.approver_ref.strip(), body.decision, body.notes),
        )
        if body.decision == "approved":
            await conn.execute(
                """
                UPDATE g1.change_request
                   SET state = 'approved', updated_at = now()
                 WHERE tenant_id=%s AND rfc_id=%s AND state = 'review'
                """,
                (tenant_id, rfc_id),
            )
        await conn.commit()
    return {"approval_id": approval_id, "decision": body.decision}
