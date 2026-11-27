"""Workflows — sequenced step execution with per-step approval gates."""

from __future__ import annotations

import json
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared import access
from shared.auth import _require_ctx, _require_operate
from shared.db import db_connection

router = APIRouter(prefix="/workflows", tags=["workflows"])

_STEP_TYPES = {"manual", "noop", "webhook"}


# ── Models ────────────────────────────────────────────────────────────────────

class WorkflowCreate(BaseModel):
    name: str
    description: str = ""


class WorkflowUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    status: Optional[str] = None


class StepCreate(BaseModel):
    name: str
    description: str = ""
    step_type: str = "manual"
    config: dict = {}
    approval_required: bool = False


class StepUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    step_type: Optional[str] = None
    config: Optional[dict] = None
    approval_required: Optional[bool] = None


class CompleteStepBody(BaseModel):
    output: Optional[str] = None


class RejectStepBody(BaseModel):
    reason: str = ""


class CloneBody(BaseModel):
    target_tenant_id: UUID
    new_name: Optional[str] = None


# ── Auth helpers ──────────────────────────────────────────────────────────────

async def _require_admin_ctx(request: Request) -> dict:
    ctx = _require_operate(request)
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, ctx["principal_id"], ctx["tenant_id"])
    if "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="tenant:admin required")
    return ctx


async def _require_platform_admin(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None:
        raise HTTPException(status_code=403, detail="platform admin required")
    async with db_connection() as conn:
        ok = await access.principal_is_platform_admin(conn, ctx["principal_id"])
    if not ok:
        raise HTTPException(status_code=403, detail="platform admin required")
    return ctx["principal_id"]


# ── Workflow CRUD ─────────────────────────────────────────────────────────────

@router.get("/")
async def list_workflows(request: Request) -> list:
    ctx = _require_ctx(request)
    tenant_id = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT w.id, w.name, w.description, w.status, w.cloned_from,
                   w.created_at, w.updated_at,
                   COUNT(ws.id)::int AS step_count,
                   (SELECT status FROM g1.workflow_run wr
                     WHERE wr.workflow_id = w.id AND wr.tenant_id = $1
                     ORDER BY wr.created_at DESC LIMIT 1) AS last_run_status
              FROM g1.workflow w
              LEFT JOIN g1.workflow_step ws ON ws.workflow_id = w.id
             WHERE w.tenant_id = $1
             GROUP BY w.id
             ORDER BY w.created_at DESC
            """,
            tenant_id,
        )
    return [dict(r) for r in rows]


@router.post("/", status_code=status.HTTP_201_CREATED)
async def create_workflow(request: Request, body: WorkflowCreate) -> dict:
    ctx = _require_operate(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "INSERT INTO g1.workflow (tenant_id, name, description) VALUES ($1, $2, $3) "
            "RETURNING id, name, description, status, created_at",
            ctx["tenant_id"], name, body.description,
        )
    return dict(row)


@router.get("/runs")
async def list_all_runs(request: Request) -> list:
    ctx = _require_ctx(request)
    tenant_id = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT wr.id, wr.workflow_id, w.name AS workflow_name, wr.status,
                   wr.current_step_position, wr.started_at, wr.finished_at,
                   COUNT(sr.id)::int AS total_steps,
                   SUM(CASE WHEN sr.status IN ('completed','approved') THEN 1 ELSE 0 END)::int AS done_steps
              FROM g1.workflow_run wr
              JOIN g1.workflow w ON w.id = wr.workflow_id
              LEFT JOIN g1.workflow_step_run sr ON sr.run_id = wr.id
             WHERE wr.tenant_id = $1
             GROUP BY wr.id, w.name
             ORDER BY wr.created_at DESC
             LIMIT 100
            """,
            tenant_id,
        )
    return [dict(r) for r in rows]


@router.get("/{workflow_id}")
async def get_workflow(request: Request, workflow_id: UUID) -> dict:
    ctx = _require_ctx(request)
    tenant_id = ctx["tenant_id"]
    async with db_connection() as conn:
        wf = await conn.fetchrow(
            "SELECT id, name, description, status, cloned_from, created_at, updated_at "
            "FROM g1.workflow WHERE id = $1 AND tenant_id = $2",
            workflow_id, tenant_id,
        )
        if wf is None:
            raise HTTPException(status_code=404, detail="workflow not found")
        steps = await conn.fetch(
            "SELECT id, position, name, description, step_type, config, approval_required "
            "FROM g1.workflow_step WHERE workflow_id = $1 ORDER BY position",
            workflow_id,
        )
    result = dict(wf)
    result["steps"] = [dict(s) for s in steps]
    return result


