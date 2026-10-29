import base64
import hmac
import io
import json
import secrets
import struct
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.keycloak_admin import _REALM_BASE, _admin_token
from shared.config import settings

router = APIRouter(prefix="/api/v1/account", tags=["account-security"])


def _ctx(request: Request) -> dict:
    ctx = getattr(request.state, "jlmirror_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Unauthenticated")
    return ctx


# ── Sessions ──────────────────────────────────────────────────────────────────

@router.get("/sessions")
async def list_sessions(request: Request) -> dict:
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_REALM_BASE}/users/{principal_id}/sessions",
            headers=headers,
            timeout=10,
        )

    if r.status_code == 404:
        return {"sessions": []}
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail="Keycloak error")

    raw = r.json()
    sessions = [
        {
            "id": s.get("id"),
            "ipAddress": s.get("ipAddress"),
            "start": s.get("start"),
            "lastAccess": s.get("lastAccess"),
            "clients": list((s.get("clients") or {}).values()),
        }
        for s in raw
    ]
    # sort newest first
    sessions.sort(key=lambda s: s.get("lastAccess") or 0, reverse=True)
    if sessions:
        sessions[0]["current"] = True
    return {"sessions": sessions}


class RevokeSessionBody(BaseModel):
    session_id: str


@router.delete("/sessions/{session_id}")
async def revoke_session(session_id: str, request: Request) -> dict:
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    # Verify the session belongs to this user
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_REALM_BASE}/users/{principal_id}/sessions",
            headers=headers,
            timeout=10,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail="Keycloak error")
        user_sessions = r.json()
        owned = any(s.get("id") == session_id for s in user_sessions)
        if not owned:
            raise HTTPException(status_code=404, detail="Session not found")

        dr = await client.delete(
            f"{_REALM_BASE}/sessions/{session_id}",
            headers=headers,
            timeout=10,
        )

    if dr.status_code >= 400:
        raise HTTPException(status_code=502, detail="Failed to revoke session")
    return {"ok": True}


# ── MFA / TOTP ────────────────────────────────────────────────────────────────

def _totp_secret() -> str:
    raw = secrets.token_bytes(20)
    return base64.b32encode(raw).decode().rstrip("=")


def _hotp(secret_b32: str, counter: int) -> str:
    padding = (8 - len(secret_b32) % 8) % 8
    key = base64.b32decode(secret_b32 + "=" * padding, casefold=True)
    msg = struct.pack(">Q", counter)
    h = hmac.new(key, msg, "sha1").digest()
    offset = h[-1] & 0x0F
    code = struct.unpack(">I", h[offset : offset + 4])[0] & 0x7FFFFFFF
    return str(code % 1_000_000).zfill(6)


def _totp(secret_b32: str, t: int | None = None) -> str:
    counter = int((t or time.time()) // 30)
    return _hotp(secret_b32, counter)


@router.get("/mfa/status")
async def mfa_status(request: Request) -> dict:
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_REALM_BASE}/users/{principal_id}",
            headers=headers,
            timeout=10,
        )

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail="Keycloak error")

    user = r.json()
    credentials = user.get("credentials") or []
    totp_enabled = any(c.get("type") == "otp" for c in credentials)
    return {"totp_enabled": totp_enabled}


@router.post("/mfa/setup")
async def mfa_setup_begin(request: Request) -> dict:
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    # Fetch user email for the otpauth URI
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_REALM_BASE}/users/{principal_id}",
            headers=headers,
            timeout=10,
        )
    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail="Keycloak error")
    user = r.json()
    email = user.get("email") or principal_id

    secret = _totp_secret()
    # Store secret temporarily; in production use a short-lived cache/vault entry.
    # We return it to the frontend for confirmation step.
    uri = f"otpauth://totp/JLMirror:{email}?secret={secret}&issuer=JLMirror&algorithm=SHA1&digits=6&period=30"
    return {"secret": secret, "uri": uri, "email": email}


