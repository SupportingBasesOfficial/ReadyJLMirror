"""Identity and membership resolution for G1.

The BFF resolves the platform principal from the external IdP binding
(`idp_subject_ref`). In development mode, unknown subjects are
JIT-provisioned and granted membership to the dev tenant. In
production, principals must already exist — unknown subjects fail
closed (no existence leakage).
"""

from __future__ import annotations

import secrets
from datetime import datetime, timezone
from typing import Optional

from psycopg import AsyncConnection

from shared.config import settings


async def resolve_or_provision_principal(
    conn: AsyncConnection, *, idp_subject_ref: str, idp_issuer: str
) -> Optional[dict]:
    """Resolve the platform principal bound to an external IdP subject.

    Development: unknown subjects are JIT-provisioned and granted
    membership to `tenant:dev`. Production: unknown subjects return None
    (fail closed, no existence leakage).
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT principal_id, kind, credential_generation, active
              FROM g1.principals
             WHERE idp_subject_ref = %s AND idp_issuer = %s
            """,
            (idp_subject_ref, idp_issuer),
        )
        row = await cur.fetchone()

    if row is not None:
        principal_id, kind, credential_generation, active = row
        return {
            "principal_id": principal_id,
            "kind": kind,
            "credential_generation": credential_generation,
            "active": active,
        }

    if not settings.is_development:
        return None

    # Development JIT provisioning
    principal_id = f"principal.{secrets.token_urlsafe(16)}"
    credential_generation = f"credential-gen-{secrets.token_urlsafe(8)}"
    async with conn.cursor() as cur:
        await cur.execute(
            """
            INSERT INTO g1.principals
                (principal_id, kind, credential_generation,
                 idp_subject_ref, idp_issuer, active)
            VALUES (%s, 'human_browser_session', %s, %s, %s, TRUE)
            """,
            (principal_id, credential_generation, idp_subject_ref, idp_issuer),
        )
        # Grant membership to the dev tenant
        await cur.execute(
            """
            INSERT INTO g1.tenant_memberships
                (membership_id, tenant_id, principal_id, role, state)
            VALUES (%s, %s, %s, 'member', 'active')
            ON CONFLICT (tenant_id, principal_id) DO NOTHING
            """,
            (
                f"membership.{secrets.token_urlsafe(16)}",
                settings.dev_tenant_id,
                principal_id,
            ),
        )
    return {
        "principal_id": principal_id,
        "kind": "human_browser_session",
        "credential_generation": credential_generation,
        "active": True,
    }


async def list_memberships(conn: AsyncConnection, principal_id: str) -> list[dict]:
    """List the principal's active memberships in active tenants."""
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT m.tenant_id, m.role, t.display_name
              FROM g1.tenant_memberships m
              JOIN g1.tenants t USING (tenant_id)
             WHERE m.principal_id = %s
               AND m.state = 'active'
               AND t.state = 'active'
            """,
            (principal_id,),
        )
        rows = await cur.fetchall()
    return [
        {"tenant_id": r[0], "role": r[1], "display_name": r[2]} for r in rows
    ]


async def check_membership(
    conn: AsyncConnection, principal_id: str, tenant_id: str
) -> Optional[dict]:
    """Return active membership for (principal, tenant), or None.

    Returns None for both non-membership and inactive tenant — no
    existence leakage between the two cases.
    """
    async with conn.cursor() as cur:
        await cur.execute(
            """
            SELECT m.role, t.display_name
              FROM g1.tenant_memberships m
              JOIN g1.tenants t USING (tenant_id)
             WHERE m.principal_id = %s
               AND m.tenant_id = %s
               AND m.state = 'active'
               AND t.state = 'active'
            """,
            (principal_id, tenant_id),
        )
        row = await cur.fetchone()
    if row is None:
        return None
    return {"role": row[0], "display_name": row[1]}