@router.put("/{workflow_id}")
async def update_workflow(request: Request, workflow_id: UUID, body: WorkflowUpdate) -> dict:
    ctx = _require_operate(request)
    tenant_id = ctx["tenant_id"]
    if body.status and body.status not in ("active", "archived"):
        raise HTTPException(status_code=422, detail="status must be active or archived")
    async with db_connection() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM g1.workflow WHERE id = $1 AND tenant_id = $2",
            workflow_id, tenant_id,
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="workflow not found")
        sets, vals, i = [], [], 1
        for field in ("name", "description", "status"):
            v = getattr(body, field)
            if v is not None:
                sets.append(f"{field} = ${i}")
                vals.append(v)
                i += 1
        if not sets:
            return {"id": str(workflow_id), "updated": False}
        sets.append("updated_at = now()")
        vals.extend([workflow_id, tenant_id])
        await conn.execute(
            f"UPDATE g1.workflow SET {', '.join(sets)} WHERE id = ${i} AND tenant_id = ${i+1}",
            *vals,
        )
    return {"id": str(workflow_id), "updated": True}


@router.delete("/{workflow_id}", status_code=status.HTTP_204_NO_CONTENT)
async def archive_workflow(request: Request, workflow_id: UUID):
    ctx = _require_operate(request)
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "UPDATE g1.workflow SET status='archived', updated_at=now() "
            "WHERE id=$1 AND tenant_id=$2 RETURNING id",
            workflow_id, ctx["tenant_id"],
        )
        if row is None:
            raise HTTPException(status_code=404, detail="workflow not found")


# ── Steps ─────────────────────────────────────────────────────────────────────

@router.post("/{workflow_id}/steps", status_code=status.HTTP_201_CREATED)
async def add_step(request: Request, workflow_id: UUID, body: StepCreate) -> dict:
    ctx = _require_operate(request)
    tenant_id = ctx["tenant_id"]
    if body.step_type not in _STEP_TYPES:
        raise HTTPException(status_code=422, detail=f"step_type must be one of {sorted(_STEP_TYPES)}")
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    async with db_connection() as conn:
        wf = await conn.fetchrow(
            "SELECT id FROM g1.workflow WHERE id=$1 AND tenant_id=$2",
            workflow_id, tenant_id,
        )
        if wf is None:
            raise HTTPException(status_code=404, detail="workflow not found")
        pos_row = await conn.fetchrow(
            "SELECT COALESCE(MAX(position), 0) + 1 AS next_pos FROM g1.workflow_step WHERE workflow_id=$1",
            workflow_id,
        )
        row = await conn.fetchrow(
            """
            INSERT INTO g1.workflow_step
                (workflow_id, tenant_id, position, name, description, step_type, config, approval_required)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            RETURNING id, position, name, description, step_type, config, approval_required
            """,
            workflow_id, tenant_id, pos_row["next_pos"],
            name, body.description, body.step_type, json.dumps(body.config), body.approval_required,
        )
    return dict(row)


@router.put("/{workflow_id}/steps/{step_id}")
async def update_step(request: Request, workflow_id: UUID, step_id: UUID, body: StepUpdate) -> dict:
    ctx = _require_operate(request)
    tenant_id = ctx["tenant_id"]
    if body.step_type and body.step_type not in _STEP_TYPES:
        raise HTTPException(status_code=422, detail=f"step_type must be one of {sorted(_STEP_TYPES)}")
    async with db_connection() as conn:
        existing = await conn.fetchrow(
            "SELECT id FROM g1.workflow_step WHERE id=$1 AND workflow_id=$2 AND tenant_id=$3",
            step_id, workflow_id, tenant_id,
        )
        if existing is None:
            raise HTTPException(status_code=404, detail="step not found")
        sets, vals, i = [], [], 1
        for field in ("name", "description", "step_type", "approval_required"):
            v = getattr(body, field)
            if v is not None:
                sets.append(f"{field} = ${i}")
                vals.append(v)
                i += 1
        if body.config is not None:
            sets.append(f"config = ${i}")
            vals.append(json.dumps(body.config))
            i += 1
        if not sets:
            return {"id": str(step_id), "updated": False}
        vals.extend([step_id, workflow_id, tenant_id])
        await conn.execute(
            f"UPDATE g1.workflow_step SET {', '.join(sets)} "
            f"WHERE id = ${i} AND workflow_id = ${i+1} AND tenant_id = ${i+2}",
            *vals,
        )
    return {"id": str(step_id), "updated": True}


