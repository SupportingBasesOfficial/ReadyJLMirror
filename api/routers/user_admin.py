"""Tenant-scoped user administration — full lifecycle.

Covers create, list, update profile, change role, deactivate, reactivate,
reset password, and remove for the four account personas:
  - Admin MSP / Cliente Monitorado — Keycloak-backed (oidc_user kind)
  - TV Mode (display_principal kind) — token-only, no Keycloak login

Requires tenant:admin on the calling principal. All mutations emit
durable audit evidence.
"""

from __future__ import annotations

import logging
import secrets

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared import access
from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection
from shared import keycloak_admin as kc

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1/admin", tags=["user-admin"])

ROLES = ("admin", "operator", "viewer", "auditor")


# ---------------------------------------------------------------------------
# Auth helper
# ---------------------------------------------------------------------------


async def _require_tenant_admin(request: Request) -> tuple[str, str]:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None or not ctx.get("tenant_id"):
        raise HTTPException(status_code=403, detail="tenant authority required")
    tenant_id = ctx["tenant_id"]
    principal_id = ctx["principal_id"]
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="tenant:admin required")
    return tenant_id, principal_id


def _split_name(display_name: str | None) -> tuple[str, str]:
    parts = (display_name or "").strip().split(" ", 1)
    return parts[0], parts[1] if len(parts) > 1 else ""


# ---------------------------------------------------------------------------
# List users
# ---------------------------------------------------------------------------


