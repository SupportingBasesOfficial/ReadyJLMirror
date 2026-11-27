"""Platform administration surface — the platform-owner control plane
(organization-operating-model-contract.md §14).

Every endpoint requires the caller's principal to be a
platform_admin_principal (kind in g1.principals). Cross-tenant reach
is the privilege; all mutations emit durable audit evidence.
"""

from __future__ import annotations

import asyncio
import re as _re
import secrets
from datetime import datetime
from typing import Literal

import httpx
from fastapi import APIRouter, HTTPException, Request, Response
from pydantic import BaseModel

from shared import access
from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/platform", tags=["platform"])

# NOT under _DOMAIN_PREFIXES — platform endpoints gate on principal
# kind, not tenant-scoped permissions.


async def _require_platform_admin(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None:
        raise HTTPException(status_code=403,
                            detail="platform admin required")
    async with db_connection() as conn:
        ok = await access.principal_is_platform_admin(
            conn, ctx["principal_id"])
    if not ok:
        raise HTTPException(status_code=403,
                            detail="platform admin required")
    return ctx["principal_id"]


_ORG_KINDS = {"platform_operator", "msp", "client"}


class OrganizationCreate(BaseModel):
    organization_id: str
    display_name: str
    org_kind: str = "client"


@router.get("/organizations")
async def list_organizations(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT o.organization_id, o.display_name, o.state, o.created_at, o.org_kind,
                   COALESCE(
                       json_agg(json_build_object('tenant_id', t.tenant_id, 'display_name', t.display_name)
                           ORDER BY t.tenant_id)
                       FILTER (WHERE t.tenant_id IS NOT NULL),
                       '[]'
                   ) AS tenants
            FROM g1.organizations o
            LEFT JOIN g1.tenants t ON t.organization_id = o.organization_id
            GROUP BY o.organization_id, o.display_name, o.state, o.created_at, o.org_kind
            ORDER BY o.organization_id
            """)
        return [{"organization_id": r[0], "display_name": r[1],
                 "state": r[2],
                 "created_at": r[3].isoformat(),
                 "org_kind": r[4],
                 "tenants": r[5]}
                for r in await cur.fetchall()]


@router.post("/organizations", status_code=201)
async def create_organization(request: Request,
                              body: OrganizationCreate) -> dict:
    if body.org_kind not in _ORG_KINDS:
        raise HTTPException(status_code=422,
                            detail=f"org_kind must be one of {sorted(_ORG_KINDS)}")
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            "INSERT INTO g1.organizations (organization_id, display_name, org_kind) "
            "VALUES (%s, %s, %s) ON CONFLICT DO NOTHING",
            (body.organization_id, body.display_name, body.org_kind))
        await record_audit_event(
            conn, "platform",
            action="platform.organization.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="organization",
            subject_id=body.organization_id,
            detail={"display_name": body.display_name, "org_kind": body.org_kind})
        await conn.commit()
    return {"organization_id": body.organization_id}


_RELATIONSHIP_FAMILY_MAP = {
    "msp": "provides_monitoring_service_for",
    "reseller": "billing_responsible_for",
    "partner": "delegated_administration_for",
    "contracts_platform": "contracts_platform",
    "provides_monitoring_service_for": "provides_monitoring_service_for",
    "delegated_administration_for": "delegated_administration_for",
    "billing_responsible_for": "billing_responsible_for",
}

_VALID_FAMILIES = set(_RELATIONSHIP_FAMILY_MAP.values())


class RelationshipCreate(BaseModel):
    family: str
    source_organization_id: str
    target_organization_id: str


@router.get("/relationships")
async def list_relationships(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT relationship_id, family, source_organization_id, "
            "target_organization_id, state, effective_from, "
            "effective_until FROM g1.organization_relationships "
            "ORDER BY family, source_organization_id")
        return [{"relationship_id": r[0], "family": r[1],
                 "source_organization_id": r[2],
                 "target_organization_id": r[3], "state": r[4],
                 "effective_from": r[5].isoformat(),
                 "effective_until": r[6].isoformat() if r[6] else None}
                for r in await cur.fetchall()]


@router.post("/relationships", status_code=201)
async def create_relationship(request: Request,
                              body: RelationshipCreate) -> dict:
    actor = await _require_platform_admin(request)
    db_family = _RELATIONSHIP_FAMILY_MAP.get(body.family)
    if db_family is None:
        from fastapi import HTTPException
        raise HTTPException(
            status_code=422,
            detail=f"invalid family '{body.family}'; valid values: msp, reseller, partner")
    rel_id = f"rel_{secrets.token_urlsafe(12)}"
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            """
            INSERT INTO g1.organization_relationships
                (relationship_id, family, source_organization_id,
                 target_organization_id)
            VALUES (%s, %s, %s, %s)
            """,
            (rel_id, db_family, body.source_organization_id,
             body.target_organization_id))
        await record_audit_event(
            conn, "platform",
            action="platform.relationship.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="organization_relationship",
            subject_id=rel_id,
            detail={"family": body.family,
                    "source": body.source_organization_id,
                    "target": body.target_organization_id})
        await conn.commit()
    return {"relationship_id": rel_id}


class GrantCreate(BaseModel):
    source_organization_id: str
    target_tenant_id: str
    principal_id: str
    permissions: list[str]


@router.get("/delegated-grants")
async def list_grants(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT grant_id, source_organization_id, target_tenant_id,
                   principal_id, permissions, state, effective_from,
                   effective_until
              FROM g1.delegated_grants
             ORDER BY created_at DESC
            """)
        return [{"grant_id": r[0], "source_organization_id": r[1],
                 "target_tenant_id": r[2], "principal_id": r[3],
                 "permissions": r[4], "state": r[5],
                 "effective_from": r[6].isoformat(),
                 "effective_until": r[7].isoformat() if r[7] else None}
                for r in await cur.fetchall()]


@router.post("/delegated-grants", status_code=201)
async def create_grant(request: Request, body: GrantCreate) -> dict:
    actor = await _require_platform_admin(request)
    invalid = [p for p in body.permissions
               if p not in access.PERMISSIONS]
    if invalid:
        raise HTTPException(status_code=422,
                            detail=f"unknown permissions: {invalid}")
    grant_id = f"grant_{secrets.token_urlsafe(12)}"
    async with db_tenant_connection("platform") as conn:
        # Fail-closed: a delegated grant must be backed by an ACTIVE
        # relationship authorizing the source organization over the
        # target tenant's organization (contract §7 — delegation is
        # explicit, never emergent).
        cur = await conn.execute(
            """
            SELECT r.relationship_id, r.family
              FROM g1.organization_relationships r
              JOIN g1.tenants t
                ON t.organization_id = r.target_organization_id
             WHERE r.source_organization_id = %s
               AND t.tenant_id = %s
               AND r.state = 'active'
               AND r.family IN ('delegated_administration_for',
                                'provides_monitoring_service_for')
            """,
            (body.source_organization_id, body.target_tenant_id))
        relationship = await cur.fetchone()
        if relationship is None:
            raise HTTPException(
                status_code=403,
                detail="no active delegation relationship from the "
                       "source organization to the target tenant's "
                       "organization — grant refused")
        await conn.execute(
            """
            INSERT INTO g1.delegated_grants
                (grant_id, source_organization_id, target_tenant_id,
                 principal_id, permissions, granted_by)
            VALUES (%s, %s, %s, %s, %s, %s)
            """,
            (grant_id, body.source_organization_id,
             body.target_tenant_id, body.principal_id,
             body.permissions, actor))
        await record_audit_event(
            conn, "platform",
            action="platform.delegated_grant.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="delegated_grant", subject_id=grant_id,
            detail={"target_tenant": body.target_tenant_id,
                    "principal": body.principal_id,
                    "permissions": body.permissions})
        await conn.commit()
    return {"grant_id": grant_id}


@router.post("/delegated-grants/{grant_id}/revoke")
async def revoke_grant(request: Request, grant_id: str) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            """
            UPDATE g1.delegated_grants
               SET state = 'revoked',
                   revoked_at = transaction_timestamp()
             WHERE grant_id = %s AND state = 'active'
            """, (grant_id,))
        if cur.rowcount != 1:
            raise HTTPException(status_code=404,
                                detail="grant not found or not active")
        await record_audit_event(
            conn, "platform",
            action="platform.delegated_grant.revoked",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="delegated_grant", subject_id=grant_id)
        await conn.commit()
    return {"grant_id": grant_id, "state": "revoked"}