@router.delete("/{workflow_id}/steps/{step_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_step(request: Request, workflow_id: UUID, step_id: UUID):
    ctx = _require_operate(request)
    tenant_id = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "DELETE FROM g1.workflow_step WHERE id=$1 AND workflow_id=$2 AND tenant_id=$3 RETURNING position",
            step_id, workflow_id, tenant_id,
        )
        if row is None:
            raise HTTPException(status_code=404, detail="step not found")
        await conn.execute(
            "UPDATE g1.workflow_step SET position = position - 1 WHERE workflow_id=$1 AND position > $2",
            workflow_id, row["position"],
        )


# ── Runs ──────────────────────────────────────────────────────────────────────

@router.post("/{workflow_id}/runs", status_code=status.HTTP_201_CREATED)
async def start_run(request: Request, workflow_id: UUID) -> dict:
    ctx = _require_operate(request)
    tenant_id = ctx["tenant_id"]
    principal_id = ctx["principal_id"]
    async with db_connection() as conn:
        wf = await conn.fetchrow(
            "SELECT id FROM g1.workflow WHERE id=$1 AND tenant_id=$2 AND status='active'",
            workflow_id, tenant_id,
        )
        if wf is None:
            raise HTTPException(status_code=404, detail="workflow not found or archived")
        steps = await conn.fetch(
            "SELECT id, position FROM g1.workflow_step WHERE workflow_id=$1 ORDER BY position",
            workflow_id,
        )
        if not steps:
            raise HTTPException(status_code=409, detail="workflow has no steps")
        run = await conn.fetchrow(
            "INSERT INTO g1.workflow_run (workflow_id, tenant_id, current_step_position, triggered_by) "
            "VALUES ($1, $2, $3, $4) RETURNING id, status, current_step_position, started_at",
            workflow_id, tenant_id, steps[0]["position"], principal_id,
        )
        run_id = run["id"]
        for s in steps:
            st = "running" if s["position"] == steps[0]["position"] else "pending"
            await conn.execute(
                "INSERT INTO g1.workflow_step_run (run_id, step_id, tenant_id, position, status, started_at) "
                "VALUES ($1, $2, $3, $4, $5, $6)",
                run_id, s["id"], tenant_id, s["position"],
                st, (run["started_at"] if st == "running" else None),
            )
    return dict(run)


@router.get("/{workflow_id}/runs")
async def list_runs(request: Request, workflow_id: UUID) -> list:
    ctx = _require_ctx(request)
    tenant_id = ctx["tenant_id"]
    async with db_connection() as conn:
        wf = await conn.fetchrow(
            "SELECT id FROM g1.workflow WHERE id=$1 AND tenant_id=$2",
            workflow_id, tenant_id,
        )
        if wf is None:
            raise HTTPException(status_code=404, detail="workflow not found")
        rows = await conn.fetch(
            """
            SELECT wr.id, wr.workflow_id, wr.status, wr.current_step_position,
                   wr.started_at, wr.finished_at,
                   COUNT(sr.id)::int AS total_steps,
                   SUM(CASE WHEN sr.status IN ('completed','approved') THEN 1 ELSE 0 END)::int AS done_steps
              FROM g1.workflow_run wr
              LEFT JOIN g1.workflow_step_run sr ON sr.run_id = wr.id
             WHERE wr.workflow_id = $1 AND wr.tenant_id = $2
             GROUP BY wr.id
             ORDER BY wr.created_at DESC
             LIMIT 50
            """,
            workflow_id, tenant_id,
        )
    return [dict(r) for r in rows]


