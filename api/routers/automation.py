"""G32 Automation Runtime API."""

from __future__ import annotations

import json
import secrets
import uuid
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import Response
from pydantic import BaseModel

from shared import access
from shared.db import db_connection, db_tenant_connection
from shared.ssh_crypto import encrypt_key
from shared.ssrf import validate_outbound_url

router = APIRouter(prefix="/api/v1/automation", tags=["automation"])

_VALID_TYPES = {"webhook", "noop", "ssh_command"}
_SSH_DEFAULT_PORT = 22


def _validate_ssh_config(config: dict) -> None:
    """Raise HTTPException if ssh_command config is invalid."""
    host = config.get("host", "").strip()
    if not host:
        raise HTTPException(status_code=422, detail="ssh_command config.host is required")
    # Re-use SSRF guard by constructing a dummy URL for the host
    dummy_url = f"https://{host}/"
    err = validate_outbound_url(dummy_url)
    if err:
        raise HTTPException(status_code=422, detail=f"ssh_command config.host: {err}")
    port = config.get("port", _SSH_DEFAULT_PORT)
    if not isinstance(port, int) or port < 1 or port > 65535:
        raise HTTPException(status_code=422, detail="ssh_command config.port must be 1-65535")
    if not config.get("credential_id", "").strip():
        raise HTTPException(status_code=422, detail="ssh_command config.credential_id required")
    if not config.get("command", "").strip():
        raise HTTPException(status_code=422, detail="ssh_command config.command required")


class CreateScript(BaseModel):
    name: str
    description: str = ""
    script_type: str = "noop"
    config: dict = {}