@router.post("/relationships/{relationship_id}/end")
async def end_relationship(request: Request, relationship_id: str) -> dict:
    """End an active organization relationship."""
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            """
            UPDATE g1.organization_relationships
               SET state = 'ended',
                   effective_until = transaction_timestamp()
             WHERE relationship_id = %s AND state = 'active'
            """, (relationship_id,))
        if cur.rowcount != 1:
            raise HTTPException(status_code=404,
                                detail="relationship not found or not active")
        await record_audit_event(
            conn, "platform",
            action="platform.relationship.ended",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="organization_relationship",
            subject_id=relationship_id)
        await conn.commit()
    return {"relationship_id": relationship_id, "state": "ended"}


@router.get("/organizations/{organization_id}")
async def organization_360(request: Request,
                           organization_id: str) -> dict:
    """Organization 360 (contract §15): what the org is, which
    tenants it owns, its relationships, delegated grants, and
    principals reachable through those grants."""
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT organization_id, display_name, state, created_at, org_kind "
            "FROM g1.organizations WHERE organization_id = %s",
            (organization_id,))
        org = await cur.fetchone()
        if org is None:
            raise HTTPException(status_code=404,
                                detail="organization not found")

        cur = await conn.execute(
            "SELECT tenant_id, display_name, state FROM g1.tenants "
            "WHERE organization_id = %s ORDER BY tenant_id",
            (organization_id,))
        tenants = [{"tenant_id": r[0], "display_name": r[1],
                    "state": r[2]} for r in await cur.fetchall()]

        cur = await conn.execute(
            """
            SELECT relationship_id, family, source_organization_id,
                   target_organization_id, state
              FROM g1.organization_relationships
             WHERE source_organization_id = %s
                OR target_organization_id = %s
             ORDER BY family
            """, (organization_id, organization_id))
        relationships = [
            {"relationship_id": r[0], "family": r[1],
             "direction": ("outgoing" if r[2] == organization_id
                           else "incoming"),
             "other_organization_id":
                 r[3] if r[2] == organization_id else r[2],
             "state": r[4]}
            for r in await cur.fetchall()]

        cur = await conn.execute(
            """
            SELECT g.grant_id, g.target_tenant_id, g.principal_id,
                   g.permissions, g.state
              FROM g1.delegated_grants g
             WHERE g.source_organization_id = %s
             ORDER BY g.created_at DESC
            """, (organization_id,))
        grants = [{"grant_id": r[0], "target_tenant_id": r[1],
                   "principal_id": r[2], "permissions": r[3],
                   "state": r[4]} for r in await cur.fetchall()]

        cur = await conn.execute(
            """
            SELECT m.principal_id, m.tenant_id, m.role, m.state
              FROM g1.tenant_memberships m
              JOIN g1.tenants t USING (tenant_id)
             WHERE t.organization_id = %s
            """, (organization_id,))
        members = [{"principal_id": r[0], "tenant_id": r[1],
                    "role": r[2], "state": r[3]}
                   for r in await cur.fetchall()]

    return {
        "organization_id": org[0], "display_name": org[1],
        "state": org[2], "created_at": org[3].isoformat(),
        "org_kind": org[4],
        "tenants": tenants, "relationships": relationships,
        "delegated_grants": grants, "members": members,
    }


class MspTransfer(BaseModel):
    """Service-provider transfer (contract §13): the monitored
    organization's tenant/identity is preserved; old delegated
    authority is fenced; successor authority is established;
    history remains attributable to the authority that existed
    when actions occurred."""
    target_organization_id: str
    from_organization_id: str
    to_organization_id: str


@router.post("/service-provider-transfer")
async def service_provider_transfer(request: Request,
                                    body: MspTransfer) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            "SELECT tenant_id FROM g1.tenants "
            "WHERE organization_id = %s", (body.target_organization_id,))
        target_tenants = [r[0] for r in await cur.fetchall()]
        if not target_tenants:
            raise HTTPException(
                status_code=404,
                detail="target organization has no tenants")

        # 1) Fence: revoke every active delegated grant from the
        #    outgoing provider over the target org's tenants.
        cur = await conn.execute(
            """
            UPDATE g1.delegated_grants
               SET state = 'revoked',
                   revoked_at = transaction_timestamp()
             WHERE source_organization_id = %s
               AND target_tenant_id = ANY(%s)
               AND state = 'active'
             RETURNING grant_id
            """, (body.from_organization_id, target_tenants))
        fenced = [r[0] for r in await cur.fetchall()]

        # 2) End the outgoing provider's relationships to the
        #    target organization.
        cur = await conn.execute(
            """
            UPDATE g1.organization_relationships
               SET state = 'ended',
                   effective_until = transaction_timestamp()
             WHERE source_organization_id = %s
               AND target_organization_id = %s
               AND state = 'active'
             RETURNING relationship_id
            """, (body.from_organization_id,
                  body.target_organization_id))
        ended = [r[0] for r in await cur.fetchall()]

        # 3) Establish successor relationships (same families).
        cur = await conn.execute(
            """
            SELECT family FROM g1.organization_relationships
             WHERE relationship_id = ANY(%s)
            """, (ended,))
        families = [r[0] for r in await cur.fetchall()]
        successors = []
        for fam in families:
            rel_id = f"rel_{secrets.token_urlsafe(12)}"
            await conn.execute(
                """
                INSERT INTO g1.organization_relationships
                    (relationship_id, family, source_organization_id,
                     target_organization_id)
                VALUES (%s, %s, %s, %s)
                """, (rel_id, fam, body.to_organization_id,
                      body.target_organization_id))
            successors.append(rel_id)

        await record_audit_event(
            conn, "platform",
            action="platform.service_provider.transferred",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="organization",
            subject_id=body.target_organization_id,
            detail={
                "from": body.from_organization_id,
                "to": body.to_organization_id,
                "fenced_grants": fenced,
                "ended_relationships": ended,
                "successor_relationships": successors})
        await conn.commit()

    return {"target_organization_id": body.target_organization_id,
            "fenced_grants": fenced,
            "ended_relationships": ended,
            "successor_relationships": successors}


