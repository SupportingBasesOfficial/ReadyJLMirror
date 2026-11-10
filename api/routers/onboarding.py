"""G25 Tenant Self-Service Onboarding.

New principals with no tenant membership create their first workspace here.
No tenant_id is required in the context — only an authenticated principal.

POST /register          — generic first workspace (org_kind inferred from profile)
POST /self-managed      — explicit self-managed profile (org_kind='client', no MSP)
"""

from __future__ import annotations

import re
import secrets

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared.db import db_connection

router = APIRouter(prefix="/api/v1/onboarding", tags=["onboarding"])

_SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9\-]{1,48}[a-z0-9]$")

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


# ── Self-managed profile ───────────────────────────────────────────────────────

class RegisterSelfManaged(BaseModel):
    organization_name: str
    organization_slug: str          # e.g. "minha-empresa"
    tenant_name: str


@router.post("/self-managed", status_code=status.HTTP_201_CREATED)
async def register_self_managed(request: Request, body: RegisterSelfManaged) -> dict:
    """Create a self-managed organization (org_kind='client') with no MSP dependency.

    Use this when the company manages its own IT without an external MSP.
    Creates: organization → tenant → admin membership for the calling principal.
    """
    principal_id = _principal_id(request)

    org_name = body.organization_name.strip()
    if not org_name:
        raise HTTPException(status_code=422, detail="organization_name is required")
    if len(org_name) > 120:
        raise HTTPException(status_code=422, detail="organization_name max 120 chars")

    slug = body.organization_slug.strip().lower()
    if not _SLUG_RE.match(slug):
        raise HTTPException(
            status_code=422,
            detail="organization_slug must be 3-50 chars, lowercase letters, digits, hyphens",
        )

    tenant_name = body.tenant_name.strip()
    if not tenant_name:
        raise HTTPException(status_code=422, detail="tenant_name is required")

    org_id = f"org:{slug}-{secrets.token_hex(4)}"
    tenant_id = f"ten:{slug}-{secrets.token_hex(4)}"
    membership_id = f"mem:{secrets.token_hex(8)}"

    async with db_connection() as conn:
        # Verify principal is active
        cur = await conn.execute(
            "SELECT principal_id FROM g1.principals "
            "WHERE principal_id=%s AND kind='human_browser_session'",
            (principal_id,),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=403, detail="principal not found")

        # Slug-based ID collision guard (org_id includes slug + random suffix)
        cur = await conn.execute(
            "SELECT organization_id FROM g1.organizations WHERE organization_id LIKE %s",
            (f"org:{slug}-%",),
        )
        if await cur.fetchone() is not None:
            raise HTTPException(status_code=409,
                                detail="organization_slug already taken")

        # Create organization (self-managed = org_kind 'client', no MSP link)
        await conn.execute(
            """
            INSERT INTO g1.organizations
                (organization_id, display_name, org_kind)
            VALUES (%s, %s, 'client')
            """,
            (org_id, org_name),
        )

        # Create tenant linked to this org
        await conn.execute(
            """
            INSERT INTO g1.tenants
                (tenant_id, organization_id, display_name)
            VALUES (%s, %s, %s)
            """,
            (tenant_id, org_id, tenant_name),
        )

        # Grant admin membership to the calling principal
        await conn.execute(
            """
            INSERT INTO g1.tenant_memberships
                (membership_id, tenant_id, principal_id, role)
            VALUES (%s, %s, %s, 'tenant_admin')
            """,
            (membership_id, tenant_id, principal_id),
        )

        await conn.commit()

    return {
        "organization_id": org_id,
        "organization_name": org_name,
        "organization_slug": slug,
        "tenant_id": tenant_id,
        "tenant_name": tenant_name,
        "membership_id": membership_id,
        "role": "tenant_admin",
        "org_kind": "client",
    }
