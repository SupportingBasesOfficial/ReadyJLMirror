"""G27 API Key management endpoints.

Operators create/list/revoke API keys for their tenant. Keys provide
programmatic read access to the API via Authorization: Bearer header.
The raw key is returned once on creation and never stored.
"""

from __future__ import annotations

import base64
import hashlib
import os
import secrets

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/api-keys", tags=["api-keys"])

_APP_ROLE = "jlmirror_g27_apikey_app_invoker"
_VALID_SCOPES = frozenset(["read", "monitoring:read", "alerting:read"])


def _tenant_ctx(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None or not ctx.get("tenant_id"):
        raise HTTPException(status_code=403, detail="no tenant authority")
    return ctx["tenant_id"], ctx["principal_id"]


def _generate_raw_key() -> str:
    return "jlm_" + base64.urlsafe_b64encode(os.urandom(32)).rstrip(b"=").decode()


def _digest(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()


class ApiKeyCreate(BaseModel):
    label: str
    scopes: list[str] = ["read"]


@router.get("")
async def list_api_keys(request: Request) -> list[dict]:
    tenant, _ = _tenant_ctx(request)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT key_id, label, scopes, state,
                   created_at, expires_at, last_used_at
              FROM g1.api_keys
             WHERE tenant_id = %s
             ORDER BY created_at DESC
            """,
            (tenant,),
        )
        rows = await cur.fetchall()
    return [
        {
            "key_id": r[0],
            "label": r[1],
            "scopes": r[2],
            "state": r[3],
            "created_at": r[4].isoformat(),
            "expires_at": r[5].isoformat() if r[5] else None,
            "last_used_at": r[6].isoformat() if r[6] else None,
        }
        for r in rows
    ]


@router.post("", status_code=status.HTTP_201_CREATED)
async def create_api_key(request: Request, body: ApiKeyCreate) -> dict:
    tenant, principal = _tenant_ctx(request)
    invalid = [s for s in body.scopes if s not in _VALID_SCOPES]
    if invalid:
        raise HTTPException(status_code=422,
                            detail=f"unknown scopes: {invalid}")
    if not body.label.strip():
        raise HTTPException(status_code=422, detail="label must not be empty")

    raw = _generate_raw_key()
    digest = _digest(raw)

    async with db_tenant_connection(tenant) as conn:
        await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
        try:
            cur = await conn.execute(
                "SELECT g1.g27_create_api_key(%s,%s,%s,%s,%s,NULL)",
                (tenant, principal, digest, body.label.strip(), body.scopes),
            )
            key_id = (await cur.fetchone())[0]
        except Exception:
            raise HTTPException(status_code=500, detail="key creation failed")
        await conn.commit()

    return {
        "key_id": key_id,
        "label": body.label.strip(),
        "scopes": body.scopes,
        "state": "active",
        "raw_key": raw,
        "warning": "Store this key securely — it will not be shown again.",
    }


@router.delete("/{key_id}", status_code=status.HTTP_200_OK)
async def revoke_api_key(request: Request, key_id: str) -> dict:
    tenant, _ = _tenant_ctx(request)
    async with db_tenant_connection(tenant) as conn:
        await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
        cur = await conn.execute(
            "SELECT g1.g27_revoke_api_key(%s, %s)",
            (tenant, key_id),
        )
        found = (await cur.fetchone())[0]
        await conn.commit()
    if not found:
        raise HTTPException(status_code=404,
                            detail="key not found or already revoked")
    return {"key_id": key_id, "state": "revoked"}
