"""G25 Tenant Self-Service Onboarding.

New principals with no tenant membership create their first workspace here.
No tenant_id is required in the context — only an authenticated principal.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared.db import db_connection

router = APIRouter(prefix="/api/v1/onboarding", tags=["onboarding"])

_APP_ROLE = "jlmirror_g25_onboarding_app_invoker"


def _principal_id(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None or not ctx.get("principal_id"):
        raise HTTPException(status_code=401, detail="unauthenticated")
    return ctx["principal_id"]


class RegisterTenant(BaseModel):
    tenant_name: str


@router.post("/register", status_code=status.HTTP_201_CREATED)
async def register_tenant(request: Request, body: RegisterTenant) -> dict:
    """Create the caller's first tenant workspace and return admin membership."""
    principal_id = _principal_id(request)
    name = body.tenant_name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="tenant_name must not be empty")
    if len(name) > 120:
        raise HTTPException(status_code=422, detail="tenant_name too long (max 120 chars)")

    async with db_connection() as conn:
        await conn.execute(f"SET LOCAL ROLE {_APP_ROLE}")
        try:
            cur = await conn.execute(
                "SELECT tenant_id, membership_id FROM g1.g25_register_tenant(%s, %s)",
                (principal_id, name),
            )
            row = await cur.fetchone()
        except Exception as exc:
            msg = str(exc)
            if "not found or inactive" in msg:
                raise HTTPException(status_code=403, detail="principal not active")
            if "too long" in msg:
                raise HTTPException(status_code=422, detail="tenant_name too long")
            raise HTTPException(status_code=500, detail="registration failed")
        await conn.commit()

    return {
        "tenant_id": row[0],
        "membership_id": row[1],
        "role": "admin",
        "tenant_name": name,
    }