@router.get("/users")
async def list_users(request: Request) -> list[dict]:
    tenant, _ = _require_tenant_admin(request)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT p.principal_id, p.active, p.created_at,
                   p.display_name, p.email, p.idp_subject_ref,
                   tm.role, tm.state AS membership_state
              FROM g1.principals p
              JOIN g1.tenant_memberships tm ON tm.principal_id = p.principal_id
             WHERE tm.tenant_id = %s
             ORDER BY p.created_at
            """,
            (tenant,),
        )
        rows = await cur.fetchall()

    result = []
    for r in rows:
        first, last = _split_name(r[3])
        result.append({
            "principal_id": r[0],
            "active": r[1],
            "created_at": r[2].isoformat() if r[2] else None,
            "display_name": r[3] or "",
            "first_name": first,
            "last_name": last,
            "email": r[4] or "",
            "idp_subject_ref": r[5] or "",
            "kc_enabled": r[1],
            "role": r[6],
            "membership_state": r[7],
        })
    return result


# ---------------------------------------------------------------------------
# Create user (Keycloak-backed)
# ---------------------------------------------------------------------------


class UserCreate(BaseModel):
    email: str
    first_name: str
    last_name: str = ""
    role: str = "viewer"


@router.post("/users", status_code=201)
async def create_user(request: Request, body: UserCreate) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    if body.role not in ROLES:
        raise HTTPException(422, detail=f"role must be one of {ROLES}")
    if not body.email or "@" not in body.email:
        raise HTTPException(422, detail="valid email required")

    temp_password = kc.generate_temp_password()
    display_name = f"{body.first_name} {body.last_name}".strip()

    # Create in Keycloak — returns UUID used as principal_id
    try:
        user_id = await kc.create_user(
            email=body.email.strip().lower(),
            first_name=body.first_name.strip(),
            last_name=body.last_name.strip(),
            temp_password=temp_password,
        )
    except ValueError as exc:
        raise HTTPException(409, detail=str(exc))

    # Insert principal + membership; rollback Keycloak on DB failure
    membership_id = f"mem_{secrets.token_urlsafe(12)}"
    credential_gen = f"adm-{secrets.token_urlsafe(8)}"
    try:
        async with db_tenant_connection(tenant) as conn:
            await conn.execute(
                """
                INSERT INTO g1.principals
                    (principal_id, kind, credential_generation,
                     idp_subject_ref, display_name, email, active)
                VALUES (%s, 'oidc_user', %s, %s, %s, %s, TRUE)
                """,
                (user_id, credential_gen, user_id, display_name,
                 body.email.strip().lower()),
            )
            await conn.execute(
                """
                INSERT INTO g1.tenant_memberships
                    (membership_id, tenant_id, principal_id, role)
                VALUES (%s, %s, %s, %s)
                """,
                (membership_id, tenant, user_id, body.role),
            )
            await record_audit_event(
                conn, tenant,
                action="user.created",
                actor_kind="principal", actor_id=actor,
                subject_type="principal", subject_id=user_id,
                detail={"email": body.email, "role": body.role},
            )
            await conn.commit()
    except Exception as exc:
        logger.warning("DB insert failed after Keycloak create for %s: %s",
                       user_id, exc)
        try:
            await kc.delete_user(user_id)
        except Exception:
            logger.warning("Keycloak rollback failed for %s", user_id)
        raise HTTPException(500, detail="user creation failed; keycloak user removed")

    return {"principal_id": user_id, "temp_password": temp_password}


# ---------------------------------------------------------------------------
# Update profile
# ---------------------------------------------------------------------------


class UserUpdate(BaseModel):
    first_name: str | None = None
    last_name: str | None = None
    email: str | None = None


@router.patch("/users/{principal_id}")
async def update_user(
    request: Request, principal_id: str, body: UserUpdate
) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    async with db_tenant_connection(tenant) as conn:
        # Verify user is in this tenant
        cur = await conn.execute(
            """
            SELECT p.idp_subject_ref, p.display_name, p.email
              FROM g1.principals p
              JOIN g1.tenant_memberships tm USING (principal_id)
             WHERE p.principal_id = %s AND tm.tenant_id = %s
               AND tm.state = 'active'
            """,
            (principal_id, tenant),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(404, detail="user not found in tenant")

        idp_ref, current_display, current_email = row[0], row[1], row[2]

        # Build new display_name
        old_first, old_last = _split_name(current_display)
        new_first = body.first_name.strip() if body.first_name is not None else old_first
        new_last = body.last_name.strip() if body.last_name is not None else old_last
        new_display = f"{new_first} {new_last}".strip()
        new_email = body.email.strip().lower() if body.email else current_email

        await conn.execute(
            """
            UPDATE g1.principals
               SET display_name = %s, email = %s
             WHERE principal_id = %s
            """,
            (new_display, new_email, principal_id),
        )
        await record_audit_event(
            conn, tenant,
            action="user.updated",
            actor_kind="principal", actor_id=actor,
            subject_type="principal", subject_id=principal_id,
            detail={"display_name": new_display, "email": new_email},
        )
        await conn.commit()

    # Update Keycloak if user has an IdP binding
    if idp_ref:
        try:
            await kc.update_user_profile(
                user_id=idp_ref,
                first_name=new_first or None,
                last_name=new_last or None,
                email=new_email if new_email != current_email else None,
            )
        except Exception as exc:
            logger.warning("Keycloak profile update failed for %s: %s",
                           principal_id, exc)

    return {"principal_id": principal_id, "display_name": new_display}


# ---------------------------------------------------------------------------
# Change role
# ---------------------------------------------------------------------------


class RoleUpdate(BaseModel):
    role: str


@router.patch("/users/{principal_id}/role")
async def change_role(
    request: Request, principal_id: str, body: RoleUpdate
) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    if body.role not in ROLES:
        raise HTTPException(422, detail=f"role must be one of {ROLES}")

    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            UPDATE g1.tenant_memberships
               SET role = %s
             WHERE principal_id = %s AND tenant_id = %s
               AND state = 'active'
            """,
            (body.role, principal_id, tenant),
        )
        if cur.rowcount != 1:
            raise HTTPException(404, detail="active membership not found")
        await record_audit_event(
            conn, tenant,
            action="user.role_changed",
            actor_kind="principal", actor_id=actor,
            subject_type="principal", subject_id=principal_id,
            detail={"role": body.role},
        )
        await conn.commit()

    return {"principal_id": principal_id, "role": body.role}


# ---------------------------------------------------------------------------
# Deactivate / reactivate
# ---------------------------------------------------------------------------