# ---------------------------------------------------------------------------
# Display/TV principals (contract §9 — modelable part)
# ---------------------------------------------------------------------------

DISPLAY_PERMISSIONS = ("tenant:read", "monitoring:read",
                       "alerting:read", "observability:read")


class DisplayTokenCreate(BaseModel):
    tenant_id: str
    label: str | None = None
    expires_in_days: int | None = None


@router.get("/display-principals")
async def list_display_principals(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT p.principal_id, t.tenant_id, t.label,
                   t.created_at, t.expires_at, t.retired
              FROM g1.display_tokens t
              JOIN g1.principals p USING (principal_id)
             ORDER BY t.created_at DESC
            """)
        return [{"principal_id": r[0], "tenant_id": r[1],
                 "label": r[2], "created_at": r[3].isoformat(),
                 "expires_at": r[4].isoformat() if r[4] else None,
                 "retired": r[5]} for r in await cur.fetchall()]


@router.post("/display-tokens", status_code=201)
async def create_display_token(request: Request,
                               body: DisplayTokenCreate) -> dict:
    """Issue a display principal + device token. The raw token is
    returned ONCE — only its digest is stored (same rule as browser
    session handles). Rotation = issue a new token and retire this
    one."""
    actor = await _require_platform_admin(request)
    import hashlib as _hashlib

    principal_id = f"display_{secrets.token_urlsafe(10)}"
    token = f"jld_{secrets.token_urlsafe(32)}"
    digest = _hashlib.sha256(token.encode()).hexdigest()
    expires_sql = (
        "transaction_timestamp() + (%s || ' days')::interval"
        if body.expires_in_days else "NULL")
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            """
            INSERT INTO g1.principals
                (principal_id, kind, credential_generation)
            VALUES (%s, 'display_principal', %s)
            """,
            (principal_id, f"cg-{secrets.token_urlsafe(8)}"))
        await conn.execute(
            f"""
            INSERT INTO g1.display_tokens
                (token_digest, principal_id, tenant_id, label,
                 expires_at)
            VALUES (%s, %s, %s, %s, {expires_sql})
            """,
            (digest, principal_id, body.tenant_id, body.label,
             *( [str(body.expires_in_days)]
                if body.expires_in_days else [])))
        await record_audit_event(
            conn, "platform",
            action="platform.display_token.issued",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="display_token", subject_id=principal_id,
            detail={"tenant_id": body.tenant_id,
                    "label": body.label})
        await conn.commit()
    return {"principal_id": principal_id, "token": token,
            "permissions": list(DISPLAY_PERMISSIONS)}


@router.post("/display-tokens/{principal_id}/revoke")
async def revoke_display_token(request: Request,
                               principal_id: str) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            """
            UPDATE g1.display_tokens SET retired = TRUE
             WHERE principal_id = %s AND retired = FALSE
            """, (principal_id,))
        await conn.execute(
            "UPDATE g1.principals SET active = FALSE "
            "WHERE principal_id = %s", (principal_id,))
        await record_audit_event(
            conn, "platform",
            action="platform.display_token.revoked",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="display_token", subject_id=principal_id)
        await conn.commit()
    return {"principal_id": principal_id, "state": "revoked"}


# ---------------------------------------------------------------------------
# Commercial attribution (§10-12) — structure, no pricing
# ---------------------------------------------------------------------------


class CommercialAccountCreate(BaseModel):
    account_id: str
    organization_id: str


@router.get("/commercial-accounts")
async def list_commercial_accounts(request: Request) -> list[dict]:
    """Return commercial accounts with nested contracts and entitlements.

    Field names are aligned with the frontend CommercialAccount interface:
    commercial_account_id (was account_id), name (org display_name fallback),
    org_id (organization_id), contracts[], entitlements[].
    """
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT ca.account_id,
                   COALESCE(o.display_name, ca.account_id) AS name,
                   ca.organization_id, ca.state, ca.created_at
              FROM g1.commercial_accounts ca
              LEFT JOIN g1.organizations o USING (organization_id)
             ORDER BY ca.account_id
            """)
        accounts = [{"commercial_account_id": r[0], "name": r[1],
                     "org_id": r[2], "state": r[3],
                     "created_at": r[4].isoformat()}
                    for r in await cur.fetchall()]

        if not accounts:
            return accounts

        account_ids = [a["commercial_account_id"] for a in accounts]

        cur = await conn.execute(
            """
            SELECT contract_id, account_id, plan_ref, state,
                   effective_from, effective_until
              FROM g1.contracts WHERE account_id = ANY(%s)
            """, (account_ids,))
        contracts_by_account: dict[str, list] = {}
        all_contract_ids: list[str] = []
        for r in await cur.fetchall():
            cid, aid, plan_ref, state, eff_from, eff_until = r
            contracts_by_account.setdefault(aid, []).append({
                "contract_id": cid,
                "commercial_account_id": aid,
                "plan_ref": plan_ref,
                "state": state,
                "effective_from": eff_from.isoformat() if eff_from else None,
                "effective_until": eff_until.isoformat() if eff_until else None,
            })
            all_contract_ids.append(cid)

        entitlements_by_account: dict[str, list] = {}
        if all_contract_ids:
            contract_to_account = {
                c["contract_id"]: c["commercial_account_id"]
                for cs in contracts_by_account.values()
                for c in cs
            }
            cur = await conn.execute(
                """
                SELECT entitlement_id, contract_id, capability, state
                  FROM g1.entitlements WHERE contract_id = ANY(%s)
                """, (all_contract_ids,))
            for r in await cur.fetchall():
                eid, cid, cap, state = r
                aid = contract_to_account.get(cid)
                if aid:
                    entitlements_by_account.setdefault(aid, []).append({
                        "entitlement_id": eid,
                        "contract_id": cid,
                        "capability": cap,
                        "state": state,
                    })

        for acc in accounts:
            aid = acc["commercial_account_id"]
            acc["contracts"] = contracts_by_account.get(aid, [])
            acc["entitlements"] = entitlements_by_account.get(aid, [])

    return accounts


@router.post("/commercial-accounts", status_code=201)
async def create_commercial_account(
        request: Request, body: CommercialAccountCreate) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            "INSERT INTO g1.commercial_accounts (account_id, "
            "organization_id) VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (body.account_id, body.organization_id))
        await record_audit_event(
            conn, "platform",
            action="platform.commercial_account.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="commercial_account",
            subject_id=body.account_id,
            detail={"organization_id": body.organization_id})
        await conn.commit()
    return {"account_id": body.account_id}


