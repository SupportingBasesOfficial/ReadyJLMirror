"""Web Push notification router (RFC 8292 VAPID).

Stores browser subscriptions per principal and sends trigger-only
pushes (no encrypted payload). The service worker fetches
/api/v1/push/latest to show meaningful notification content.
"""
from __future__ import annotations

import base64
import logging
from datetime import datetime, timedelta, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx
import jwt
from cryptography.hazmat.primitives import serialization
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared.config import settings

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/v1/push", tags=["push"])


def _ctx(request: Request) -> dict:
    ctx = getattr(request.state, "jlmirror_context", None)
    if not ctx:
        raise HTTPException(status_code=401, detail="Unauthenticated")
    return ctx


def _b64d(s: str) -> bytes:
    padding = "=" * (4 - len(s) % 4)
    return base64.urlsafe_b64decode(s + padding)


def _vapid_jwt(endpoint: str) -> str:
    key_bytes = _b64d(settings.vapid_private_key)
    private_key = serialization.load_der_private_key(key_bytes, password=None)
    parsed = urlparse(endpoint)
    audience = f"{parsed.scheme}://{parsed.netloc}"
    return jwt.encode(
        {
            "aud": audience,
            "exp": int((datetime.now(timezone.utc) + timedelta(hours=12)).timestamp()),
            "sub": f"mailto:{settings.vapid_claims_email}",
        },
        private_key,
        algorithm="ES256",
    )


async def _send_push_trigger(endpoint: str) -> None:
    """POST a trigger-only push (no body) to a push service endpoint."""
    token = _vapid_jwt(endpoint)
    async with httpx.AsyncClient(follow_redirects=False, timeout=10.0) as client:
        resp = await client.post(
            endpoint,
            headers={
                "Authorization": f"vapid t={token},k={settings.vapid_public_key}",
                "TTL": "86400",
                "Urgency": "normal",
                "Content-Length": "0",
            },
            content=b"",
        )
    if resp.status_code not in (200, 201, 202):
        raise RuntimeError(f"push service {resp.status_code}: {resp.text[:200]}")


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


class SubscribeRequest(BaseModel):
    endpoint: str
    keys: dict
    user_agent: Optional[str] = None


class UnsubscribeRequest(BaseModel):
    endpoint: str


@router.get("/vapid-public-key")
async def get_vapid_public_key(request: Request) -> dict:
    _ctx(request)
    return {"public_key": settings.vapid_public_key}


@router.post("/subscribe", status_code=status.HTTP_201_CREATED)
async def subscribe(body: SubscribeRequest, request: Request) -> dict:
    from shared.db import db_connection  # noqa: PLC0415
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]
    async with db_connection() as conn:
        await conn.execute(
            """
            INSERT INTO g1.push_subscription
                (principal_id, endpoint, p256dh, auth, user_agent)
            VALUES (%s, %s, %s, %s, %s)
            ON CONFLICT (principal_id, endpoint) DO UPDATE
              SET p256dh     = EXCLUDED.p256dh,
                  auth       = EXCLUDED.auth,
                  user_agent = EXCLUDED.user_agent,
                  updated_at = now()
            """,
            (
                principal_id,
                body.endpoint,
                body.keys.get("p256dh", ""),
                body.keys.get("auth", ""),
                (body.user_agent or "")[:500],
            ),
        )
        await conn.commit()
    return {"ok": True}


@router.delete("/unsubscribe")
async def unsubscribe(body: UnsubscribeRequest, request: Request) -> dict:
    from shared.db import db_connection  # noqa: PLC0415
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]
    async with db_connection() as conn:
        await conn.execute(
            "DELETE FROM g1.push_subscription WHERE principal_id = %s AND endpoint = %s",
            (principal_id, body.endpoint),
        )
        await conn.commit()
    return {"ok": True}


@router.get("/subscriptions")
async def list_subscriptions(request: Request) -> dict:
    from shared.db import db_connection  # noqa: PLC0415
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT subscription_id, endpoint, user_agent, created_at, updated_at
            FROM g1.push_subscription
            WHERE principal_id = %s
            ORDER BY created_at DESC
            """,
            (principal_id,),
        )
        rows = await cur.fetchall()
    return {
        "subscriptions": [
            {
                "subscription_id": str(r[0]),
                "endpoint_prefix": r[1][:60] + "...",
                "user_agent": r[2],
                "created_at": r[3].isoformat(),
                "updated_at": r[4].isoformat(),
            }
            for r in rows
        ]
    }


@router.get("/latest")
async def latest_notification(request: Request) -> dict:
    """Service worker calls this after a trigger push to get notification content."""
    _ctx(request)
    return {
        "title": "JLMirror",
        "body": "Você tem uma nova notificação. Acesse o portal para ver.",
        "url": "/",
    }


@router.post("/send-test")
async def send_test(request: Request) -> dict:
    from shared.db import db_connection  # noqa: PLC0415
    ctx = _ctx(request)
    principal_id = ctx["principal_id"]

    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT endpoint FROM g1.push_subscription WHERE principal_id = %s",
            (principal_id,),
        )
        rows = await cur.fetchall()

    if not rows:
        raise HTTPException(status.HTTP_404_NOT_FOUND, detail="no_subscriptions")

    sent, failed = 0, 0
    for (endpoint,) in rows:
        try:
            await _send_push_trigger(endpoint)
            sent += 1
        except Exception as exc:
            logger.warning("push send failed for %s: %s", principal_id, exc)
            failed += 1

    return {"sent": sent, "failed": failed, "total": len(rows)}
