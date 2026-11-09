"""G40 Helpdesk ticket system.

Distinct from G10 ITSM (incident management / change requests).
Helpdesk = client-facing support tickets with categories, SLA, and comments.

Permissions:
  - Open ticket: any authenticated tenant member (monitoring:read)
  - Comment publicly: monitoring:read (requester) or monitoring:operate (agent)
  - Internal note: monitoring:operate or tenant:admin
  - Assign / change status: monitoring:operate or tenant:admin
  - Manage categories: tenant:admin
"""

from __future__ import annotations

import logging
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel

from shared import access
from shared.db import db_connection, db_tenant_connection

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/helpdesk", tags=["helpdesk"])

_VALID_PRIORITIES = {"low", "medium", "high", "critical"}
_VALID_STATUSES = {"open", "in_progress", "waiting", "resolved", "closed"}


# ── Context helpers ────────────────────────────────────────────────────────────

def _require_tenant(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


def _actor(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    return ctx.get("principal_id", "dev-operator")


async def _require_operate(request: Request) -> tuple[str, str]:
    """Require monitoring:operate or tenant:admin. Returns (principal_id, tenant_id)."""
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    principal_id = ctx.get("principal_id")
    tenant_id = ctx.get("tenant_id")
    if not principal_id or not tenant_id:
        raise HTTPException(status_code=403, detail="tenant context required")
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")
    return principal_id, tenant_id


async def _require_admin(request: Request) -> tuple[str, str]:
    """Require tenant:admin. Returns (principal_id, tenant_id)."""
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


# ── Categories ─────────────────────────────────────────────────────────────────

class CategoryCreate(BaseModel):
    name: str
    description: str = ""
    response_secs: Optional[int] = None
    resolve_secs: Optional[int] = None


@router.get("/categories")
async def list_categories(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT category_id, name, description,
                   response_secs, resolve_secs, enabled, created_at
              FROM g1.helpdesk_category
             WHERE tenant_id = %s AND enabled = true
             ORDER BY name
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.post("/categories", status_code=status.HTTP_201_CREATED)
async def create_category(request: Request, body: CategoryCreate) -> dict:
    principal_id, tenant_id = await _require_admin(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if len(name) > 120:
        raise HTTPException(status_code=422, detail="name max 120 chars")

    category_id = f"hcat:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.helpdesk_category
                (category_id, tenant_id, name, description,
                 response_secs, resolve_secs)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (category_id, tenant_id, name, body.description,
             body.response_secs, body.resolve_secs),
        )
        await conn.commit()
    return {"category_id": category_id, "name": name}


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def disable_category(request: Request, category_id: str) -> Response:
    _principal_id, tenant_id = await _require_admin(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT category_id FROM g1.helpdesk_category "
            "WHERE tenant_id=%s AND category_id=%s",
            (tenant_id, category_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="category not found")
        await conn.execute(
            "UPDATE g1.helpdesk_category SET enabled=false, updated_at=now() "
            "WHERE category_id=%s",
            (category_id,),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Tickets ────────────────────────────────────────────────────────────────────

class TicketCreate(BaseModel):
    title: str
    description: str = ""
    priority: str = "medium"
    category_id: Optional[str] = None


class TicketUpdate(BaseModel):
    status: Optional[str] = None
    priority: Optional[str] = None
    assignee_id: Optional[str] = None


@router.get("/tickets")
async def list_tickets(request: Request, ticket_status: Optional[str] = None) -> list:
    tenant_id = _require_tenant(request)
    base_query = """
        SELECT ticket_id, category_id, title, description, priority, status,
               requester_id, assignee_id,
               response_sla_deadline_at, resolve_sla_deadline_at,
               first_response_at, resolved_at, created_at, updated_at
          FROM g1.helpdesk_ticket
         WHERE tenant_id = %s
    """
    params: list = [tenant_id]
    if ticket_status:
        if ticket_status not in _VALID_STATUSES:
            raise HTTPException(status_code=422,
                                detail=f"status must be one of {sorted(_VALID_STATUSES)}")
        base_query += " AND status = %s"
        params.append(ticket_status)
    base_query += " ORDER BY created_at DESC LIMIT 200"

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(base_query, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.post("/tickets", status_code=status.HTTP_201_CREATED)
async def create_ticket(request: Request, body: TicketCreate) -> dict:
    tenant_id = _require_tenant(request)
    principal_id = _actor(request)

    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title is required")
    if len(title) > 255:
        raise HTTPException(status_code=422, detail="title max 255 chars")
    if body.priority not in _VALID_PRIORITIES:
        raise HTTPException(status_code=422,
                            detail=f"priority must be one of {sorted(_VALID_PRIORITIES)}")

    ticket_id = f"htkt:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        # Validate category if provided
        if body.category_id:
            cur = await conn.execute(
                "SELECT response_secs, resolve_secs FROM g1.helpdesk_category "
                "WHERE tenant_id=%s AND category_id=%s AND enabled=true",
                (tenant_id, body.category_id),
            )
            cat = await cur.fetchone()
            if cat is None:
                raise HTTPException(status_code=404, detail="category not found")
            resp_sla = (
                f"now() + ({cat[0]} * interval '1 second')" if cat[0] else "NULL"
            )
            resol_sla = (
                f"now() + ({cat[1]} * interval '1 second')" if cat[1] else "NULL"
            )
        else:
            resp_sla = "NULL"
            resol_sla = "NULL"

        await conn.execute(
            f"""
            INSERT INTO g1.helpdesk_ticket
                (ticket_id, tenant_id, category_id, title, description,
                 priority, requester_id,
                 response_sla_deadline_at, resolve_sla_deadline_at)
            VALUES (%s, %s, %s, %s, %s, %s, %s, {resp_sla}, {resol_sla})
            """,
            (ticket_id, tenant_id, body.category_id, title,
             body.description, body.priority, principal_id),
        )
        await conn.commit()
    return {"ticket_id": ticket_id, "title": title, "status": "open"}


@router.get("/tickets/{ticket_id}")
async def get_ticket(request: Request, ticket_id: str) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT ticket_id, category_id, title, description, priority, status,
                   requester_id, assignee_id,
                   response_sla_deadline_at, resolve_sla_deadline_at,
                   first_response_at, resolved_at, closed_at,
                   created_at, updated_at
              FROM g1.helpdesk_ticket
             WHERE tenant_id=%s AND ticket_id=%s
            """,
            (tenant_id, ticket_id),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="ticket not found")
    cols = ["ticket_id", "category_id", "title", "description", "priority", "status",
            "requester_id", "assignee_id",
            "response_sla_deadline_at", "resolve_sla_deadline_at",
            "first_response_at", "resolved_at", "closed_at",
            "created_at", "updated_at"]
    return dict(zip(cols, row))


@router.patch("/tickets/{ticket_id}")
async def update_ticket(request: Request, ticket_id: str, body: TicketUpdate) -> dict:
    principal_id, tenant_id = await _require_operate(request)

    updates: dict = {}
    if body.status is not None:
        if body.status not in _VALID_STATUSES:
            raise HTTPException(status_code=422,
                                detail=f"status must be one of {sorted(_VALID_STATUSES)}")
        updates["status"] = body.status
        if body.status == "resolved":
            updates["resolved_at"] = "now()"
        elif body.status == "closed":
            updates["closed_at"] = "now()"
    if body.priority is not None:
        if body.priority not in _VALID_PRIORITIES:
            raise HTTPException(status_code=422,
                                detail=f"priority must be one of {sorted(_VALID_PRIORITIES)}")
        updates["priority"] = body.priority
    if body.assignee_id is not None:
        updates["assignee_id"] = body.assignee_id

    if not updates:
        raise HTTPException(status_code=422, detail="nothing to update")

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT ticket_id FROM g1.helpdesk_ticket "
            "WHERE tenant_id=%s AND ticket_id=%s",
            (tenant_id, ticket_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="ticket not found")

        # Build SET clause — timestamp literals use SQL functions, not params
        set_parts = []
        params: list = []
        for key, val in updates.items():
            if val in ("now()",):
                set_parts.append(f"{key}=now()")
            else:
                set_parts.append(f"{key}=%s")
                params.append(val)
        set_parts.append("updated_at=now()")
        params.extend([tenant_id, ticket_id])

        await conn.execute(
            f"UPDATE g1.helpdesk_ticket SET {', '.join(set_parts)} "
            "WHERE tenant_id=%s AND ticket_id=%s",
            params,
        )
        await conn.commit()
    return {"ticket_id": ticket_id, "updated": True}


# ── Comments ───────────────────────────────────────────────────────────────────

class CommentCreate(BaseModel):
    body: str
    is_internal: bool = False


@router.get("/tickets/{ticket_id}/comments")
async def list_comments(request: Request, ticket_id: str) -> list:
    tenant_id = _require_tenant(request)
    principal_id = _actor(request)

    async with db_tenant_connection(tenant_id) as conn:
        # Verify ticket exists in this tenant
        cur = await conn.execute(
            "SELECT ticket_id FROM g1.helpdesk_ticket "
            "WHERE tenant_id=%s AND ticket_id=%s",
            (tenant_id, ticket_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="ticket not found")

        # Check if caller can see internal notes
        async with db_connection() as pconn:
            perms = await access.effective_permissions(pconn, principal_id, tenant_id)
        can_see_internal = "monitoring:operate" in perms or "tenant:admin" in perms

        query = """
            SELECT comment_id, author_id, body, is_internal, created_at
              FROM g1.helpdesk_comment
             WHERE ticket_id = %s
        """
        params: list = [ticket_id]
        if not can_see_internal:
            query += " AND is_internal = false"
        query += " ORDER BY created_at"

        cur = await conn.execute(query, params)
        cols = [d[0] for d in cur.description]
        return [dict(zip(cols, r)) for r in await cur.fetchall()]


@router.post("/tickets/{ticket_id}/comments", status_code=status.HTTP_201_CREATED)
async def add_comment(request: Request, ticket_id: str, body: CommentCreate) -> dict:
    tenant_id = _require_tenant(request)
    principal_id = _actor(request)

    text = body.body.strip()
    if not text:
        raise HTTPException(status_code=422, detail="body is required")

    # Internal notes require operate permission
    if body.is_internal:
        async with db_connection() as conn:
            perms = await access.effective_permissions(conn, principal_id, tenant_id)
        if "monitoring:operate" not in perms and "tenant:admin" not in perms:
            raise HTTPException(status_code=403,
                                detail="monitoring:operate required for internal notes")

    comment_id = f"hcmt:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT ticket_id, first_response_at FROM g1.helpdesk_ticket "
            "WHERE tenant_id=%s AND ticket_id=%s",
            (tenant_id, ticket_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="ticket not found")

        await conn.execute(
            """
            INSERT INTO g1.helpdesk_comment
                (comment_id, ticket_id, tenant_id, author_id, body, is_internal)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (comment_id, ticket_id, tenant_id, principal_id, text, body.is_internal),
        )

        # Mark first agent response (non-internal comment from non-requester)
        if not body.is_internal and row[1] is None and row[0] != principal_id:
            await conn.execute(
                "UPDATE g1.helpdesk_ticket SET first_response_at=now(), updated_at=now() "
                "WHERE ticket_id=%s",
                (ticket_id,),
            )

        await conn.commit()
    return {"comment_id": comment_id, "is_internal": body.is_internal}
