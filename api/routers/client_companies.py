"""ClientCompany (Empresa) router — MSP client company management.

Each ClientCompany groups monitoring hostgroups from one or more sources,
forming the foundational scope unit for alerts, SLA, users, AIOps, etc.
"""

from __future__ import annotations

import secrets

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared.audit import record_audit_event
from shared.config import settings
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/companies", tags=["companies"])


def _authoritative_tenant(request: Request, body_tenant: str | None) -> str:
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is not None and ctx.get("tenant_id"):
        return ctx["tenant_id"]
    if settings.is_development and body_tenant:
        return body_tenant
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="no tenant authority",
    )


def _ctx(request: Request) -> dict:
    return getattr(request.state, "jlmirror_context", {}) or {}


def _row_to_company(row: tuple, keys: tuple) -> dict:
    d = dict(zip(keys, row))
    if hasattr(d.get("created_at"), "isoformat"):
        d["created_at"] = d["created_at"].isoformat()
    return d


# ---------------------------------------------------------------------------
# Company CRUD
# ---------------------------------------------------------------------------


class CompanyCreateRequest(BaseModel):
    tenant_id: str | None = None
    name: str
    slug: str
    notes: str | None = None


class CompanyPatchRequest(BaseModel):
    name: str | None = None
    status: str | None = None
    notes: str | None = None


_COMPANY_KEYS = (
    "company_id", "tenant_id", "name", "slug", "status", "notes", "created_at",
)


@router.get("")
async def list_companies(
    request: Request, tenant_id: str | None = None
) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT cc.company_id, cc.tenant_id, cc.name, cc.slug, cc.status,
                   cc.notes, cc.created_at,
                   COUNT(hs.scope_id)::int AS scope_count
              FROM g1.client_companies cc
              LEFT JOIN monitoring.company_hostgroup_scope hs
                     ON hs.company_id = cc.company_id
             WHERE cc.tenant_id = %s
             GROUP BY cc.company_id
             ORDER BY cc.name
            """,
            (tenant,),
        )
        rows = await cur.fetchall()
    keys = _COMPANY_KEYS + ("scope_count",)
    return [_row_to_company(r, keys) for r in rows]


@router.post("", status_code=201)
async def create_company(body: CompanyCreateRequest, request: Request) -> dict:
    tenant = _authoritative_tenant(request, body.tenant_id)
    name = body.name.strip()
    slug = body.slug.strip().lower()
    if not name:
        raise HTTPException(status_code=422, detail="name required")
    if not slug:
        raise HTTPException(status_code=422, detail="slug required")
    company_id = f"co-{secrets.token_urlsafe(12)}"
    async with db_tenant_connection(tenant) as conn:
        try:
            cur = await conn.execute(
                """
                INSERT INTO g1.client_companies
                    (company_id, tenant_id, name, slug, status, notes)
                VALUES (%s, %s, %s, %s, 'active', %s)
                RETURNING company_id, tenant_id, name, slug, status, notes, created_at
                """,
                (company_id, tenant, name, slug, body.notes),
            )
            row = await cur.fetchone()
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(status_code=409, detail="slug already exists in this tenant")
            raise
        ctx = _ctx(request)
        await record_audit_event(
            conn, tenant,
            action="company.created",
            actor_kind="principal",
            actor_id=ctx.get("principal_id"),
            subject_type="client_company",
            subject_id=company_id,
            detail={"name": name, "slug": slug},
            correlation_id=ctx.get("correlation_id"),
        )
        await conn.commit()
    return _row_to_company(row, _COMPANY_KEYS)


@router.get("/{company_id}")
async def get_company(
    company_id: str, request: Request, tenant_id: str | None = None
) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT company_id, tenant_id, name, slug, status, notes, created_at
              FROM g1.client_companies
             WHERE company_id = %s AND tenant_id = %s
            """,
            (company_id, tenant),
        )
        row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="company not found")
    return _row_to_company(row, _COMPANY_KEYS)