@router.get("/runs/{run_id}")
async def get_run(request: Request, run_id: UUID) -> dict:
    ctx = _require_ctx(request)
    tenant_id = ctx["tenant_id"]
    async with db_connection() as conn:
        run = await conn.fetchrow(
            "SELECT id, workflow_id, status, current_step_position, triggered_by, "
            "       started_at, finished_at, created_at "
            "FROM g1.workflow_run WHERE id=$1 AND tenant_id=$2",
            run_id, tenant_id,
        )
        if run is None:
            raise HTTPException(status_code=404, detail="run not found")
        step_runs = await conn.fetch(
            """
            SELECT sr.id, sr.step_id, sr.position, sr.status,
                   ws.name AS step_name, ws.description AS step_description,
                   ws.step_type, ws.approval_required,
                   sr.approved_by, sr.approved_at, sr.rejection_reason,
                   sr.output, sr.started_at, sr.finished_at
              FROM g1.workflow_step_run sr
              JOIN g1.workflow_step ws ON ws.id = sr.step_id
             WHERE sr.run_id = $1
             ORDER BY sr.position
            """,
            run_id,
        )
    result = dict(run)
    result["step_runs"] = [dict(sr) for sr in step_runs]
    return result


@router.post("/runs/{run_id}/steps/{step_run_id}/complete")
async def complete_step(request: Request, run_id: UUID, step_run_id: UUID, body: CompleteStepBody) -> dict:
    ctx = _require_operate(request)
    tenant_id = ctx["tenant_id"]
    async with db_connection() as conn:
        sr = await conn.fetchrow(
            """
            SELECT sr.id, sr.position, sr.status, ws.approval_required
              FROM g1.workflow_step_run sr
              JOIN g1.workflow_step ws ON ws.id = sr.step_id
             WHERE sr.id=$1 AND sr.run_id=$2 AND sr.tenant_id=$3
            """,
            step_run_id, run_id, tenant_id,
        )
        if sr is None:
            raise HTTPException(status_code=404, detail="step run not found")
        if sr["status"] not in ("running", "pending"):
            raise HTTPException(status_code=409, detail=f"step is {sr['status']}, cannot complete")
        new_status = "waiting_approval" if sr["approval_required"] else "completed"
        await conn.execute(
            "UPDATE g1.workflow_step_run SET status=$1, output=$2, finished_at=now() WHERE id=$3",
            new_status, body.output, step_run_id,
        )
        if new_status == "waiting_approval":
            await conn.execute(
                "UPDATE g1.workflow_run SET status='waiting_approval' WHERE id=$1 AND tenant_id=$2",
                run_id, tenant_id,
            )
            return {"step_run_id": str(step_run_id), "status": new_status}
        next_sr = await conn.fetchrow(
            "SELECT id, position FROM g1.workflow_step_run "
            "WHERE run_id=$1 AND status='pending' ORDER BY position LIMIT 1",
            run_id,
        )
        if next_sr:
            await conn.execute(
                "UPDATE g1.workflow_step_run SET status='running', started_at=now() WHERE id=$1",
                next_sr["id"],
            )
            await conn.execute(
                "UPDATE g1.workflow_run SET status='running', current_step_position=$1 WHERE id=$2",
                next_sr["position"], run_id,
            )
        else:
            await conn.execute(
                "UPDATE g1.workflow_run SET status='completed', finished_at=now() WHERE id=$1",
                run_id,
            )
    return {"step_run_id": str(step_run_id), "status": new_status}


@router.post("/runs/{run_id}/steps/{step_run_id}/approve")
async def approve_step(request: Request, run_id: UUID, step_run_id: UUID) -> dict:
    ctx = await _require_admin_ctx(request)
    tenant_id = ctx["tenant_id"]
    principal_id = ctx["principal_id"]
    async with db_connection() as conn:
        sr = await conn.fetchrow(
            "SELECT id, position FROM g1.workflow_step_run "
            "WHERE id=$1 AND run_id=$2 AND tenant_id=$3 AND status='waiting_approval'",
            step_run_id, run_id, tenant_id,
        )
        if sr is None:
            raise HTTPException(status_code=409, detail="step not found or not waiting for approval")
        await conn.execute(
            "UPDATE g1.workflow_step_run SET status='approved', approved_by=$1, approved_at=now() WHERE id=$2",
            principal_id, step_run_id,
        )
        next_sr = await conn.fetchrow(
            "SELECT id, position FROM g1.workflow_step_run "
            "WHERE run_id=$1 AND status='pending' ORDER BY position LIMIT 1",
            run_id,
        )
        if next_sr:
            await conn.execute(
                "UPDATE g1.workflow_step_run SET status='running', started_at=now() WHERE id=$1",
                next_sr["id"],
            )
            await conn.execute(
                "UPDATE g1.workflow_run SET status='running', current_step_position=$1 WHERE id=$2",
                next_sr["position"], run_id,
            )
        else:
            await conn.execute(
                "UPDATE g1.workflow_run SET status='completed', finished_at=now() WHERE id=$1",
                run_id,
            )
    return {"step_run_id": str(step_run_id), "status": "approved"}