class ContractCreate(BaseModel):
    contract_id: str
    account_id: str
    plan_ref: str | None = None


@router.get("/contracts")
async def list_contracts(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT contract_id, account_id, plan_ref, state, "
            "effective_from, effective_until "
            "FROM g1.contracts ORDER BY contract_id")
        return [{"contract_id": r[0], "account_id": r[1],
                 "plan_ref": r[2], "state": r[3],
                 "effective_from": r[4].isoformat(),
                 "effective_until": r[5].isoformat() if r[5] else None}
                for r in await cur.fetchall()]


@router.post("/contracts", status_code=201)
async def create_contract(request: Request,
                          body: ContractCreate) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            "INSERT INTO g1.contracts (contract_id, account_id, "
            "plan_ref) VALUES (%s, %s, %s)",
            (body.contract_id, body.account_id, body.plan_ref))
        await record_audit_event(
            conn, "platform",
            action="platform.contract.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="contract", subject_id=body.contract_id,
            detail={"account_id": body.account_id,
                    "plan_ref": body.plan_ref})
        await conn.commit()
    return {"contract_id": body.contract_id}


class EntitlementCreate(BaseModel):
    contract_id: str
    capability: str
    assigned_organization_id: str | None = None


@router.get("/entitlements")
async def list_entitlements(request: Request) -> list[dict]:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT entitlement_id, contract_id, capability, "
            "assigned_organization_id, state "
            "FROM g1.entitlements ORDER BY contract_id")
        return [{"entitlement_id": r[0], "contract_id": r[1],
                 "capability": r[2],
                 "assigned_organization_id": r[3], "state": r[4]}
                for r in await cur.fetchall()]


@router.post("/entitlements", status_code=201)
async def create_entitlement(request: Request,
                             body: EntitlementCreate) -> dict:
    """Entitlement != Permission (contract §11): assigning a
    capability to an organization is explicit and inspectable —
    it never grants authority by itself."""
    actor = await _require_platform_admin(request)
    ent_id = f"ent_{secrets.token_urlsafe(12)}"
    async with db_tenant_connection("platform") as conn:
        await conn.execute(
            """
            INSERT INTO g1.entitlements
                (entitlement_id, contract_id, capability,
                 assigned_organization_id)
            VALUES (%s, %s, %s, %s)
            """, (ent_id, body.contract_id, body.capability,
                  body.assigned_organization_id))
        await record_audit_event(
            conn, "platform",
            action="platform.entitlement.assigned",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="entitlement", subject_id=ent_id,
            detail={"contract_id": body.contract_id,
                    "capability": body.capability,
                    "organization_id": body.assigned_organization_id})
        await conn.commit()
    return {"entitlement_id": ent_id}


@router.get("/usage")
async def list_usage(request: Request,
                     tenant_id: str | None = None) -> list[dict]:
    """Usage/meter records — traceable to tenant, beneficiary org,
    contract and billing account (§12)."""
    await _require_platform_admin(request)
    clauses = ["1=1"]
    params: list = []
    if tenant_id:
        clauses.append("tenant_id = %s")
        params.append(tenant_id)
    async with db_connection() as conn:
        cur = await conn.execute(
            f"""
            SELECT usage_id, tenant_id,
                   beneficiary_organization_id, contract_id,
                   billing_account_id, meter, quantity,
                   window_start, window_end
              FROM g1.usage_meters
             WHERE {' AND '.join(clauses)}
             ORDER BY window_start DESC LIMIT 200
            """, tuple(params))
        return [{"usage_id": r[0], "tenant_id": r[1],
                 "beneficiary_organization_id": r[2],
                 "contract_id": r[3], "billing_account_id": r[4],
                 "meter": r[5], "quantity": float(r[6]),
                 "window_start": r[7].isoformat(),
                 "window_end": r[8].isoformat()}
                for r in await cur.fetchall()]


@router.get("/health")
async def platform_health(request: Request) -> dict:
    """Lightweight liveness check for the platform admin dashboard."""
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT
                (SELECT count(*) FROM g1.tenants WHERE state = 'active')
                    AS active_tenants,
                (SELECT count(*) FROM g1.organizations WHERE state = 'active')
                    AS active_orgs,
                (SELECT count(*) FROM g1.principals WHERE active = true)
                    AS active_principals
            """
        )
        row = await cur.fetchone()
    return {
        "status": "ok",
        "active_tenants": int(row[0]),
        "active_organizations": int(row[1]),
        "active_principals": int(row[2]),
    }


@router.get("/principals")
async def list_principals(
    request: Request, tenant_id: str | None = None
) -> list[dict]:
    """All principals with tenant memberships, enriched with Keycloak profile."""
    await _require_platform_admin(request)
    clauses: list[str] = []
    params: list = []
    if tenant_id:
        clauses.append("tm.tenant_id = %s")
        params.append(tenant_id)
    where = f"WHERE {' AND '.join(clauses)}" if clauses else ""
    async with db_connection() as conn:
        cur = await conn.execute(
            f"""
            SELECT p.principal_id, p.kind, p.active, p.created_at,
                   tm.tenant_id, tm.role, tm.membership_id
              FROM g1.principals p
              LEFT JOIN g1.tenant_memberships tm ON tm.principal_id = p.principal_id
            {where}
             ORDER BY p.created_at DESC LIMIT 500
            """, tuple(params))
        rows = await cur.fetchall()

    principal_ids = list({r[0] for r in rows})
    kc_map: dict = {}
    if principal_ids:
        try:
            from shared import keycloak_admin
            kc_map = await keycloak_admin.get_users_by_ids(principal_ids)
        except Exception:
            import logging as _logging
            _logging.getLogger(__name__).warning(
                "platform: failed to resolve Keycloak display names", exc_info=True)

    result = []
    for r in rows:
        pid, kind, active, created_at, tid, role, mid = r
        kc = kc_map.get(pid, {})
        fn = (kc.get("first_name") or "").strip()
        ln = (kc.get("last_name") or "").strip()
        display_name = f"{fn} {ln}".strip() or kc.get("email") or None
        result.append({
            "principal_id": pid,
            "kind": kind,
            "active": active,
            "created_at": created_at.isoformat() if created_at else None,
            "tenant_id": tid,
            "role": role,
            "membership_id": mid,
            "display_name": display_name,
            "email": kc.get("email") if kc else None,
        })
    return result


class TenantCreate(BaseModel):
    tenant_id: str
    display_name: str
    organization_id: str


@router.post("/tenants", status_code=201)
async def create_tenant(request: Request, body: TenantCreate) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.organizations WHERE organization_id = %s",
            (body.organization_id,))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404,
                                detail="organization not found")
        await conn.execute(
            """
            INSERT INTO g1.tenants
                (tenant_id, display_name, organization_id)
            VALUES (%s, %s, %s)
            """,
            (body.tenant_id, body.display_name, body.organization_id))
        await record_audit_event(
            conn, "platform",
            action="platform.tenant.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="tenant", subject_id=body.tenant_id,
            detail={"display_name": body.display_name,
                    "organization_id": body.organization_id})
        await conn.commit()
    return {"tenant_id": body.tenant_id, "display_name": body.display_name}


@router.get("/teia")
async def platform_teia(request: Request) -> list[dict]:
    """Cross-tenant relational map for Platform Admin.

    Returns all active/suspended tenants with their members and monitoring
    source counts. The g1 tables carry no RLS so member data loads in a
    single query; source counts require a per-tenant GUC and are fetched
    concurrently.
    """
    await _require_platform_admin(request)

    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT t.tenant_id, t.display_name, t.state, t.organization_id,
                   (SELECT count(*) FROM g1.tenant_memberships tm2
                    WHERE tm2.tenant_id = t.tenant_id
                      AND tm2.state = 'active') AS member_count
              FROM g1.tenants t
             WHERE t.state IN ('active', 'suspended')
             ORDER BY t.display_name
             LIMIT 200
            """)
        tenants: list[dict] = [
            {
                "tenant_id": r[0],
                "display_name": r[1],
                "state": r[2],
                "organization_id": r[3],
                "member_count": int(r[4]),
                "source_count": 0,
                "members": [],
            }
            for r in await cur.fetchall()
        ]

        if tenants:
            tids = [t["tenant_id"] for t in tenants]
            placeholders = ", ".join(["%s"] * len(tids))
            cur = await conn.execute(
                f"""
                SELECT tm.tenant_id, tm.principal_id, tm.role,
                       p.display_name, p.email
                  FROM g1.tenant_memberships tm
                  JOIN g1.principals p ON p.principal_id = tm.principal_id
                 WHERE tm.tenant_id IN ({placeholders})
                   AND tm.state = 'active'
                   AND p.active = true
                 ORDER BY tm.tenant_id, tm.role, p.display_name
                """,
                tids,
            )
            members_by: dict[str, list[dict]] = {}
            for r in await cur.fetchall():
                members_by.setdefault(r[0], []).append(
                    {"principal_id": r[1], "role": r[2],
                     "display_name": r[3], "email": r[4]}
                )
            for t in tenants:
                t["members"] = members_by.get(t["tenant_id"], [])

    async def _source_count(tenant_id: str) -> tuple[str, int]:
        try:
            async with db_tenant_connection(tenant_id) as conn:
                cur = await conn.execute(
                    "SELECT count(*) FROM monitoring.monitoring_source"
                    " WHERE tenant_id = %s",
                    (tenant_id,),
                )
                row = await cur.fetchone()
                return tenant_id, int(row[0]) if row else 0
        except Exception:
            return tenant_id, 0

    counts = dict(await asyncio.gather(*[
        _source_count(t["tenant_id"]) for t in tenants
    ]))
    for t in tenants:
        t["source_count"] = counts.get(t["tenant_id"], 0)

    return tenants