@router.patch("/{company_id}")
async def patch_company(
    company_id: str,
    body: CompanyPatchRequest,
    request: Request,
    tenant_id: str | None = None,
) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    if body.status is not None and body.status not in ("active", "inactive", "suspended"):
        raise HTTPException(status_code=422, detail="status must be active|inactive|suspended")
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            UPDATE g1.client_companies
               SET name   = COALESCE(%s, name),
                   status = COALESCE(%s, status),
                   notes  = COALESCE(%s, notes)
             WHERE company_id = %s AND tenant_id = %s
             RETURNING company_id, tenant_id, name, slug, status, notes, created_at
            """,
            (body.name, body.status, body.notes, company_id, tenant),
        )
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="company not found")
        ctx = _ctx(request)
        await record_audit_event(
            conn, tenant,
            action="company.updated",
            actor_kind="principal",
            actor_id=ctx.get("principal_id"),
            subject_type="client_company",
            subject_id=company_id,
            detail=body.model_dump(exclude_none=True),
            correlation_id=ctx.get("correlation_id"),
        )
        await conn.commit()
    return _row_to_company(row, _COMPANY_KEYS)


@router.delete("/{company_id}", status_code=200)
async def delete_company(
    company_id: str, request: Request, tenant_id: str | None = None
) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            DELETE FROM g1.client_companies
             WHERE company_id = %s AND tenant_id = %s
             RETURNING company_id
            """,
            (company_id, tenant),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="company not found")
        ctx = _ctx(request)
        await record_audit_event(
            conn, tenant,
            action="company.deleted",
            actor_kind="principal",
            actor_id=ctx.get("principal_id"),
            subject_type="client_company",
            subject_id=company_id,
            correlation_id=ctx.get("correlation_id"),
        )
        await conn.commit()
    return {"deleted": True, "company_id": company_id}


# ---------------------------------------------------------------------------
# Hostgroup scope management
# ---------------------------------------------------------------------------


_SCOPE_KEYS = (
    "scope_id", "company_id", "source_id", "hostgroup_id", "hostgroup_name", "created_at",
)


class ScopeSetRequest(BaseModel):
    tenant_id: str | None = None
    source_id: str
    entries: list[dict]  # [{hostgroup_id, hostgroup_name}]


@router.get("/{company_id}/scope")
async def list_scope(
    company_id: str, request: Request, tenant_id: str | None = None
) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.client_companies WHERE company_id = %s AND tenant_id = %s",
            (company_id, tenant),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="company not found")
        cur = await conn.execute(
            """
            SELECT scope_id, company_id, source_id, hostgroup_id, hostgroup_name, created_at
              FROM monitoring.company_hostgroup_scope
             WHERE company_id = %s AND tenant_id = %s
             ORDER BY source_id, hostgroup_name
            """,
            (company_id, tenant),
        )
        rows = await cur.fetchall()
    return [
        {k: (v.isoformat() if hasattr(v, "isoformat") else v)
         for k, v in zip(_SCOPE_KEYS, r)}
        for r in rows
    ]


@router.put("/{company_id}/scope", status_code=200)
async def set_scope(
    company_id: str, body: ScopeSetRequest, request: Request
) -> dict:
    """Replace all scope entries for one source within a company (per-source idempotent)."""
    tenant = _authoritative_tenant(request, body.tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.client_companies WHERE company_id = %s AND tenant_id = %s",
            (company_id, tenant),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="company not found")
        # Delete existing scope for this source only
        await conn.execute(
            """
            DELETE FROM monitoring.company_hostgroup_scope
             WHERE company_id = %s AND tenant_id = %s AND source_id = %s
            """,
            (company_id, tenant, body.source_id),
        )
        # Insert new entries
        for entry in body.entries:
            scope_id = f"scope-{secrets.token_urlsafe(10)}"
            await conn.execute(
                """
                INSERT INTO monitoring.company_hostgroup_scope
                    (scope_id, company_id, tenant_id, source_id, hostgroup_id, hostgroup_name)
                VALUES (%s, %s, %s, %s, %s, %s)
                ON CONFLICT (tenant_id, source_id, hostgroup_id) DO NOTHING
                """,
                (
                    scope_id, company_id, tenant, body.source_id,
                    entry["hostgroup_id"],
                    entry.get("hostgroup_name", f"Grupo #{entry['hostgroup_id']}"),
                ),
            )
        ctx = _ctx(request)
        await record_audit_event(
            conn, tenant,
            action="company.scope.set",
            actor_kind="principal",
            actor_id=ctx.get("principal_id"),
            subject_type="client_company",
            subject_id=company_id,
            detail={"source_id": body.source_id, "entries": len(body.entries)},
            correlation_id=ctx.get("correlation_id"),
        )
        await conn.commit()
    return {"company_id": company_id, "source_id": body.source_id, "entries": len(body.entries)}


