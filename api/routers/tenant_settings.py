"""Tenant Settings — SMTP, notification preferences, timezone.

Branding (logo, colors) is managed separately via /api/v1/platform/branding.
Requires tenant:admin.
"""

from __future__ import annotations

import smtplib
import email.mime.text
from typing import Any

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/tenant-settings", tags=["tenant-settings"])

_DEFAULTS: dict[str, Any] = {
    "smtp_host": None,
    "smtp_port": 587,
    "smtp_user": None,
    "smtp_password": None,
    "smtp_from_name": None,
    "smtp_from_email": None,
    "smtp_tls": True,
    "notify_on_alert_critical": True,
    "notify_on_incident_open": True,
    "notify_on_sla_breach": True,
    "timezone": "America/Sao_Paulo",
    "date_format": "DD/MM/YYYY",
}


def _tenant_ctx(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None or not ctx.get("tenant_id"):
        raise HTTPException(status_code=403, detail="no tenant authority")
    role = ctx.get("role", "")
    if role not in ("admin", "platform_admin_principal"):
        raise HTTPException(status_code=403, detail="tenant:admin required")
    return ctx["tenant_id"], ctx.get("principal_id", "unknown")


def _mask(row: dict) -> dict:
    if row.get("smtp_password"):
        row["smtp_password"] = "••••••"
    return row


@router.get("")
async def get_settings(request: Request) -> dict:
    tenant, _ = _tenant_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM g1.tenant_settings WHERE tenant_id = %s",
            (tenant,),
        )
        row = await cur.fetchone()
    if row is None:
        return {**_DEFAULTS, "tenant_id": tenant}
    cols = [d[0] for d in cur.description]
    return _mask(dict(zip(cols, row)))


class SettingsUpdate(BaseModel):
    smtp_host: str | None = None
    smtp_port: int | None = None
    smtp_user: str | None = None
    smtp_password: str | None = None
    smtp_from_name: str | None = None
    smtp_from_email: str | None = None
    smtp_tls: bool | None = None
    notify_on_alert_critical: bool | None = None
    notify_on_incident_open: bool | None = None
    notify_on_sla_breach: bool | None = None
    timezone: str | None = None
    date_format: str | None = None


@router.put("")
async def update_settings(request: Request, body: SettingsUpdate) -> dict:
    tenant, actor = _tenant_ctx(request)
    data = body.model_dump(exclude_none=True)
    if not data:
        raise HTTPException(status_code=400, detail="no fields to update")

    set_clause = ", ".join(f"{k} = %s" for k in data)
    values = list(data.values()) + [actor, tenant]

    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            f"""
            INSERT INTO g1.tenant_settings (tenant_id, {", ".join(data)}, updated_by)
            VALUES (%s, {", ".join(["%s"] * len(data))}, %s)
            ON CONFLICT (tenant_id) DO UPDATE SET
              {set_clause},
              updated_at = NOW(),
              updated_by = %s
            """,
            [tenant] + list(data.values()) + [actor] + list(data.values()) + [actor],
        )
        await record_audit_event(conn, "platform",
            action="tenant.settings.updated",
            actor_kind="human_browser_session", actor_id=actor,
            subject_type="tenant_settings", subject_id=tenant,
            detail={"fields": list(data.keys())})
        await conn.commit()

    return await get_settings(request)


class SmtpTestBody(BaseModel):
    to_email: str


@router.post("/smtp/test")
async def test_smtp(request: Request, body: SmtpTestBody) -> dict:
    tenant, _ = _tenant_ctx(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT smtp_host, smtp_port, smtp_user, smtp_password, "
            "smtp_from_name, smtp_from_email, smtp_tls "
            "FROM g1.tenant_settings WHERE tenant_id = %s",
            (tenant,),
        )
        row = await cur.fetchone()

    if row is None or not row[0]:
        raise HTTPException(status_code=400, detail="SMTP not configured")

    host, port, user, password, from_name, from_email, use_tls = row
    try:
        msg = email.mime.text.MIMEText("Este é um email de teste do JLMirror.")
        msg["Subject"] = "Teste SMTP — JLMirror"
        msg["From"] = f"{from_name or 'JLMirror'} <{from_email}>"
        msg["To"] = body.to_email

        if use_tls:
            server = smtplib.SMTP_SSL(host, port, timeout=10)
        else:
            server = smtplib.SMTP(host, port, timeout=10)
            server.starttls()

        if user and password:
            server.login(user, password)
        server.sendmail(from_email, [body.to_email], msg.as_string())
        server.quit()
        return {"success": True}
    except Exception as exc:
        return {"success": False, "error": str(exc)}