class MFAVerifyBody(BaseModel):
    secret: str
    code: str


@router.post("/mfa/verify")
async def mfa_verify_and_enable(body: MFAVerifyBody, request: Request) -> dict:
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    t = int(time.time())
    valid = any(
        _totp(body.secret, t - delta) == body.code.strip()
        for delta in (-30, 0, 30)
    )
    if not valid:
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # Register OTP credential in Keycloak
    payload = {
        "type": "otp",
        "value": body.secret,
        "temporary": False,
        "userLabel": "JLMirror Authenticator",
    }
    async with httpx.AsyncClient() as client:
        r = await client.put(
            f"{_REALM_BASE}/users/{principal_id}/reset-password",
            headers=headers,
            json=payload,
            timeout=10,
        )

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail="Failed to enable MFA in Keycloak")
    return {"ok": True}


@router.delete("/mfa")
async def mfa_disable(request: Request) -> dict:
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    # List credentials, find OTP, remove it
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_REALM_BASE}/users/{principal_id}/credentials",
            headers=headers,
            timeout=10,
        )
        if r.status_code >= 400:
            raise HTTPException(status_code=502, detail="Keycloak error")

        creds: list[dict[str, Any]] = r.json()
        otp_ids = [c["id"] for c in creds if c.get("type") == "otp"]

        if not otp_ids:
            return {"ok": True, "was_enabled": False}

        for cred_id in otp_ids:
            dr = await client.delete(
                f"{_REALM_BASE}/users/{principal_id}/credentials/{cred_id}",
                headers=headers,
                timeout=10,
            )
            if dr.status_code >= 400:
                raise HTTPException(status_code=502, detail="Failed to remove OTP credential")

    return {"ok": True, "was_enabled": True}


# ── LGPD ──────────────────────────────────────────────────────────────────────

@router.post("/lgpd/export")
async def lgpd_export(request: Request) -> dict:
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]
    tenant_id = ctx["tenant_id"]

    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_REALM_BASE}/users/{principal_id}",
            headers=headers,
            timeout=10,
        )

    user: dict[str, Any] = r.json() if r.status_code < 400 else {}

    export = {
        "principal_id": principal_id,
        "tenant_id": tenant_id,
        "username": user.get("username"),
        "email": user.get("email"),
        "firstName": user.get("firstName"),
        "lastName": user.get("lastName"),
        "createdTimestamp": user.get("createdTimestamp"),
        "enabled": user.get("enabled"),
        "exported_at": int(time.time() * 1000),
        "note": "Este arquivo contém todos os dados pessoais associados à sua conta conforme a LGPD (Lei nº 13.709/2018).",
    }
    return {"data": export}


class LGPDDeletionBody(BaseModel):
    confirm: bool


@router.post("/lgpd/deletion-request")
async def lgpd_request_deletion(body: LGPDDeletionBody, request: Request) -> dict:
    from shared.db import db_connection  # noqa: PLC0415

    if not body.confirm:
        raise HTTPException(status_code=400, detail="Confirmation required")

    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    async with db_connection() as conn:
        existing = await conn.execute(
            "SELECT request_id, status FROM g1.lgpd_deletion_requests "
            "WHERE principal_id = %s AND status IN ('pending', 'processing') "
            "LIMIT 1",
            (principal_id,),
        )
        row_ex = await existing.fetchone()
        if row_ex:
            return {
                "ok": True,
                "request_id": str(row_ex[0]),
                "status": row_ex[1],
                "already_exists": True,
            }

        ins = await conn.execute(
            "INSERT INTO g1.lgpd_deletion_requests (principal_id) VALUES (%s) "
            "RETURNING request_id, requested_at, status",
            (principal_id,),
        )
        row = await ins.fetchone()

    return {
        "ok": True,
        "request_id": str(row[0]),
        "requested_at": row[1].isoformat(),
        "status": row[2],
    }
