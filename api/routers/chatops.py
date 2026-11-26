import hashlib
import hmac
import json
import time
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request, Header
from pydantic import BaseModel

from shared.auth import _require_operate, _require_ctx
from shared.db import db_connection
from shared.audit import record_audit_event

router = APIRouter(prefix="/chatops", tags=["chatops"])

PLATFORMS = ["slack", "teams"]
ENTITY_TYPES = ["alert", "incident", "monitor", "device", "vulnerability", "deployment"]
EVENT_TYPES = ["created", "resolved", "acknowledged", "escalated", "updated", "closed"]


# ── Models ────────────────────────────────────────────────────────────────────

class WorkspaceCreate(BaseModel):
    name: str
    platform: str
    webhook_url: Optional[str] = None
    bot_token_ref: Optional[str] = None
    inbound_secret: Optional[str] = None


class BindingCreate(BaseModel):
    channel_id: str
    channel_name: Optional[str] = None
    entity_type: str
    event_types: list[str] = []


class SendMessage(BaseModel):
    workspace_id: str
    channel_id: str
    text: str
    entity_type: Optional[str] = None
    entity_id: Optional[str] = None
    event_type: Optional[str] = None


class InboundPayload(BaseModel):
    platform: str
    workspace_external_id: Optional[str] = None
    channel_id: Optional[str] = None
    sender_id: Optional[str] = None
    sender_name: Optional[str] = None
    command: str
    args: Optional[str] = None
    secret: Optional[str] = None


# ── Workspaces ────────────────────────────────────────────────────────────────

@router.get("/workspaces")
async def list_workspaces(request: Request):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT w.*,
                   COUNT(b.id)::int AS binding_count
            FROM g1.chatops_workspace w
            LEFT JOIN g1.chatops_channel_binding b ON b.workspace_id = w.id
            WHERE w.tenant_id = $1
            GROUP BY w.id
            ORDER BY w.name
            """,
            tid,
        )
    return [dict(r) for r in rows]


@router.post("/workspaces", status_code=201)
async def create_workspace(request: Request, body: WorkspaceCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    if body.platform not in PLATFORMS:
        raise HTTPException(400, f"platform inválida: {body.platform}")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO g1.chatops_workspace
                (tenant_id, name, platform, webhook_url, bot_token_ref, inbound_secret, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING *
            """,
            tid, body.name, body.platform,
            body.webhook_url, body.bot_token_ref, body.inbound_secret, actor,
        )
        await record_audit_event(conn, tid, actor, "chatops_workspace.create", row["id"],
                                 {"name": body.name, "platform": body.platform})
    return dict(row)


@router.get("/workspaces/{workspace_id}")
async def get_workspace(request: Request, workspace_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM g1.chatops_workspace WHERE id=$1 AND tenant_id=$2",
            workspace_id, tid,
        )
    if not row:
        raise HTTPException(404, "workspace não encontrado")
    return dict(row)


@router.put("/workspaces/{workspace_id}")
async def update_workspace(request: Request, workspace_id: UUID, body: WorkspaceCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    if body.platform not in PLATFORMS:
        raise HTTPException(400, f"platform inválida: {body.platform}")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.chatops_workspace SET
                name=$3, platform=$4, webhook_url=$5,
                bot_token_ref=COALESCE($6, bot_token_ref),
                inbound_secret=COALESCE($7, inbound_secret),
                updated_at=NOW()
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            workspace_id, tid, body.name, body.platform,
            body.webhook_url, body.bot_token_ref, body.inbound_secret,
        )
    if not row:
        raise HTTPException(404, "workspace não encontrado")
    return dict(row)