@router.get("/tenants")
async def list_tenants(request: Request) -> list[dict]:
    """Platform sovereign view of tenants (§14) — read-only."""
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT t.tenant_id, t.display_name, t.state,
                   t.organization_id
              FROM g1.tenants t ORDER BY t.tenant_id
            """)
        return [{"tenant_id": r[0], "display_name": r[1],
                 "state": r[2], "organization_id": r[3]}
                for r in await cur.fetchall()]


_ALLOWED_ORG_STATES = {"active", "suspended", "cancelled"}


class OrganizationStateUpdate(BaseModel):
    state: str  # "active" | "suspended" | "cancelled"


@router.patch("/organizations/{org_id}/state")
async def update_organization_state(request: Request,
                                    org_id: str,
                                    body: OrganizationStateUpdate) -> dict:
    """Transition an organization's lifecycle state (§14).

    Accepted values: 'active', 'suspended', 'cancelled'.
    Suspending an organization also suspends all of its tenants so
    their workloads become ineligible for placement.
    All state changes produce durable audit evidence."""
    actor = await _require_platform_admin(request)
    if body.state not in _ALLOWED_ORG_STATES:
        raise HTTPException(
            status_code=422,
            detail=f"state must be one of {sorted(_ALLOWED_ORG_STATES)}")
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            "SELECT organization_id, display_name, state, created_at "
            "FROM g1.organizations WHERE organization_id = %s",
            (org_id,))
        org = await cur.fetchone()
        if org is None:
            raise HTTPException(status_code=404,
                                detail="organization not found")
        previous_state = org[2]
        await conn.execute(
            "UPDATE g1.organizations SET state = %s "
            "WHERE organization_id = %s",
            (body.state, org_id))
        if body.state == "suspended":
            await conn.execute(
                "UPDATE g1.tenants SET state = 'suspended' "
                "WHERE organization_id = %s",
                (org_id,))
        await record_audit_event(
            conn, "platform",
            action="platform.organization.state_changed",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="organization", subject_id=org_id,
            detail={"previous_state": previous_state,
                    "new_state": body.state})
        await conn.commit()
    return {"organization_id": org_id, "display_name": org[1],
            "state": body.state, "created_at": org[3].isoformat()}


# ---------------------------------------------------------------------------
# User provisioning (Keycloak + tenant membership in one shot)
# ---------------------------------------------------------------------------

PROVISION_ROLES = ("admin", "operator", "viewer", "auditor")


class UserProvision(BaseModel):
    email: str
    first_name: str
    last_name: str
    tenant_id: str
    role: str = "viewer"
    temp_password: str | None = None


class UserPasswordReset(BaseModel):
    new_password: str | None = None


@router.post("/users", status_code=201)
async def provision_user(request: Request, body: UserProvision,
                         response: Response) -> dict:
    """Create a Keycloak account, register the principal, and add the user
    to the target tenant with the requested role — all in one operation.

    Returns the temporary password that the user must change on first login.
    This is the ONLY time the plain-text password is visible.
    """
    actor = await _require_platform_admin(request)
    if body.role not in PROVISION_ROLES:
        raise HTTPException(
            status_code=422,
            detail=f"role must be one of {PROVISION_ROLES}")

    from shared import keycloak_admin

    temp_pw = body.temp_password or keycloak_admin.generate_temp_password()
    try:
        user_id = await keycloak_admin.create_user(
            email=body.email,
            first_name=body.first_name,
            last_name=body.last_name,
            temp_password=temp_pw,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc))
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Keycloak error: {exc.response.status_code}")

    membership_id = f"mem_{secrets.token_urlsafe(12)}"
    async with db_tenant_connection("platform") as conn:
        # Upsert principal (oidc_user kind; credential_generation is a
        # stable opaque tag for this provisioning event).
        await conn.execute(
            """
            INSERT INTO g1.principals
                (principal_id, kind, credential_generation)
            VALUES (%s, 'oidc_user', %s)
            ON CONFLICT (principal_id) DO NOTHING
            """,
            (user_id, f"prov-{secrets.token_urlsafe(8)}"))

        cur = await conn.execute(
            """
            INSERT INTO g1.tenant_memberships
                (membership_id, tenant_id, principal_id, role)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (tenant_id, principal_id)
            DO UPDATE SET role = EXCLUDED.role, state = 'active'
            RETURNING membership_id
            """,
            (membership_id, body.tenant_id, user_id, body.role))
        membership_id = (await cur.fetchone())[0]

        await record_audit_event(
            conn, "platform",
            action="platform.user.provisioned",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="principal", subject_id=user_id,
            detail={"email": body.email, "tenant_id": body.tenant_id,
                    "role": body.role, "membership_id": membership_id})
        await conn.commit()

    response.headers["Cache-Control"] = "no-store"
    return {
        "principal_id": user_id,
        "email": body.email,
        "tenant_id": body.tenant_id,
        "role": body.role,
        "membership_id": membership_id,
        "temp_password": temp_pw,
        "must_change_password": True,
    }


@router.get("/users")
async def search_users(request: Request, q: str = "") -> list[dict]:
    """Search Keycloak users by email or name fragment, enriched with tenant memberships."""
    await _require_platform_admin(request)
    from shared import keycloak_admin
    try:
        kc_users = await keycloak_admin.search_users(q, max_results=50)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Keycloak error: {exc.response.status_code}")

    if not kc_users:
        return kc_users

    user_ids = [u["user_id"] for u in kc_users if u.get("user_id")]
    memberships_by_user: dict[str, list[dict]] = {}
    if user_ids:
        async with db_connection() as conn:
            cur = await conn.execute(
                """
                SELECT p.idp_subject_ref,
                       m.tenant_id, t.display_name,
                       m.role, m.state,
                       o.organization_id, o.display_name
                  FROM g1.principals p
                  JOIN g1.tenant_memberships m USING (principal_id)
                  JOIN g1.tenants t USING (tenant_id)
                  JOIN g1.organizations o
                    ON o.organization_id = t.organization_id
                 WHERE p.idp_subject_ref = ANY(%s)
                   AND m.state = 'active'
                """, (user_ids,))
            for r in await cur.fetchall():
                idp_ref = r[0]
                memberships_by_user.setdefault(idp_ref, []).append({
                    "tenant_id": r[1],
                    "tenant_name": r[2],
                    "role": r[3],
                    "state": r[4],
                    "organization_id": r[5],
                    "organization_name": r[6],
                })

    for u in kc_users:
        u["tenants"] = memberships_by_user.get(u.get("user_id", ""), [])

    return kc_users


@router.post("/users/{user_id}/disable")
async def disable_user(request: Request, user_id: str) -> dict:
    """Disable a Keycloak account (user cannot log in; data is preserved)."""
    actor = await _require_platform_admin(request)
    from shared import keycloak_admin
    try:
        await keycloak_admin.set_user_enabled(user_id, enabled=False)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Keycloak error: {exc.response.status_code}")
    async with db_tenant_connection("platform") as conn:
        await record_audit_event(
            conn, "platform",
            action="platform.user.disabled",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="principal", subject_id=user_id)
        await conn.commit()
    return {"principal_id": user_id, "enabled": False}


@router.post("/users/{user_id}/enable")
async def enable_user(request: Request, user_id: str) -> dict:
    """Re-enable a previously disabled Keycloak account."""
    actor = await _require_platform_admin(request)
    from shared import keycloak_admin
    try:
        await keycloak_admin.set_user_enabled(user_id, enabled=True)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Keycloak error: {exc.response.status_code}")
    async with db_tenant_connection("platform") as conn:
        await record_audit_event(
            conn, "platform",
            action="platform.user.enabled",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="principal", subject_id=user_id)
        await conn.commit()
    return {"principal_id": user_id, "enabled": True}


@router.post("/users/{user_id}/reset-password")
async def reset_user_password(
    request: Request, user_id: str, body: UserPasswordReset,
    response: Response,
) -> dict:
    """Reset a user's password. If new_password is omitted a fresh
    temporary password is generated and returned."""
    actor = await _require_platform_admin(request)
    from shared import keycloak_admin
    new_pw = body.new_password or keycloak_admin.generate_temp_password()
    try:
        await keycloak_admin.reset_password(user_id, new_pw, temporary=True)
    except httpx.HTTPStatusError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Keycloak error: {exc.response.status_code}")
    async with db_tenant_connection("platform") as conn:
        await record_audit_event(
            conn, "platform",
            action="platform.user.password_reset",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="principal", subject_id=user_id)
        await conn.commit()
    response.headers["Cache-Control"] = "no-store"
    return {"principal_id": user_id, "temp_password": new_pw,
            "must_change_password": True}


# ── Plan Catalog (G13 — Record #69, 2026-11-25) ────────────────────────────

_PLAN_ID_RE = _re.compile(r"^[a-z0-9][a-z0-9\-]{0,48}[a-z0-9]$")


class PlanCreate(BaseModel):
    plan_id: str
    display_name: str
    description: str | None = None
    visible: bool = True
    sort_order: int = 0
    price_monthly: float | None = None
    price_currency: str = "BRL"


class PlanUpdate(BaseModel):
    display_name: str | None = None
    description: str | None = None
    visible: bool | None = None
    sort_order: int | None = None
    price_monthly: float | None = None
    price_currency: str | None = None


class PlanCapabilityBody(BaseModel):
    capability: str


class PlanQuotaBody(BaseModel):
    quota_key: str
    quota_value: int  # -1 = ilimitado


@router.get("/plans")
async def list_plans(request: Request) -> list[dict]:
    """Lista planos. Platform admin vê todos; autenticados veem só visible + active."""
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is None:
        raise HTTPException(status_code=401, detail="authentication required")
    async with db_connection() as conn:
        is_admin = await access.principal_is_platform_admin(
            conn, ctx["principal_id"])
        where = ("" if is_admin
                 else "WHERE p.state = 'active' AND p.visible = TRUE")
        cur = await conn.execute(
            f"""
            SELECT p.plan_id, p.display_name, p.description,
                   p.visible, p.sort_order, p.price_monthly,
                   p.price_currency, p.state,
                   p.created_at, p.updated_at,
                   COALESCE(json_agg(DISTINCT pc.capability)
                       FILTER (WHERE pc.capability IS NOT NULL), '[]') AS capabilities,
                   COALESCE(
                       json_agg(json_build_object(
                           'quota_key', pq.quota_key,
                           'quota_value', pq.quota_value)
                       ) FILTER (WHERE pq.quota_key IS NOT NULL), '[]') AS quotas,
                   (SELECT count(*) FROM g1.contracts c
                    WHERE c.plan_ref = p.plan_id AND c.state = 'active'
                   ) AS active_contracts
              FROM g1.plans p
              LEFT JOIN g1.plan_capabilities pc ON pc.plan_id = p.plan_id
              LEFT JOIN g1.plan_quotas pq ON pq.plan_id = p.plan_id
            {where}
             GROUP BY p.plan_id
             ORDER BY p.sort_order, p.plan_id
            """)
        return [
            {
                "plan_id": r[0],
                "display_name": r[1],
                "description": r[2],
                "visible": r[3],
                "sort_order": r[4],
                "price_monthly": float(r[5]) if r[5] is not None else None,
                "price_currency": r[6],
                "state": r[7],
                "created_at": r[8].isoformat(),
                "updated_at": r[9].isoformat(),
                "capabilities": r[10],
                "quotas": r[11],
                "active_contracts": int(r[12]),
            }
            for r in await cur.fetchall()
        ]


@router.post("/plans", status_code=201)
async def create_plan(request: Request, body: PlanCreate) -> dict:
    if not _PLAN_ID_RE.match(body.plan_id):
        raise HTTPException(
            status_code=422,
            detail="plan_id deve ser um slug minúsculo (a-z, 0-9, hífens, 2-50 chars)")
    if body.price_monthly is not None and body.price_monthly < 0:
        raise HTTPException(status_code=422,
                            detail="price_monthly deve ser >= 0")
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        try:
            await conn.execute(
                """
                INSERT INTO g1.plans
                    (plan_id, display_name, description, visible,
                     sort_order, price_monthly, price_currency)
                VALUES (%s, %s, %s, %s, %s, %s, %s)
                """,
                (body.plan_id, body.display_name, body.description,
                 body.visible, body.sort_order, body.price_monthly,
                 body.price_currency))
        except Exception as exc:
            if "duplicate" in str(exc).lower() or "unique" in str(exc).lower():
                raise HTTPException(status_code=409,
                                    detail=f"plan_id '{body.plan_id}' já existe")
            raise
        await record_audit_event(
            conn, "platform",
            action="platform.plan.created",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="plan", subject_id=body.plan_id,
            detail={"display_name": body.display_name,
                    "visible": body.visible,
                    "price_monthly": body.price_monthly,
                    "price_currency": body.price_currency})
        await conn.commit()
    return {"plan_id": body.plan_id}


@router.patch("/plans/{plan_id}")
async def update_plan(request: Request, plan_id: str,
                      body: PlanUpdate) -> dict:
    actor = await _require_platform_admin(request)
    sets: list[str] = []
    params: list = []
    if body.display_name is not None:
        sets.append("display_name = %s")
        params.append(body.display_name)
    if body.description is not None:
        sets.append("description = %s")
        params.append(body.description)
    if body.visible is not None:
        sets.append("visible = %s")
        params.append(body.visible)
    if body.sort_order is not None:
        sets.append("sort_order = %s")
        params.append(body.sort_order)
    if body.price_monthly is not None:
        if body.price_monthly < 0:
            raise HTTPException(status_code=422,
                                detail="price_monthly deve ser >= 0")
        sets.append("price_monthly = %s")
        params.append(body.price_monthly)
    if body.price_currency is not None:
        sets.append("price_currency = %s")
        params.append(body.price_currency)
    if not sets:
        raise HTTPException(status_code=422, detail="nada para atualizar")
    sets.append("updated_at = now()")
    params.append(plan_id)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            f"UPDATE g1.plans SET {', '.join(sets)} WHERE plan_id = %s",
            tuple(params))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404, detail="plano não encontrado")
        await record_audit_event(
            conn, "platform",
            action="platform.plan.updated",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="plan", subject_id=plan_id,
            detail={k: v for k, v in body.model_dump().items()
                    if v is not None})
        await conn.commit()
    return {"plan_id": plan_id}


@router.post("/plans/{plan_id}/archive")
async def archive_plan(request: Request, plan_id: str) -> dict:
    """Arquiva um plano. Contratos existentes continuam; ficam marcados como
    'plano descontinuado' na UI. Não bloqueia — Mauricio decide migrar depois."""
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur_count = await conn.execute(
            "SELECT count(*) FROM g1.contracts WHERE plan_ref = %s AND state = 'active'",
            (plan_id,))
        row = await cur_count.fetchone()
        active_contracts = int(row[0])
        cur = await conn.execute(
            "UPDATE g1.plans SET state = 'archived', updated_at = now() "
            "WHERE plan_id = %s AND state = 'active'",
            (plan_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404,
                                detail="plano não encontrado ou já arquivado")
        await record_audit_event(
            conn, "platform",
            action="platform.plan.archived",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="plan", subject_id=plan_id,
            detail={"active_contracts_at_archive": active_contracts})
        await conn.commit()
    return {"plan_id": plan_id, "state": "archived",
            "active_contracts": active_contracts}


@router.post("/plans/{plan_id}/restore")
async def restore_plan(request: Request, plan_id: str) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            "UPDATE g1.plans SET state = 'active', updated_at = now() "
            "WHERE plan_id = %s AND state = 'archived'",
            (plan_id,))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404,
                                detail="plano não encontrado ou não está arquivado")
        await record_audit_event(
            conn, "platform",
            action="platform.plan.restored",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="plan", subject_id=plan_id,
            detail={})
        await conn.commit()
    return {"plan_id": plan_id, "state": "active"}


@router.post("/plans/{plan_id}/capabilities", status_code=201)
async def add_plan_capability(request: Request, plan_id: str,
                               body: PlanCapabilityBody) -> dict:
    cap = body.capability.strip().lower()
    if not cap or len(cap) > 100:
        raise HTTPException(status_code=422,
                            detail="capability obrigatória (máx 100 chars)")
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        # Verifica se o plano existe
        cur = await conn.execute(
            "SELECT 1 FROM g1.plans WHERE plan_id = %s", (plan_id,))
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="plano não encontrado")
        await conn.execute(
            "INSERT INTO g1.plan_capabilities (plan_id, capability) "
            "VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (plan_id, cap))
        await conn.execute(
            "UPDATE g1.plans SET updated_at = now() WHERE plan_id = %s",
            (plan_id,))
        await record_audit_event(
            conn, "platform",
            action="platform.plan.capability_added",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="plan", subject_id=plan_id,
            detail={"capability": cap})
        await conn.commit()
    return {"plan_id": plan_id, "capability": cap}


@router.delete("/plans/{plan_id}/capabilities/{capability}")
async def remove_plan_capability(request: Request, plan_id: str,
                                  capability: str) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            "DELETE FROM g1.plan_capabilities "
            "WHERE plan_id = %s AND capability = %s",
            (plan_id, capability))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404,
                                detail="capability não encontrada no plano")
        await conn.execute(
            "UPDATE g1.plans SET updated_at = now() WHERE plan_id = %s",
            (plan_id,))
        await record_audit_event(
            conn, "platform",
            action="platform.plan.capability_removed",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="plan", subject_id=plan_id,
            detail={"capability": capability})
        await conn.commit()
    return {"plan_id": plan_id, "capability": capability, "removed": True}


@router.post("/plans/{plan_id}/quotas", status_code=201)
async def set_plan_quota(request: Request, plan_id: str,
                          body: PlanQuotaBody) -> dict:
    key = body.quota_key.strip().lower()
    if not key or len(key) > 100:
        raise HTTPException(status_code=422,
                            detail="quota_key obrigatória (máx 100 chars)")
    if body.quota_value != -1 and body.quota_value < 0:
        raise HTTPException(
            status_code=422,
            detail="quota_value deve ser -1 (ilimitado) ou >= 0")
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.plans WHERE plan_id = %s", (plan_id,))
        if not await cur.fetchone():
            raise HTTPException(status_code=404, detail="plano não encontrado")
        await conn.execute(
            """
            INSERT INTO g1.plan_quotas (plan_id, quota_key, quota_value)
            VALUES (%s, %s, %s)
            ON CONFLICT (plan_id, quota_key)
            DO UPDATE SET quota_value = EXCLUDED.quota_value
            """,
            (plan_id, key, body.quota_value))
        await conn.execute(
            "UPDATE g1.plans SET updated_at = now() WHERE plan_id = %s",
            (plan_id,))
        await record_audit_event(
            conn, "platform",
            action="platform.plan.quota_set",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="plan", subject_id=plan_id,
            detail={"quota_key": key, "quota_value": body.quota_value})
        await conn.commit()
    return {"plan_id": plan_id, "quota_key": key,
            "quota_value": body.quota_value}


@router.delete("/plans/{plan_id}/quotas/{quota_key}")
async def remove_plan_quota(request: Request, plan_id: str,
                             quota_key: str) -> dict:
    actor = await _require_platform_admin(request)
    async with db_tenant_connection("platform") as conn:
        cur = await conn.execute(
            "DELETE FROM g1.plan_quotas WHERE plan_id = %s AND quota_key = %s",
            (plan_id, quota_key))
        if cur.rowcount == 0:
            raise HTTPException(status_code=404,
                                detail="quota não encontrada no plano")
        await conn.execute(
            "UPDATE g1.plans SET updated_at = now() WHERE plan_id = %s",
            (plan_id,))
        await record_audit_event(
            conn, "platform",
            action="platform.plan.quota_removed",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="plan", subject_id=plan_id,
            detail={"quota_key": quota_key})
        await conn.commit()
    return {"plan_id": plan_id, "quota_key": quota_key, "removed": True}


# ── Cross-tenant audit log ────────────────────────────────────────────────────

@router.get("/audit")
async def platform_audit(
    request: Request,
    limit: int = 50,
    tenant_id: str | None = None,
    action: str | None = None,
    actor_id: str | None = None,
    since: str | None = None,
) -> list[dict]:
    await _require_platform_admin(request)
    since_dt: datetime | None = None
    if since:
        try:
            since_dt = datetime.fromisoformat(since)
        except ValueError:
            raise HTTPException(status_code=422, detail="since inválido (ISO 8601)")
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT * FROM audit.list_all_events(%s, %s, %s, %s, %s)",
            (min(limit, 500), tenant_id, action, actor_id, since_dt),
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
    return [dict(zip(cols, row)) for row in rows]


# ── Quota health (per-tenant usage vs limits) ─────────────────────────────────

@router.get("/quota-health")
async def platform_quota_health(request: Request) -> list[dict]:
    await _require_platform_admin(request)

    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT
                t.tenant_id,
                t.display_name,
                t.state,
                c.plan_ref,
                COALESCE(
                    json_agg(
                        json_build_object('key', pq.quota_key, 'limit', pq.quota_value)
                    ) FILTER (WHERE pq.quota_key IS NOT NULL),
                    '[]'::json
                ) AS quotas
            FROM g1.tenants t
            LEFT JOIN g1.commercial_accounts ca
                   ON ca.organization_id = t.organization_id
            LEFT JOIN g1.contracts c
                   ON c.account_id = ca.account_id
                  AND c.state = 'active'
            LEFT JOIN g1.plan_quotas pq
                   ON pq.plan_id = c.plan_ref
            WHERE t.state = 'active'
            GROUP BY t.tenant_id, t.display_name, t.state, c.plan_ref
            """,
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
        tenant_data = [dict(zip(cols, row)) for row in rows]

        cur2 = await conn.execute(
            """
            SELECT tenant_id, COUNT(*) AS member_count
              FROM g1.tenant_memberships
             WHERE state = 'active'
             GROUP BY tenant_id
            """,
        )
        member_map = {r[0]: r[1] for r in await cur2.fetchall()}

    async def _count_sources(tid: str) -> int:
        try:
            async with db_tenant_connection(tid) as tconn:
                cur = await tconn.execute(
                    "SELECT COUNT(*) FROM monitoring.monitoring_source WHERE tenant_id = %s",
                    (tid,),
                )
                row = await cur.fetchone()
                return int(row[0]) if row else 0
        except Exception:  # noqa: BLE001
            return 0

    source_counts = await asyncio.gather(
        *[_count_sources(t["tenant_id"]) for t in tenant_data]
    )

    return [
        {
            "tenant_id": td["tenant_id"],
            "display_name": td["display_name"],
            "state": td["state"],
            "plan_ref": td["plan_ref"],
            "quotas": td["quotas"] or [],
            "member_count": member_map.get(td["tenant_id"], 0),
            "source_count": source_counts[i],
        }
        for i, td in enumerate(tenant_data)
    ]


