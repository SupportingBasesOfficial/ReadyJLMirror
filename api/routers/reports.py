"""G33 Scheduled Reports API."""

from __future__ import annotations

import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel

from shared import access
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/reports", tags=["reports"])

_VALID_TYPES = {"alert_summary", "sla_summary", "incident_summary"}


class CreateTemplate(BaseModel):
    name: str
    report_type: str
    delivery_email: str


class CreateSchedule(BaseModel):
    template_id: str
    interval_secs: int  # min 3600


def _require_tenant(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


async def _require_operator(request: Request) -> str:
    """Require monitoring:operate or tenant:admin — write operations on reports."""
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tenant_id = ctx.get("tenant_id")
    principal_id = ctx.get("principal_id")
    if not tenant_id or not principal_id:
        raise HTTPException(status_code=403, detail="tenant context required")
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403,
                            detail="monitoring:operate permission required")
    return tenant_id


# ── Templates ─────────────────────────────────────────────────────────────────

@router.get("/templates")
async def list_templates(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT template_id, name, report_type, delivery_email,
                   enabled, created_at
              FROM g1.report_template
             WHERE tenant_id = %s
             ORDER BY created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/templates", status_code=status.HTTP_201_CREATED)
async def create_template(request: Request, body: CreateTemplate) -> dict:
    tenant_id = await _require_operator(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if len(name) > 120:
        raise HTTPException(status_code=422, detail="name max 120 chars")
    if body.report_type not in _VALID_TYPES:
        raise HTTPException(status_code=422,
                            detail=f"report_type must be one of {sorted(_VALID_TYPES)}")
    email = body.delivery_email.strip()
    if "@" not in email or "." not in email:
        raise HTTPException(status_code=422, detail="invalid delivery_email")

    template_id = f"rpt:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.report_template
                (template_id, tenant_id, name, report_type, delivery_email)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (template_id, tenant_id, name, body.report_type, email),
        )
        await conn.commit()
    return {"template_id": template_id, "name": name}


@router.delete("/templates/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
async def disable_template(request: Request, template_id: str) -> Response:
    tenant_id = await _require_operator(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT template_id FROM g1.report_template "
            "WHERE tenant_id=%s AND template_id=%s",
            (tenant_id, template_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="template not found")
        await conn.execute(
            "UPDATE g1.report_template SET enabled=false, updated_at=now() "
            "WHERE tenant_id=%s AND template_id=%s",
            (tenant_id, template_id),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.post("/templates/{template_id}/trigger", status_code=status.HTTP_202_ACCEPTED)
async def trigger_template(request: Request, template_id: str) -> dict:
    """Enqueue an immediate one-off report generation for the template."""
    tenant_id = await _require_operator(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT template_id, report_type FROM g1.report_template "
            "WHERE tenant_id=%s AND template_id=%s AND enabled=true",
            (tenant_id, template_id),
        )
        record = await row.fetchone()
        if record is None:
            raise HTTPException(status_code=404,
                                detail="template not found or disabled")
        job_id = f"rjob:{uuid.uuid4()}"
        await conn.execute(
            """
            INSERT INTO g1.report_delivery
                (delivery_id, tenant_id, template_id, report_type,
                 recipient, outcome)
            VALUES (%s, %s, %s, %s, 'manual_trigger', 'pending')
            """,
            (job_id, tenant_id, template_id, record[1]),
        )
        await conn.commit()
    return {"job_id": job_id, "status": "queued"}


# ── Schedules ─────────────────────────────────────────────────────────────────

@router.get("/schedules")
async def list_schedules(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT s.report_schedule_id, s.template_id, t.name AS template_name,
                   t.report_type, t.delivery_email,
                   s.interval_secs, s.last_sent_at, s.next_send_at,
                   s.enabled, s.created_at
              FROM g1.report_schedule s
              JOIN g1.report_template t ON t.template_id = s.template_id
             WHERE s.tenant_id = %s
             ORDER BY s.created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/schedules", status_code=status.HTTP_201_CREATED)
async def create_schedule(request: Request, body: CreateSchedule) -> dict:
    tenant_id = await _require_operator(request)
    if body.interval_secs < 3600:
        raise HTTPException(status_code=422,
                            detail="interval_secs must be at least 3600 (1 hour)")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT template_id FROM g1.report_template "
            "WHERE tenant_id=%s AND template_id=%s AND enabled=true",
            (tenant_id, body.template_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404,
                                detail="template not found or disabled")

        schedule_id = f"rsched:{uuid.uuid4()}"
        await conn.execute(
            """
            INSERT INTO g1.report_schedule
                (report_schedule_id, tenant_id, template_id, interval_secs)
            VALUES (%s, %s, %s, %s)
            """,
            (schedule_id, tenant_id, body.template_id, body.interval_secs),
        )
        await conn.commit()
    return {"report_schedule_id": schedule_id, "template_id": body.template_id}


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(request: Request, schedule_id: str) -> Response:
    tenant_id = await _require_operator(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT report_schedule_id FROM g1.report_schedule "
            "WHERE tenant_id=%s AND report_schedule_id=%s",
            (tenant_id, schedule_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        await conn.execute(
            "UPDATE g1.report_schedule SET enabled=false "
            "WHERE report_schedule_id=%s",
            (schedule_id,),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Subscribers (stored as comma-separated emails in report_template.delivery_email) ──

class AddSubscriber(BaseModel):
    email: str


def _parse_subscribers(delivery_email: str) -> list[str]:
    """Return list of individual emails from a comma-separated delivery_email string."""
    return [e.strip() for e in delivery_email.split(",") if e.strip()]


def _valid_email(email: str) -> bool:
    return "@" in email and "." in email and len(email) <= 254


@router.get("/schedules/{schedule_id}/subscribers")
async def list_subscribers(request: Request, schedule_id: str) -> list:
    """Return the list of subscriber emails for the given schedule."""
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            """
            SELECT t.delivery_email
              FROM g1.report_schedule s
              JOIN g1.report_template t ON t.template_id = s.template_id
             WHERE s.tenant_id = %s AND s.report_schedule_id = %s
            """,
            (tenant_id, schedule_id),
        )
        record = await row.fetchone()
        if record is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        return _parse_subscribers(record[0])


@router.post("/schedules/{schedule_id}/subscribers", status_code=status.HTTP_201_CREATED)
async def add_subscriber(request: Request, schedule_id: str, body: AddSubscriber) -> dict:
    """Add an email address to the subscriber list of the given schedule."""
    tenant_id = await _require_operator(request)
    email = body.email.strip().lower()
    if not _valid_email(email):
        raise HTTPException(status_code=422, detail="invalid email address")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            """
            SELECT s.template_id, t.delivery_email
              FROM g1.report_schedule s
              JOIN g1.report_template t ON t.template_id = s.template_id
             WHERE s.tenant_id = %s AND s.report_schedule_id = %s
            """,
            (tenant_id, schedule_id),
        )
        record = await row.fetchone()
        if record is None:
            raise HTTPException(status_code=404, detail="schedule not found")

        template_id, delivery_email = record
        subscribers = _parse_subscribers(delivery_email)
        if email in subscribers:
            raise HTTPException(status_code=409, detail="email already subscribed")
        subscribers.append(email)
        await conn.execute(
            "UPDATE g1.report_template SET delivery_email=%s, updated_at=now() "
            "WHERE template_id=%s",
            (",".join(subscribers), template_id),
        )
        await conn.commit()
    return {"email": email, "subscribed": True}


@router.delete(
    "/schedules/{schedule_id}/subscribers/{email:path}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def remove_subscriber(request: Request, schedule_id: str, email: str) -> Response:
    """Remove an email address from the subscriber list of the given schedule."""
    tenant_id = await _require_operator(request)
    email = email.strip().lower()

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            """
            SELECT s.template_id, t.delivery_email
              FROM g1.report_schedule s
              JOIN g1.report_template t ON t.template_id = s.template_id
             WHERE s.tenant_id = %s AND s.report_schedule_id = %s
            """,
            (tenant_id, schedule_id),
        )
        record = await row.fetchone()
        if record is None:
            raise HTTPException(status_code=404, detail="schedule not found")

        template_id, delivery_email = record
        subscribers = _parse_subscribers(delivery_email)
        if email not in subscribers:
            raise HTTPException(status_code=404, detail="email not subscribed")
        if len(subscribers) <= 1:
            raise HTTPException(
                status_code=422,
                detail="cannot remove the last subscriber; delete the template instead",
            )
        subscribers.remove(email)
        await conn.execute(
            "UPDATE g1.report_template SET delivery_email=%s, updated_at=now() "
            "WHERE template_id=%s",
            (",".join(subscribers), template_id),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Delivery history ───────────────────────────────────────────────────────────

@router.get("/deliveries")
async def list_deliveries(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT delivery_id, template_id, report_type, recipient,
                   outcome, error_detail, period_start, period_end,
                   row_count, delivered_at, created_at
              FROM g1.report_delivery
             WHERE tenant_id = %s
             ORDER BY created_at DESC
             LIMIT 100
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]