class UpdateScript(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    script_type: Optional[str] = None
    config: Optional[dict] = None
    enabled: Optional[bool] = None
    approval_required: Optional[bool] = None
    change_note: Optional[str] = None


class RejectBody(BaseModel):
    reason: str = ""


class CreateSchedule(BaseModel):
    script_id: str
    interval_secs: int


def _require_tenant(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tid = ctx.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


async def _require_operator(request: Request) -> str:
    """Require monitoring:operate or tenant:admin — write operations on automation."""
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


async def _require_admin(request: Request) -> str:
    """Require tenant:admin — approve/reject operations."""
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tenant_id = ctx.get("tenant_id")
    principal_id = ctx.get("principal_id")
    if not tenant_id or not principal_id:
        raise HTTPException(status_code=403, detail="tenant context required")
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="tenant:admin permission required")
    return tenant_id


# ── Scripts ───────────────────────────────────────────────────────────────────

@router.get("/scripts")
async def list_scripts(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT script_id, name, description, script_type, enabled,
                   approval_required, approval_status,
                   created_at, updated_at
              FROM g1.automation_script
             WHERE tenant_id = %s
             ORDER BY created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/scripts", status_code=status.HTTP_201_CREATED)
async def create_script(request: Request, body: CreateScript) -> dict:
    tenant_id = await _require_operator(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if len(name) > 120:
        raise HTTPException(status_code=422, detail="name max 120 chars")
    if body.script_type not in _VALID_TYPES:
        raise HTTPException(status_code=422,
                            detail=f"script_type must be one of {sorted(_VALID_TYPES)}")
    if body.script_type == "webhook":
        url = body.config.get("url", "").strip()
        err = validate_outbound_url(url)
        if err:
            raise HTTPException(status_code=422, detail=f"webhook config.url: {err}")
    elif body.script_type == "ssh_command":
        _validate_ssh_config(body.config)

    principal_id = (getattr(request.state, "jlmirror_context", None) or {}).get("principal_id")
    script_id = f"auto:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            """
            INSERT INTO g1.automation_script
                (script_id, tenant_id, name, description, script_type, config)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (script_id, tenant_id, name, body.description,
             body.script_type, json.dumps(body.config)),
        )
        await conn.execute(
            """
            INSERT INTO g1.automation_script_version
                (script_id, tenant_id, version_number, name, script_type,
                 config, description, created_by)
            VALUES (%s, %s, 1, %s, %s, %s, %s, %s)
            """,
            (script_id, tenant_id, name, body.script_type,
             json.dumps(body.config), body.description, principal_id),
        )
        await conn.commit()
    return {"script_id": script_id, "name": name, "script_type": body.script_type}


@router.put("/scripts/{script_id}")
async def update_script(request: Request, script_id: str,
                        body: UpdateScript) -> dict:
    tenant_id = await _require_operator(request)
    principal_id = (getattr(request.state, "jlmirror_context", None) or {}).get("principal_id")

    if body.script_type and body.script_type not in _VALID_TYPES:
        raise HTTPException(status_code=422,
                            detail=f"script_type must be one of {sorted(_VALID_TYPES)}")
    if body.config is not None:
        effective_type = body.script_type or "webhook"
        if effective_type == "webhook":
            url = body.config.get("url", "").strip() if body.config.get("url") else ""
            if url:
                err = validate_outbound_url(url)
                if err:
                    raise HTTPException(status_code=422, detail=f"webhook config.url: {err}")
        elif effective_type == "ssh_command":
            _validate_ssh_config(body.config)

    content_changing = any(
        getattr(body, f) is not None
        for f in ("name", "description", "script_type", "config")
    )

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT name, description, script_type, config,
                   approval_required, approval_status
              FROM g1.automation_script
             WHERE tenant_id=%s AND script_id=%s
            """,
            (tenant_id, script_id),
        )
        existing = await cur.fetchone()
        if existing is None:
            raise HTTPException(status_code=404, detail="script not found")

        sets, vals = [], []

        if content_changing:
            ver_cur = await conn.execute(
                "SELECT COALESCE(MAX(version_number), 0) "
                "FROM g1.automation_script_version WHERE script_id=%s",
                (script_id,),
            )
            ver_row = await ver_cur.fetchone()
            await conn.execute(
                """
                INSERT INTO g1.automation_script_version
                    (script_id, tenant_id, version_number, name, script_type,
                     config, description, change_note, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (script_id, tenant_id, ver_row[0] + 1,
                 existing[0], existing[2], json.dumps(existing[3]),
                 existing[1] or "", body.change_note, principal_id),
            )
            approval_req = body.approval_required if body.approval_required is not None else existing[4]
            if approval_req:
                sets += ["approval_status = 'draft'", "approved_by = NULL",
                         "approved_at = NULL", "rejection_reason = NULL"]

        for field in ("name", "description", "script_type", "enabled"):
            v = getattr(body, field)
            if v is not None:
                sets.append(f"{field} = %s")
                vals.append(v)
        if body.config is not None:
            sets.append("config = %s")
            vals.append(json.dumps(body.config))
        if body.approval_required is not None:
            sets.append("approval_required = %s")
            vals.append(body.approval_required)

        if not sets:
            return {"script_id": script_id, "updated": False}
        sets.append("updated_at = now()")
        vals.extend([tenant_id, script_id])
        await conn.execute(
            f"UPDATE g1.automation_script SET {', '.join(sets)} "
            f"WHERE tenant_id=%s AND script_id=%s",
            vals,
        )
        await conn.commit()
    return {"script_id": script_id, "updated": True}


# ── Manual trigger ─────────────────────────────────────────────────────────────

@router.post("/scripts/{script_id}/trigger", status_code=status.HTTP_202_ACCEPTED)
async def trigger_script(request: Request, script_id: str) -> dict:
    """Queue a manual run. Actual execution is on the next worker tick."""
    tenant_id = await _require_operator(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT script_id, enabled, approval_required, approval_status "
            "FROM g1.automation_script "
            "WHERE tenant_id=%s AND script_id=%s",
            (tenant_id, script_id),
        )
        r = await row.fetchone()
        if r is None:
            raise HTTPException(status_code=404, detail="script not found")
        if not r[1]:
            raise HTTPException(status_code=409, detail="script is disabled")
        if r[2] and r[3] != "approved":
            raise HTTPException(status_code=409,
                                detail="script requires approval before execution")

        run_id = f"arun:{secrets.token_urlsafe(16)}"
        now = datetime.now(timezone.utc)
        await conn.execute(
            """
            INSERT INTO g1.automation_run
                (run_id, tenant_id, script_id, trigger_type, outcome, started_at)
            VALUES (%s, %s, %s, 'manual', 'pending', %s)
            """,
            (run_id, tenant_id, script_id, now),
        )
        await conn.commit()
    return {"run_id": run_id, "queued": True}


@router.post("/runs/{run_id}/cancel", status_code=200)
async def cancel_run(request: Request, run_id: str) -> dict:
    """Cancel a pending run before the worker picks it up.

    Only runs with outcome='pending' can be cancelled; a run already
    executing cannot be interrupted (SSH is synchronous in the worker).
    Returns 409 when the run is not in a cancellable state.
    """
    tenant_id = await _require_operator(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "UPDATE g1.automation_run SET outcome='cancelled', finished_at=now() "
            "WHERE run_id=%s AND tenant_id=%s AND outcome='pending' "
            "RETURNING run_id",
            (run_id, tenant_id),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(
                status_code=409,
                detail="run not found or already past pending state",
            )
        await conn.commit()
    return {"run_id": run_id, "cancelled": True}


# ── Approval flow ─────────────────────────────────────────────────────────────

@router.post("/scripts/{script_id}/submit", status_code=200)
async def submit_script(request: Request, script_id: str) -> dict:
    """Submit for approval (draft/rejected → pending_approval)."""
    tenant_id = await _require_operator(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "UPDATE g1.automation_script "
            "SET approval_status='pending_approval', updated_at=now() "
            "WHERE tenant_id=%s AND script_id=%s "
            "  AND approval_required=true "
            "  AND approval_status IN ('draft', 'rejected') "
            "RETURNING script_id",
            (tenant_id, script_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=409,
                                detail="script not found, approval not required, or not in draft/rejected state")
        await conn.commit()
    return {"script_id": script_id, "approval_status": "pending_approval"}


@router.post("/scripts/{script_id}/approve", status_code=200)
async def approve_script(request: Request, script_id: str) -> dict:
    """Approve a pending script. Requires tenant:admin."""
    tenant_id = await _require_admin(request)
    principal_id = (getattr(request.state, "jlmirror_context", None) or {}).get("principal_id")
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "UPDATE g1.automation_script "
            "SET approval_status='approved', approved_by=%s, approved_at=now(), "
            "    rejection_reason=NULL, updated_at=now() "
            "WHERE tenant_id=%s AND script_id=%s "
            "  AND approval_required=true AND approval_status='pending_approval' "
            "RETURNING script_id",
            (principal_id, tenant_id, script_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=409,
                                detail="script not found, approval not required, or not pending")
        await conn.commit()
    return {"script_id": script_id, "approval_status": "approved"}


@router.post("/scripts/{script_id}/reject", status_code=200)
async def reject_script(request: Request, script_id: str, body: RejectBody) -> dict:
    """Reject a pending script. Requires tenant:admin."""
    tenant_id = await _require_admin(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "UPDATE g1.automation_script "
            "SET approval_status='rejected', rejection_reason=%s, "
            "    approved_by=NULL, approved_at=NULL, updated_at=now() "
            "WHERE tenant_id=%s AND script_id=%s "
            "  AND approval_required=true AND approval_status='pending_approval' "
            "RETURNING script_id",
            (body.reason or None, tenant_id, script_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=409,
                                detail="script not found, approval not required, or not pending")
        await conn.commit()
    return {"script_id": script_id, "approval_status": "rejected"}


@router.get("/scripts/{script_id}/versions")
async def list_versions(request: Request, script_id: str) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        chk = await conn.execute(
            "SELECT script_id FROM g1.automation_script "
            "WHERE tenant_id=%s AND script_id=%s",
            (tenant_id, script_id),
        )
        if await chk.fetchone() is None:
            raise HTTPException(status_code=404, detail="script not found")
        rows = await conn.execute(
            """
            SELECT id, version_number, name, script_type, description,
                   change_note, created_by, created_at
              FROM g1.automation_script_version
             WHERE script_id = %s
             ORDER BY version_number DESC
            """,
            (script_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


# ── Schedules ─────────────────────────────────────────────────────────────────

@router.get("/schedules")
async def list_schedules(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT sc.schedule_id, sc.script_id, s.name AS script_name,
                   sc.interval_secs, sc.last_run_at, sc.next_run_at,
                   sc.enabled, sc.created_at
              FROM g1.automation_schedule sc
              JOIN g1.automation_script s ON s.script_id = sc.script_id
             WHERE sc.tenant_id = %s
             ORDER BY sc.created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/schedules", status_code=status.HTTP_201_CREATED)
async def create_schedule(request: Request, body: CreateSchedule) -> dict:
    tenant_id = await _require_operator(request)
    if body.interval_secs < 60:
        raise HTTPException(status_code=422,
                            detail="interval_secs must be at least 60")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT script_id FROM g1.automation_script "
            "WHERE tenant_id=%s AND script_id=%s AND enabled=true",
            (tenant_id, body.script_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404,
                                detail="script not found or disabled")

        schedule_id = f"asched:{uuid.uuid4()}"
        await conn.execute(
            """
            INSERT INTO g1.automation_schedule
                (schedule_id, tenant_id, script_id, interval_secs)
            VALUES (%s, %s, %s, %s)
            """,
            (schedule_id, tenant_id, body.script_id, body.interval_secs),
        )
        await conn.commit()
    return {"schedule_id": schedule_id, "script_id": body.script_id}


@router.delete("/schedules/{schedule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_schedule(request: Request, schedule_id: str) -> Response:
    tenant_id = await _require_operator(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT schedule_id FROM g1.automation_schedule "
            "WHERE tenant_id=%s AND schedule_id=%s",
            (tenant_id, schedule_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="schedule not found")
        await conn.execute(
            "UPDATE g1.automation_schedule SET enabled=false "
            "WHERE schedule_id=%s",
            (schedule_id,),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Run history ───────────────────────────────────────────────────────────────

@router.get("/runs")
async def list_runs(request: Request, script_id: Optional[str] = None) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        if script_id:
            rows = await conn.execute(
                """
                SELECT run_id, script_id, trigger_type, outcome,
                       http_status, error_detail, started_at, finished_at
                  FROM g1.automation_run
                 WHERE tenant_id=%s AND script_id=%s
                 ORDER BY created_at DESC LIMIT 100
                """,
                (tenant_id, script_id),
            )
        else:
            rows = await conn.execute(
                """
                SELECT run_id, script_id, trigger_type, outcome,
                       http_status, error_detail, started_at, finished_at
                  FROM g1.automation_run
                 WHERE tenant_id=%s
                 ORDER BY created_at DESC LIMIT 100
                """,
                (tenant_id,),
            )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


# ── SSH Credentials ───────────────────────────────────────────────────────────

class CreateCredential(BaseModel):
    label: str
    username: str
    key_pem: str
    known_hosts: Optional[str] = None


@router.get("/credentials")
async def list_credentials(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT credential_id, label, credential_type, username, created_at
              FROM g1.automation_credential
             WHERE tenant_id = %s
             ORDER BY created_at DESC
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/credentials", status_code=status.HTTP_201_CREATED)
async def create_credential(request: Request, body: CreateCredential) -> dict:
    tenant_id = await _require_operator(request)
    label = body.label.strip()
    if not label:
        raise HTTPException(status_code=422, detail="label is required")
    if len(label) > 120:
        raise HTTPException(status_code=422, detail="label max 120 chars")
    username = body.username.strip()
    if not username:
        raise HTTPException(status_code=422, detail="username is required")
    key_pem = body.key_pem.strip()
    if not key_pem.startswith("-----BEGIN"):
        raise HTTPException(status_code=422, detail="key_pem must be a PEM-encoded private key")

    stored_pem, was_encrypted = encrypt_key(key_pem)

    credential_id = f"cred:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        try:
            await conn.execute(
                """
                INSERT INTO g1.automation_credential
                    (credential_id, tenant_id, label, username, key_pem,
                     known_hosts, key_pem_encrypted)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (credential_id, tenant_id, label, username, stored_pem,
                 body.known_hosts, was_encrypted),
            )
            await conn.commit()
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(status_code=409,
                                    detail=f"credential with label '{label}' already exists")
            raise
    return {"credential_id": credential_id, "label": label, "username": username}


@router.delete("/credentials/{credential_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_credential(request: Request, credential_id: str) -> Response:
    tenant_id = await _require_operator(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT credential_id FROM g1.automation_credential "
            "WHERE tenant_id=%s AND credential_id=%s",
            (tenant_id, credential_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="credential not found")
        await conn.execute(
            "DELETE FROM g1.automation_credential WHERE credential_id=%s",
            (credential_id,),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