@router.post("/users/{principal_id}/deactivate")
async def deactivate_user(request: Request, principal_id: str) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT p.idp_subject_ref
              FROM g1.principals p
              JOIN g1.tenant_memberships tm USING (principal_id)
             WHERE p.principal_id = %s AND tm.tenant_id = %s
            """,
            (principal_id, tenant),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(404, detail="user not found in tenant")
        idp_ref = row[0]

        await conn.execute(
            "UPDATE g1.principals SET active = FALSE WHERE principal_id = %s",
            (principal_id,),
        )
        await conn.execute(
            """
            UPDATE g1.tenant_memberships SET state = 'revoked'
             WHERE principal_id = %s AND tenant_id = %s AND state = 'active'
            """,
            (principal_id, tenant),
        )
        await record_audit_event(
            conn, tenant,
            action="user.deactivated",
            actor_kind="principal", actor_id=actor,
            subject_type="principal", subject_id=principal_id,
        )
        await conn.commit()

    if idp_ref:
        try:
            await kc.set_user_enabled(idp_ref, False)
            await kc.logout_user_sessions(idp_ref)
        except Exception as exc:
            logger.warning("Keycloak disable failed for %s: %s",
                           principal_id, exc)

    return {"principal_id": principal_id, "active": False}


@router.post("/users/{principal_id}/reactivate")
async def reactivate_user(request: Request, principal_id: str) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT p.idp_subject_ref
              FROM g1.principals p
              JOIN g1.tenant_memberships tm USING (principal_id)
             WHERE p.principal_id = %s AND tm.tenant_id = %s
            """,
            (principal_id, tenant),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(404, detail="user not found in tenant")
        idp_ref = row[0]

        await conn.execute(
            "UPDATE g1.principals SET active = TRUE WHERE principal_id = %s",
            (principal_id,),
        )
        await conn.execute(
            """
            UPDATE g1.tenant_memberships SET state = 'active'
             WHERE principal_id = %s AND tenant_id = %s AND state = 'revoked'
            """,
            (principal_id, tenant),
        )
        await record_audit_event(
            conn, tenant,
            action="user.reactivated",
            actor_kind="principal", actor_id=actor,
            subject_type="principal", subject_id=principal_id,
        )
        await conn.commit()

    if idp_ref:
        try:
            await kc.set_user_enabled(idp_ref, True)
        except Exception as exc:
            logger.warning("Keycloak enable failed for %s: %s",
                           principal_id, exc)

    return {"principal_id": principal_id, "active": True}


# ---------------------------------------------------------------------------
# Reset password
# ---------------------------------------------------------------------------


@router.post("/users/{principal_id}/reset-password")
async def reset_password(request: Request, principal_id: str) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT p.idp_subject_ref
              FROM g1.principals p
              JOIN g1.tenant_memberships tm USING (principal_id)
             WHERE p.principal_id = %s AND tm.tenant_id = %s
            """,
            (principal_id, tenant),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(404, detail="user not found in tenant")
        idp_ref = row[0]

    if not idp_ref:
        raise HTTPException(422, detail="user has no IdP binding")

    temp_password = kc.generate_temp_password()
    await kc.reset_password(idp_ref, temp_password, temporary=True)
    await kc.logout_user_sessions(idp_ref)

    async with db_tenant_connection(tenant) as conn:
        await record_audit_event(
            conn, tenant,
            action="user.password_reset",
            actor_kind="principal", actor_id=actor,
            subject_type="principal", subject_id=principal_id,
        )
        await conn.commit()

    return {"temp_password": temp_password}


# ---------------------------------------------------------------------------
# Delete user
# ---------------------------------------------------------------------------


@router.delete("/users/{principal_id}", status_code=200)
async def delete_user(request: Request, principal_id: str) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT p.idp_subject_ref
              FROM g1.principals p
              JOIN g1.tenant_memberships tm USING (principal_id)
             WHERE p.principal_id = %s AND tm.tenant_id = %s
            """,
            (principal_id, tenant),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(404, detail="user not found in tenant")
        idp_ref = row[0]

        # Remove membership in this tenant
        await conn.execute(
            """
            DELETE FROM g1.tenant_memberships
             WHERE principal_id = %s AND tenant_id = %s
            """,
            (principal_id, tenant),
        )

        # Check remaining memberships — only nuke principal if isolated
        cur = await conn.execute(
            "SELECT count(*) FROM g1.tenant_memberships WHERE principal_id = %s",
            (principal_id,),
        )
        remaining = (await cur.fetchone())[0]

        if remaining == 0:
            await conn.execute(
                "DELETE FROM g1.principals WHERE principal_id = %s",
                (principal_id,),
            )

        await record_audit_event(
            conn, tenant,
            action="user.deleted",
            actor_kind="principal", actor_id=actor,
            subject_type="principal", subject_id=principal_id,
            detail={"remaining_memberships": remaining},
        )
        await conn.commit()

    # Delete from Keycloak only when no remaining memberships
    if remaining == 0 and idp_ref:
        try:
            await kc.delete_user(idp_ref)
        except Exception as exc:
            logger.warning("Keycloak delete failed for %s: %s",
                           principal_id, exc)

    return {"principal_id": principal_id, "deleted": True,
            "kc_deleted": remaining == 0 and bool(idp_ref)}