# ── Tenant suspend / restore ──────────────────────────────────────────────────

class _TenantStateBody(BaseModel):
    state: Literal["active", "suspended"]


@router.patch("/tenants/{tenant_id}/state")
async def set_tenant_state(
    request: Request, tenant_id: str, body: _TenantStateBody
) -> dict:
    actor = await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            "UPDATE g1.tenants SET state = %s WHERE tenant_id = %s "
            "RETURNING tenant_id, state",
            (body.state, tenant_id),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="tenant não encontrado")
        await record_audit_event(
            conn, "platform",
            action="platform.tenant.state_changed",
            actor_kind="platform_admin", actor_id=actor,
            subject_type="tenant", subject_id=tenant_id,
            detail={"new_state": body.state},
        )
        await conn.commit()
    return {"tenant_id": row[0], "state": row[1]}


# ── Billing overview (cross-tenant contracts) ─────────────────────────────────

@router.get("/billing-overview")
async def platform_billing_overview(request: Request) -> dict:
    await _require_platform_admin(request)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT
                c.contract_id,
                c.account_id,
                c.plan_ref,
                c.state,
                c.effective_from,
                c.effective_until,
                o.display_name AS org_name,
                CASE
                    WHEN c.effective_until IS NULL THEN NULL
                    ELSE EXTRACT(DAY FROM c.effective_until - now())::INTEGER
                END AS days_remaining
            FROM g1.contracts c
            JOIN g1.commercial_accounts ca ON ca.account_id = c.account_id
            JOIN g1.organizations o ON o.organization_id = ca.organization_id
            ORDER BY c.effective_until ASC NULLS LAST
            """,
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
        contracts = [dict(zip(cols, row)) for row in rows]

    active = [c for c in contracts if c["state"] == "active"]
    expiring_soon = [
        c for c in active
        if c["days_remaining"] is not None and 0 <= c["days_remaining"] <= 30
    ]
    expired_or_ended = [
        c for c in contracts
        if c["state"] in ("ended", "suspended")
        or (c["days_remaining"] is not None and c["days_remaining"] < 0)
    ]
    return {
        "total_active": len(active),
        "expiring_soon": len(expiring_soon),
        "expired_or_ended": len(expired_or_ended),
        "contracts": contracts,
    }
