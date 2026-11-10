"""Bug Reports — in-app user feedback and bug tracking."""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request
from pydantic import BaseModel

from shared import access
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/bugs", tags=["bugs"])


def _ctx(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None or not ctx.get("tenant_id") or not ctx.get("principal_id"):
        raise HTTPException(status_code=403, detail="tenant context required")
    return ctx["tenant_id"], ctx["principal_id"]


async def _require_admin(request: Request) -> tuple[str, str]:
    tenant_id, principal_id = _ctx(request)
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="tenant:admin required")
    return tenant_id, principal_id


class CreateBugReport(BaseModel):
    screen_id: str
    screen_url: Optional[str] = None
    title: str
    description: str = ""
    error_info: Optional[dict] = None
    user_agent: Optional[str] = None


class UpdateBugReport(BaseModel):
    status: Optional[str] = None
    resolution: Optional[str] = None


@router.post("", status_code=201)
async def create_bug_report(request: Request, body: CreateBugReport) -> dict:
    tenant_id, principal_id = _ctx(request)
    report_id = f"bug:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.bug_reports
                (report_id, tenant_id, screen_id, screen_url, title, description,
                 error_info, user_agent, reported_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                report_id, tenant_id, body.screen_id, body.screen_url,
                body.title, body.description,
                __import__("json").dumps(body.error_info) if body.error_info else None,
                body.user_agent, principal_id,
            ),
        )
        await conn.commit()
    return {"report_id": report_id}


@router.get("")
async def list_bug_reports(
    request: Request,
    status: Optional[str] = Query(None),
    screen_id: Optional[str] = Query(None),
    limit: int = Query(100, le=500),
) -> list[dict]:
    tenant_id, _ = await _require_admin(request)
    clauses = ["tenant_id = %s"]
    params: list = [tenant_id]
    if status:
        clauses.append("status = %s")
        params.append(status)
    if screen_id:
        clauses.append("screen_id = %s")
        params.append(screen_id)
    params.append(min(limit, 500))
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            f"""
            SELECT report_id, screen_id, screen_url, title, description,
                   error_info, reported_by, status, resolution, created_at, updated_at
              FROM g1.bug_reports
             WHERE {' AND '.join(clauses)}
             ORDER BY created_at DESC LIMIT %s
            """,
            tuple(params),
        )
        rows = await cur.fetchall()
    return [
        {
            "report_id": r[0], "screen_id": r[1], "screen_url": r[2],
            "title": r[3], "description": r[4], "error_info": r[5],
            "reported_by": r[6], "status": r[7], "resolution": r[8],
            "created_at": r[9].isoformat() if r[9] else None,
            "updated_at": r[10].isoformat() if r[10] else None,
        }
        for r in rows
    ]


@router.patch("/{report_id}")
async def update_bug_report(
    request: Request, report_id: str, body: UpdateBugReport
) -> dict:
    tenant_id, _ = await _require_admin(request)
    valid_statuses = {"open", "in_progress", "resolved", "wont_fix"}
    if body.status and body.status not in valid_statuses:
        raise HTTPException(status_code=422, detail=f"invalid status: {body.status}")
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT report_id FROM g1.bug_reports WHERE report_id = %s AND tenant_id = %s",
            (report_id, tenant_id),
        )
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="report not found")
        sets = ["updated_at = now()"]
        params: list = []
        if body.status:
            sets.append("status = %s")
            params.append(body.status)
        if body.resolution is not None:
            sets.append("resolution = %s")
            params.append(body.resolution)
        params.append(report_id)
        params.append(tenant_id)
        await conn.execute(
            f"UPDATE g1.bug_reports SET {', '.join(sets)} WHERE report_id = %s AND tenant_id = %s",
            tuple(params),
        )
        await conn.commit()
    return {"report_id": report_id, "updated": True}
