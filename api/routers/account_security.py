import base64
import hashlib
import hmac
import json
import secrets
import struct
import time
from typing import Any

import httpx
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.keycloak_admin import _REALM_BASE, _admin_token

router = APIRouter(prefix="/api/v1/account", tags=["account-security"])

# In-memory TOTP setup state: principal_id → (secret, expires_at)
# Single-instance safe for pilot; replace with Redis/Vault for multi-instance.
_MFA_PENDING: dict[str, tuple[str, float]] = {}
_MFA_SETUP_TTL = 300  # 5 minutes


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
            f"{_REALM_BASE}/users/{principal_id}/credentials",
            headers=headers,
            timeout=10,
        )

    if r.status_code >= 400:
        raise HTTPException(status_code=502, detail="Keycloak error")

    credentials = r.json() if r.status_code < 400 else []
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
    _MFA_PENDING[principal_id] = (secret, time.time() + _MFA_SETUP_TTL)
    uri = f"otpauth://totp/JLMirror:{email}?secret={secret}&issuer=JLMirror&algorithm=SHA1&digits=6&period=30"
    return {"uri": uri, "email": email}


class MFAVerifyBody(BaseModel):
    code: str


@router.post("/mfa/verify")
async def mfa_verify_and_enable(body: MFAVerifyBody, request: Request) -> dict:
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    entry = _MFA_PENDING.get(principal_id)
    if not entry:
        raise HTTPException(status_code=400, detail="No MFA setup in progress")
    secret, expires_at = entry
    if time.time() > expires_at:
        _MFA_PENDING.pop(principal_id, None)
        raise HTTPException(status_code=400, detail="MFA setup expired — restart setup")

    t = int(time.time())
    code = body.code.strip()
    valid = any(
        hmac.compare_digest(_totp(secret, t - delta), code)
        for delta in (-30, 0, 30)
    )
    if not valid:
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    _MFA_PENDING.pop(principal_id, None)

    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}

    # Register OTP credential in Keycloak via credentials endpoint
    payload = {
        "type": "otp",
        "userLabel": "JLMirror Authenticator",
        "credentialData": json.dumps({
            "subType": "totp",
            "digits": 6,
            "counter": 0,
            "period": 30,
            "algorithm": "HmacSHA1",
        }),
        "secretData": json.dumps({
            "value": secret,
            "salt": "",
        }),
    }
    async with httpx.AsyncClient() as client:
        r = await client.post(
            f"{_REALM_BASE}/users/{principal_id}/credentials",
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


# ── MFA Recovery Codes ────────────────────────────────────────────────────────

_RECOVERY_CODE_COUNT = 8


def _hash_recovery_code(code: str) -> str:
    return hashlib.sha256(code.encode()).hexdigest()


def _gen_recovery_code() -> str:
    """Generate a readable recovery code: xxxxxxxx-xxxxxxxx (16 hex chars with dash)."""
    raw = secrets.token_hex(8)
    return f"{raw[:8]}-{raw[8:]}"


@router.post("/mfa/recovery-codes/generate")
async def generate_recovery_codes(request: Request) -> dict:
    """Generate 8 new MFA recovery codes. Previous codes are invalidated.
    Returns plaintext codes — these are shown only once.
    """
    from shared.db import db_connection  # noqa: PLC0415

    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    codes = [_gen_recovery_code() for _ in range(_RECOVERY_CODE_COUNT)]
    hashes = [_hash_recovery_code(c) for c in codes]

    async with db_connection() as conn:
        # Invalidate all previous codes for this principal
        await conn.execute(
            "DELETE FROM g1.mfa_recovery_codes WHERE principal_id = %s",
            (principal_id,),
        )
        for h in hashes:
            await conn.execute(
                "INSERT INTO g1.mfa_recovery_codes (principal_id, code_hash) VALUES (%s, %s)",
                (principal_id, h),
            )
        await conn.commit()

    return {"codes": codes, "count": len(codes)}


@router.get("/mfa/recovery-codes")
async def get_recovery_codes_status(request: Request) -> dict:
    """Return number of unused MFA recovery codes (never plaintext)."""
    from shared.db import db_connection  # noqa: PLC0415

    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT COUNT(*) FROM g1.mfa_recovery_codes WHERE principal_id = %s AND used_at IS NULL",
            (principal_id,),
        )
        row = await cur.fetchone()

    return {"remaining": row[0] if row else 0}


# ── Avatar ────────────────────────────────────────────────────────────────────

@router.get("/avatar")
async def get_avatar(request: Request) -> dict:
    from shared.db import db_connection  # noqa: PLC0415

    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT avatar_data, avatar_content_type FROM g1.principals WHERE id = %s",
            (principal_id,),
        )
        row = await cur.fetchone()

    if not row or not row[0]:
        return {"data_url": None}

    return {"data_url": f"data:{row[1]};base64,{row[0]}"}