# ---------------------------------------------------------------------------
# TV Mode — display token lifecycle
# ---------------------------------------------------------------------------


class DisplayTokenCreate(BaseModel):
    label: str
    tenant_id: str | None = None
    expires_in_days: int | None = None


@router.get("/display-tokens")
async def list_display_tokens(request: Request) -> list[dict]:
    tenant, _ = await _require_tenant_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT t.principal_id, t.tenant_id, t.label,
                   t.created_at, t.expires_at, t.retired
              FROM g1.display_tokens t
             WHERE t.tenant_id = %s
             ORDER BY t.created_at DESC
            """,
            (tenant,),
        )
        return [
            {
                "principal_id": r[0],
                "tenant_id": r[1],
                "label": r[2],
                "created_at": r[3].isoformat() if r[3] else None,
                "expires_at": r[4].isoformat() if r[4] else None,
                "retired": r[5],
            }
            for r in await cur.fetchall()
        ]


@router.post("/display-tokens", status_code=201)
async def create_display_token(
    request: Request, body: DisplayTokenCreate
) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    principal_id = f"tv_{secrets.token_urlsafe(16)}"
    raw_token = secrets.token_urlsafe(32)
    import hashlib
    token_digest = hashlib.sha256(raw_token.encode()).hexdigest()
    credential_gen = f"tv-{secrets.token_urlsafe(8)}"

    expires_expr = (
        f"transaction_timestamp() + ('{body.expires_in_days} days')::interval"
        if body.expires_in_days else "NULL"
    )

    async with db_tenant_connection(tenant) as conn:
        await conn.execute(
            """
            INSERT INTO g1.principals
                (principal_id, kind, credential_generation)
            VALUES (%s, 'display_principal', %s)
            """,
            (principal_id, credential_gen),
        )
        await conn.execute(
            f"""
            INSERT INTO g1.display_tokens
                (principal_id, tenant_id, token_digest, label, expires_at)
            VALUES (%s, %s, %s, %s, {expires_expr})
            """,
            (principal_id, tenant, token_digest, body.label),
        )
        await record_audit_event(
            conn, tenant,
            action="display_token.created",
            actor_kind="principal", actor_id=actor,
            subject_type="principal", subject_id=principal_id,
            detail={"label": body.label},
        )
        await conn.commit()

    return {
        "principal_id": principal_id,
        "token": raw_token,
        "label": body.label,
    }


@router.post("/display-tokens/{principal_id}/retire")
async def retire_display_token(request: Request, principal_id: str) -> dict:
    tenant, actor = await _require_tenant_admin(request)

    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            UPDATE g1.display_tokens SET retired = TRUE
             WHERE principal_id = %s AND tenant_id = %s AND retired = FALSE
            """,
            (principal_id, tenant),
        )
        if cur.rowcount != 1:
            raise HTTPException(404, detail="active display token not found")
        await conn.execute(
            "UPDATE g1.principals SET active = FALSE WHERE principal_id = %s",
            (principal_id,),
        )
        await record_audit_event(
            conn, tenant,
            action="display_token.retired",
            actor_kind="principal", actor_id=actor,
            subject_type="principal", subject_id=principal_id,
        )
        await conn.commit()

    return {"principal_id": principal_id, "retired": True}