@router.post("/runs/{run_id}/steps/{step_run_id}/reject")
async def reject_step(request: Request, run_id: UUID, step_run_id: UUID, body: RejectStepBody) -> dict:
    ctx = await _require_admin_ctx(request)
    tenant_id = ctx["tenant_id"]
    async with db_connection() as conn:
        sr = await conn.fetchrow(
            "SELECT id FROM g1.workflow_step_run "
            "WHERE id=$1 AND run_id=$2 AND tenant_id=$3 AND status='waiting_approval'",
            step_run_id, run_id, tenant_id,
        )
        if sr is None:
            raise HTTPException(status_code=409, detail="step not found or not waiting for approval")
        await conn.execute(
            "UPDATE g1.workflow_step_run SET status='rejected', rejection_reason=$1, finished_at=now() WHERE id=$2",
            body.reason or None, step_run_id,
        )
        await conn.execute(
            "UPDATE g1.workflow_run SET status='failed', finished_at=now() WHERE id=$1",
            run_id,
        )
    return {"step_run_id": str(step_run_id), "status": "rejected"}


@router.post("/runs/{run_id}/cancel")
async def cancel_run(request: Request, run_id: UUID) -> dict:
    ctx = _require_operate(request)
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "UPDATE g1.workflow_run SET status='cancelled', finished_at=now() "
            "WHERE id=$1 AND tenant_id=$2 AND status IN ('running','waiting_approval') RETURNING id",
            run_id, ctx["tenant_id"],
        )
        if row is None:
            raise HTTPException(status_code=409, detail="run not found or already finished")
    return {"run_id": str(run_id), "cancelled": True}


# ── Clone ─────────────────────────────────────────────────────────────────────

@router.post("/{workflow_id}/clone", status_code=status.HTTP_201_CREATED)
async def clone_workflow(request: Request, workflow_id: UUID, body: CloneBody) -> dict:
    """Clone a workflow + steps to a target tenant. Requires platform admin."""
    await _require_platform_admin(request)
    target_tenant_id = body.target_tenant_id
    async with db_connection() as conn:
        wf = await conn.fetchrow(
            "SELECT id, name, description FROM g1.workflow WHERE id=$1 AND status='active'",
            workflow_id,
        )
        if wf is None:
            raise HTTPException(status_code=404, detail="workflow not found or archived")
        tenant = await conn.fetchrow("SELECT id FROM g1.tenant WHERE id=$1", target_tenant_id)
        if tenant is None:
            raise HTTPException(status_code=404, detail="target tenant not found")
        new_name = (body.new_name or wf["name"]).strip()
        new_wf = await conn.fetchrow(
            "INSERT INTO g1.workflow (tenant_id, name, description, cloned_from) "
            "VALUES ($1, $2, $3, $4) RETURNING id, name",
            target_tenant_id, new_name, wf["description"], workflow_id,
        )
        steps = await conn.fetch(
            "SELECT position, name, description, step_type, config, approval_required "
            "FROM g1.workflow_step WHERE workflow_id=$1 ORDER BY position",
            workflow_id,
        )
        for s in steps:
            await conn.execute(
                """
                INSERT INTO g1.workflow_step
                    (workflow_id, tenant_id, position, name, description, step_type, config, approval_required)
                VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                """,
                new_wf["id"], target_tenant_id, s["position"],
                s["name"], s["description"], s["step_type"], json.dumps(dict(s["config"])), s["approval_required"],
            )
    return {"id": str(new_wf["id"]), "name": new_wf["name"], "target_tenant_id": str(target_tenant_id)}