class AvatarBody(BaseModel):
    data: str          # base64-encoded image bytes
    content_type: str  # e.g. "image/jpeg" or "image/png"


@router.post("/avatar")
async def set_avatar(body: AvatarBody, request: Request) -> dict:
    from shared.db import db_connection  # noqa: PLC0415

    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    allowed_types = {"image/jpeg", "image/png", "image/webp", "image/gif"}
    if body.content_type not in allowed_types:
        raise HTTPException(status_code=400, detail="Unsupported image type")

    # ~150 KB base64 limit (150 * 1024 * 4/3 ≈ 204800 base64 chars)
    if len(body.data) > 204_800:
        raise HTTPException(status_code=400, detail="Image too large (max 150 KB)")

    # Validate it's actually base64
    try:
        base64.b64decode(body.data, validate=True)
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid base64 data")

    async with db_connection() as conn:
        await conn.execute(
            "UPDATE g1.principals SET avatar_data = %s, avatar_content_type = %s WHERE id = %s",
            (body.data, body.content_type, principal_id),
        )
        await conn.commit()

    return {"ok": True}


@router.delete("/avatar")
async def delete_avatar(request: Request) -> dict:
    from shared.db import db_connection  # noqa: PLC0415

    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    async with db_connection() as conn:
        await conn.execute(
            "UPDATE g1.principals SET avatar_data = NULL, avatar_content_type = NULL WHERE id = %s",
            (principal_id,),
        )
        await conn.commit()

    return {"ok": True}


# Public router — no authentication middleware, registered separately in main.py
_public_mfa_router = APIRouter(tags=["mfa-public"])


class MFARecoverBody(BaseModel):
    email: str
    recovery_code: str


@_public_mfa_router.post("/api/mfa/recover")
async def mfa_recover_account(body: MFARecoverBody) -> dict:
    """Use a recovery code to remove MFA from an account.

    Allows a user who lost their TOTP device to regain access.
    The user must provide their email and a valid, unused recovery code.
    After this call succeeds they can log in without TOTP and re-enroll.
    """
    from shared.audit import record_audit_event  # noqa: PLC0415
    from shared.db import db_connection  # noqa: PLC0415

    email = body.email.strip().lower()
    code = body.recovery_code.strip()
    code_hash = _hash_recovery_code(code)

    # 1. Look up principal_id in Keycloak by email
    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}"}
    async with httpx.AsyncClient() as client:
        r = await client.get(
            f"{_REALM_BASE}/users",
            headers=headers,
            params={"email": email, "exact": "true"},
            timeout=10,
        )
    if r.status_code >= 400 or not r.json():
        raise HTTPException(status_code=400, detail="Invalid email or recovery code")
    users = r.json()
    if not users:
        raise HTTPException(status_code=400, detail="Invalid email or recovery code")
    principal_id = users[0]["id"]

    # 2. Validate the recovery code
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT code_id FROM g1.mfa_recovery_codes "
            "WHERE principal_id = %s AND code_hash = %s AND used_at IS NULL "
            "LIMIT 1",
            (principal_id, code_hash),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=400, detail="Invalid email or recovery code")
        code_id = row[0]

        # 3. Mark code as used (before removing MFA to avoid partial state)
        await conn.execute(
            "UPDATE g1.mfa_recovery_codes SET used_at = now() WHERE code_id = %s",
            (code_id,),
        )

        # 4. Remove OTP credential from Keycloak
        async with httpx.AsyncClient() as client:
            creds_r = await client.get(
                f"{_REALM_BASE}/users/{principal_id}/credentials",
                headers=headers,
                timeout=10,
            )
        if creds_r.status_code < 400:
            otp_ids = [c["id"] for c in creds_r.json() if c.get("type") == "otp"]
            async with httpx.AsyncClient() as client:
                for cred_id in otp_ids:
                    await client.delete(
                        f"{_REALM_BASE}/users/{principal_id}/credentials/{cred_id}",
                        headers=headers,
                        timeout=10,
                    )

        # 5. Audit event (best-effort — no tenant context available here)
        try:
            await record_audit_event(
                conn, None,
                action="mfa.recovery_code.used",
                actor_kind="principal",
                actor_id=principal_id,
                subject_type="principal",
                subject_id=principal_id,
                detail={"email": email, "code_id": str(code_id)},
            )
        except Exception:  # noqa: BLE001
            pass

        await conn.commit()

    return {"ok": True, "message": "MFA removed. You can now log in without TOTP and re-enroll a new device."}