@router.delete("/{company_id}/scope/{scope_id}", status_code=200)
async def remove_scope_entry(
    company_id: str, scope_id: str, request: Request, tenant_id: str | None = None
) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            DELETE FROM monitoring.company_hostgroup_scope
             WHERE scope_id = %s AND company_id = %s AND tenant_id = %s
             RETURNING scope_id
            """,
            (scope_id, company_id, tenant),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="scope entry not found")
        await conn.commit()
    return {"deleted": True}


# ---------------------------------------------------------------------------
# Company memberships
# ---------------------------------------------------------------------------


class MembershipCreateRequest(BaseModel):
    tenant_id: str | None = None
    principal_id: str
    role: str = "viewer"


_MEMBERSHIP_KEYS = ("membership_id", "company_id", "tenant_id", "principal_id", "role", "created_at")


@router.get("/{company_id}/members")
async def list_members(
    company_id: str, request: Request, tenant_id: str | None = None
) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT cm.membership_id, cm.company_id, cm.tenant_id, cm.principal_id,
                   cm.role, cm.created_at,
                   p.display_name, p.email
              FROM g1.company_memberships cm
              JOIN g1.principals p USING (principal_id)
             WHERE cm.company_id = %s AND cm.tenant_id = %s
             ORDER BY cm.created_at
            """,
            (company_id, tenant),
        )
        rows = await cur.fetchall()
    keys = _MEMBERSHIP_KEYS + ("display_name", "email")
    return [
        {k: (v.isoformat() if hasattr(v, "isoformat") else v)
         for k, v in zip(keys, r)}
        for r in rows
    ]


@router.post("/{company_id}/members", status_code=201)
async def add_member(
    company_id: str, body: MembershipCreateRequest, request: Request
) -> dict:
    tenant = _authoritative_tenant(request, body.tenant_id)
    if body.role not in ("viewer", "operator", "manager"):
        raise HTTPException(status_code=422, detail="role must be viewer|operator|manager")
    membership_id = f"cm-{secrets.token_urlsafe(10)}"
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "SELECT 1 FROM g1.client_companies WHERE company_id = %s AND tenant_id = %s",
            (company_id, tenant),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="company not found")
        try:
            cur = await conn.execute(
                """
                INSERT INTO g1.company_memberships
                    (membership_id, company_id, tenant_id, principal_id, role)
                VALUES (%s, %s, %s, %s, %s)
                RETURNING membership_id, company_id, tenant_id, principal_id, role, created_at
                """,
                (membership_id, company_id, tenant, body.principal_id, body.role),
            )
            row = await cur.fetchone()
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(status_code=409, detail="principal already a member")
            if "foreign" in str(exc).lower():
                raise HTTPException(status_code=422, detail="principal not found")
            raise
        ctx = _ctx(request)
        await record_audit_event(
            conn, tenant,
            action="company.member.added",
            actor_kind="principal",
            actor_id=ctx.get("principal_id"),
            subject_type="client_company",
            subject_id=company_id,
            detail={"principal_id": body.principal_id, "role": body.role},
            correlation_id=ctx.get("correlation_id"),
        )
        await conn.commit()
    return {k: (v.isoformat() if hasattr(v, "isoformat") else v)
            for k, v in zip(_MEMBERSHIP_KEYS, row)}


@router.delete("/{company_id}/members/{membership_id}", status_code=200)
async def remove_member(
    company_id: str, membership_id: str, request: Request, tenant_id: str | None = None
) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            DELETE FROM g1.company_memberships
             WHERE membership_id = %s AND company_id = %s AND tenant_id = %s
             RETURNING membership_id
            """,
            (membership_id, company_id, tenant),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="membership not found")
        await conn.commit()
    return {"deleted": True}