@router.delete("/workspaces/{workspace_id}", status_code=204)
async def delete_workspace(request: Request, workspace_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        result = await conn.execute(
            "DELETE FROM g1.chatops_workspace WHERE id=$1 AND tenant_id=$2",
            workspace_id, tid,
        )
    if result == "DELETE 0":
        raise HTTPException(404, "workspace não encontrado")


@router.post("/workspaces/{workspace_id}/ping")
async def ping_workspace(request: Request, workspace_id: UUID):
    """Testa o webhook_url enviando uma mensagem de teste."""
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        ws = await conn.fetchrow(
            "SELECT * FROM g1.chatops_workspace WHERE id=$1 AND tenant_id=$2",
            workspace_id, tid,
        )
        if not ws:
            raise HTTPException(404, "workspace não encontrado")
        if not ws["webhook_url"]:
            raise HTTPException(400, "webhook_url não configurada")

        # Attempt HTTP POST to webhook URL
        import httpx
        ping_ok = False
        ping_error: Optional[str] = None
        try:
            payload: dict = {}
            if ws["platform"] == "slack":
                payload = {"text": "🏓 Argos ping — integração ativa!"}
            else:
                payload = {"type": "message", "text": {"type": "plain_text", "content": "🏓 Argos ping — integração ativa!"}}
            async with httpx.AsyncClient(timeout=10) as client:
                resp = await client.post(ws["webhook_url"], json=payload)
                if resp.status_code < 300:
                    ping_ok = True
                else:
                    ping_error = f"HTTP {resp.status_code}: {resp.text[:200]}"
        except Exception as exc:
            ping_error = str(exc)[:300]

        new_status = "active" if ping_ok else "error"
        await conn.execute(
            """
            UPDATE g1.chatops_workspace
            SET status=$3, error_message=$4, last_ping_at=NOW(), updated_at=NOW()
            WHERE id=$1 AND tenant_id=$2
            """,
            workspace_id, tid, new_status, ping_error,
        )
        await record_audit_event(conn, tid, actor, "chatops_workspace.ping", workspace_id,
                                 {"ok": ping_ok, "error": ping_error})

    return {"ok": ping_ok, "error": ping_error}


# ── Channel bindings ──────────────────────────────────────────────────────────

@router.get("/workspaces/{workspace_id}/bindings")
async def list_bindings(request: Request, workspace_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT * FROM g1.chatops_channel_binding
            WHERE workspace_id=$1 AND tenant_id=$2
            ORDER BY entity_type, channel_name
            """,
            workspace_id, tid,
        )
    return [dict(r) for r in rows]


@router.post("/workspaces/{workspace_id}/bindings", status_code=201)
async def create_binding(request: Request, workspace_id: UUID, body: BindingCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    if body.entity_type not in ENTITY_TYPES:
        raise HTTPException(400, f"entity_type inválido: {body.entity_type}")
    async with db_connection() as conn:
        ws = await conn.fetchrow(
            "SELECT id FROM g1.chatops_workspace WHERE id=$1 AND tenant_id=$2",
            workspace_id, tid,
        )
        if not ws:
            raise HTTPException(404, "workspace não encontrado")
        try:
            row = await conn.fetchrow(
                """
                INSERT INTO g1.chatops_channel_binding
                    (tenant_id, workspace_id, channel_id, channel_name, entity_type, event_types)
                VALUES ($1,$2,$3,$4,$5,$6)
                RETURNING *
                """,
                tid, workspace_id, body.channel_id, body.channel_name,
                body.entity_type, body.event_types,
            )
        except Exception:
            raise HTTPException(409, "binding já existe para este canal e entity_type")
    return dict(row)


@router.delete("/workspaces/{workspace_id}/bindings/{binding_id}", status_code=204)
async def delete_binding(request: Request, workspace_id: UUID, binding_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        result = await conn.execute(
            "DELETE FROM g1.chatops_channel_binding WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3",
            binding_id, workspace_id, tid,
        )
    if result == "DELETE 0":
        raise HTTPException(404, "binding não encontrado")


# ── Outbound messages ─────────────────────────────────────────────────────────

@router.post("/send", status_code=201)
async def send_message(request: Request, body: SendMessage):
    """Registra e (futuramente) envia mensagem para canal via worker."""
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        ws = await conn.fetchrow(
            "SELECT * FROM g1.chatops_workspace WHERE id=$1 AND tenant_id=$2 AND status='active'",
            body.workspace_id, tid,
        )
        if not ws:
            raise HTTPException(404, "workspace ativo não encontrado")
        payload = {"text": body.text}
        row = await conn.fetchrow(
            """
            INSERT INTO g1.chatops_outbound_message
                (tenant_id, workspace_id, channel_id, entity_type, entity_id,
                 event_type, payload, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'pending')
            RETURNING *
            """,
            tid, ws["id"], body.channel_id, body.entity_type,
            body.entity_id, body.event_type, json.dumps(payload),
        )
    return dict(row)


@router.get("/messages")
async def list_messages(
    request: Request,
    status: Optional[str] = None,
    limit: int = 100,
):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    where = ["m.tenant_id=$1"]
    vals: list = [tid]
    n = 2
    if status:
        where.append(f"m.status=${n}")
        vals.append(status)
        n += 1
    vals.append(limit)
    async with db_connection() as conn:
        rows = await conn.fetch(
            f"""
            SELECT m.*, w.name AS workspace_name, w.platform
            FROM g1.chatops_outbound_message m
            LEFT JOIN g1.chatops_workspace w ON w.id = m.workspace_id
            WHERE {' AND '.join(where)}
            ORDER BY m.created_at DESC
            LIMIT ${n}
            """,
            *vals,
        )
    return [dict(r) for r in rows]


# ── Inbound webhook ───────────────────────────────────────────────────────────

@router.post("/inbound/{tenant_id_path}")
async def inbound_webhook(
    tenant_id_path: UUID,
    body: InboundPayload,
    x_argos_secret: Optional[str] = Header(None),
):
    """Recebe comandos de Slack/Teams. Validação por secret token no header ou no body."""
    secret = x_argos_secret or body.secret
    async with db_connection() as conn:
        ws = await conn.fetchrow(
            """
            SELECT * FROM g1.chatops_workspace
            WHERE tenant_id=$1 AND platform=$2 AND status='active'
            LIMIT 1
            """,
            tenant_id_path, body.platform,
        )
        if not ws:
            return {"ok": False, "error": "workspace não encontrado ou inativo"}
        if ws["inbound_secret"] and not hmac.compare_digest(
            ws["inbound_secret"] or "", secret or ""
        ):
            return {"ok": False, "error": "unauthorized"}

        response_text = _handle_command(body.command, body.args)
        status = "ok"

        await conn.fetchrow(
            """
            INSERT INTO g1.chatops_command_log
                (tenant_id, workspace_id, platform, channel_id, sender_id,
                 sender_name, command, args, response, status)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING id
            """,
            tenant_id_path, ws["id"], body.platform, body.channel_id,
            body.sender_id, body.sender_name, body.command, body.args,
            response_text, status,
        )
    return {"ok": True, "response": response_text}


def _handle_command(command: str, args: Optional[str]) -> str:
    cmd = command.strip().lower().lstrip("/")
    if cmd == "help":
        return (
            "Comandos disponíveis:\n"
            "• /argos help — esta ajuda\n"
            "• /argos status — status geral\n"
            "• /argos alerts — resumo de alertas ativos\n"
            "• /argos ping — verifica conectividade"
        )
    if cmd in ("status", "argos status"):
        return "✅ Argos online e operacional"
    if cmd in ("ping", "argos ping"):
        return "🏓 Pong!"
    if cmd in ("alerts", "argos alerts"):
        return "🔔 Consulte o painel de alertas em: /alertas"
    return f"Comando '{command}' não reconhecido. Use /argos help para ver os comandos disponíveis."


@router.get("/commands")
async def list_commands(request: Request, limit: int = 100):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT c.*, w.name AS workspace_name
            FROM g1.chatops_command_log c
            LEFT JOIN g1.chatops_workspace w ON w.id = c.workspace_id
            WHERE c.tenant_id = $1
            ORDER BY c.received_at DESC
            LIMIT $2
            """,
            tid, limit,
        )
    return [dict(r) for r in rows]


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def get_stats(request: Request):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                (SELECT COUNT(*) FROM g1.chatops_workspace WHERE tenant_id=$1) AS total_workspaces,
                (SELECT COUNT(*) FROM g1.chatops_workspace WHERE tenant_id=$1 AND status='active') AS active_workspaces,
                (SELECT COUNT(*) FROM g1.chatops_channel_binding WHERE tenant_id=$1) AS total_bindings,
                (SELECT COUNT(*) FROM g1.chatops_outbound_message WHERE tenant_id=$1 AND status='sent') AS messages_sent,
                (SELECT COUNT(*) FROM g1.chatops_outbound_message WHERE tenant_id=$1 AND status='failed') AS messages_failed,
                (SELECT COUNT(*) FROM g1.chatops_command_log WHERE tenant_id=$1) AS commands_received
            """,
            tid,
        )
    return dict(row)
