"""G36 Knowledge Base API — categories, articles, full-text search, incident links."""

from __future__ import annotations

import re
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, status
from fastapi.responses import Response
from pydantic import BaseModel

from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/kb", tags=["kb"])


def _require_tenant(request: Request) -> str:
    tid = request.state.jlmirror_context.get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


def _require_principal(request: Request) -> str:
    return request.state.jlmirror_context.get("principal_id", "system")


def _slugify(name: str) -> str:
    slug = name.lower().strip()
    slug = re.sub(r"[^a-z0-9]+", "-", slug)
    return slug[:80].strip("-") or "category"


# ── Categories ─────────────────────────────────────────────────────────────


class CreateCategory(BaseModel):
    name: str
    parent_id: Optional[str] = None


@router.get("/categories")
async def list_categories(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT category_id, name, parent_id, slug, created_at
              FROM g1.kb_category
             WHERE tenant_id = %s
             ORDER BY name
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.post("/categories", status_code=status.HTTP_201_CREATED)
async def create_category(request: Request, body: CreateCategory) -> dict:
    tenant_id = _require_tenant(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if len(name) > 120:
        raise HTTPException(status_code=422, detail="name max 120 chars")

    slug = _slugify(name)
    category_id = f"kbc:{uuid.uuid4()}"

    async with db_tenant_connection(tenant_id) as conn:
        if body.parent_id:
            row = await conn.execute(
                "SELECT category_id FROM g1.kb_category "
                "WHERE tenant_id=%s AND category_id=%s",
                (tenant_id, body.parent_id),
            )
            if await row.fetchone() is None:
                raise HTTPException(status_code=404, detail="parent category not found")

        try:
            await conn.execute(
                """
                INSERT INTO g1.kb_category (category_id, tenant_id, name, parent_id, slug)
                VALUES (%s, %s, %s, %s, %s)
                """,
                (category_id, tenant_id, name, body.parent_id, slug),
            )
            await conn.commit()
        except Exception as exc:
            await conn.rollback()
            if "unique" in str(exc).lower():
                raise HTTPException(status_code=409, detail=f"slug '{slug}' already exists")
            raise
    return {"category_id": category_id, "name": name, "slug": slug}


@router.delete("/categories/{category_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_category(request: Request, category_id: str) -> Response:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT category_id FROM g1.kb_category "
            "WHERE tenant_id=%s AND category_id=%s",
            (tenant_id, category_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="category not found")
        await conn.execute(
            "DELETE FROM g1.kb_category WHERE category_id=%s", (category_id,)
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Articles ───────────────────────────────────────────────────────────────


class CreateArticle(BaseModel):
    title: str
    body: str = ""
    category_id: Optional[str] = None
    status: str = "draft"
    tags: list[str] = []


class UpdateArticle(BaseModel):
    title: Optional[str] = None
    body: Optional[str] = None
    category_id: Optional[str] = None
    status: Optional[str] = None
    tags: Optional[list[str]] = None


@router.get("/articles")
async def list_articles(
    request: Request,
    q: Optional[str] = Query(None, description="full-text search query"),
    category_id: Optional[str] = Query(None),
    article_status: Optional[str] = Query(None, alias="status"),
) -> list:
    tenant_id = _require_tenant(request)
    conditions = ["a.tenant_id = %s"]
    params: list = [tenant_id]

    if category_id:
        conditions.append("a.category_id = %s")
        params.append(category_id)

    if article_status:
        conditions.append("a.status = %s")
        params.append(article_status)

    if q and q.strip():
        conditions.append(
            "("
            "setweight(to_tsvector('english', coalesce(a.title,'')), 'A') || "
            "setweight(to_tsvector('english', coalesce(a.body,'')), 'B')"
            ") @@ plainto_tsquery('english', %s)"
        )
        params.append(q.strip())

    where = " AND ".join(conditions)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            f"""
            SELECT a.article_id, a.title, a.status, a.category_id,
                   c.name AS category_name, a.tags, a.created_by,
                   a.created_at, a.updated_at,
                   length(a.body) AS body_length
              FROM g1.kb_article a
              LEFT JOIN g1.kb_category c ON c.category_id = a.category_id
             WHERE {where}
             ORDER BY a.updated_at DESC
             LIMIT 200
            """,
            params,
        )
        cols = [d[0] for d in rows.description]
        return [dict(zip(cols, r)) for r in await rows.fetchall()]


@router.get("/articles/{article_id}")
async def get_article(request: Request, article_id: str) -> dict:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        rows = await conn.execute(
            """
            SELECT a.article_id, a.title, a.body, a.status, a.category_id,
                   c.name AS category_name, a.tags, a.created_by,
                   a.created_at, a.updated_at
              FROM g1.kb_article a
              LEFT JOIN g1.kb_category c ON c.category_id = a.category_id
             WHERE a.tenant_id = %s AND a.article_id = %s
            """,
            (tenant_id, article_id),
        )
        row = await rows.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="article not found")
        cols = [d[0] for d in rows.description]
        article = dict(zip(cols, row))

        # Fetch linked incidents
        inc_rows = await conn.execute(
            """
            SELECT incident_id, linked_by, linked_at
              FROM g1.kb_article_incident
             WHERE article_id = %s
             ORDER BY linked_at DESC
            """,
            (article_id,),
        )
        inc_cols = [d[0] for d in inc_rows.description]
        article["incidents"] = [dict(zip(inc_cols, r)) for r in await inc_rows.fetchall()]

    return article


@router.post("/articles", status_code=status.HTTP_201_CREATED)
async def create_article(request: Request, body: CreateArticle) -> dict:
    tenant_id = _require_tenant(request)
    principal_id = _require_principal(request)

    title = body.title.strip()
    if not title:
        raise HTTPException(status_code=422, detail="title is required")
    if len(title) > 400:
        raise HTTPException(status_code=422, detail="title max 400 chars")
    if body.status not in ("draft", "published", "archived"):
        raise HTTPException(status_code=422, detail="status must be draft/published/archived")

    article_id = f"kba:{uuid.uuid4()}"
    async with db_tenant_connection(tenant_id) as conn:
        if body.category_id:
            row = await conn.execute(
                "SELECT category_id FROM g1.kb_category "
                "WHERE tenant_id=%s AND category_id=%s",
                (tenant_id, body.category_id),
            )
            if await row.fetchone() is None:
                raise HTTPException(status_code=404, detail="category not found")

        await conn.execute(
            """
            INSERT INTO g1.kb_article
                (article_id, tenant_id, category_id, title, body,
                 status, tags, created_by)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                article_id, tenant_id, body.category_id, title, body.body,
                body.status, body.tags, principal_id,
            ),
        )
        await conn.commit()
    return {"article_id": article_id, "title": title}


@router.put("/articles/{article_id}")
async def update_article(
    request: Request, article_id: str, body: UpdateArticle
) -> dict:
    tenant_id = _require_tenant(request)
    if body.status and body.status not in ("draft", "published", "archived"):
        raise HTTPException(status_code=422, detail="invalid status")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT article_id FROM g1.kb_article "
            "WHERE tenant_id=%s AND article_id=%s",
            (tenant_id, article_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="article not found")

        fields: list[str] = []
        values: list = []
        if body.title is not None:
            t = body.title.strip()
            if not t:
                raise HTTPException(status_code=422, detail="title cannot be empty")
            fields.append("title = %s")
            values.append(t)
        if body.body is not None:
            fields.append("body = %s")
            values.append(body.body)
        if body.category_id is not None:
            fields.append("category_id = %s")
            values.append(body.category_id or None)
        if body.status is not None:
            fields.append("status = %s")
            values.append(body.status)
        if body.tags is not None:
            fields.append("tags = %s")
            values.append(body.tags)

        if fields:
            fields.append("updated_at = now()")
            values.append(article_id)
            await conn.execute(
                f"UPDATE g1.kb_article SET {', '.join(fields)} "
                "WHERE article_id = %s",
                values,
            )
            await conn.commit()

    return {"article_id": article_id, "updated": True}


@router.delete("/articles/{article_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_article(request: Request, article_id: str) -> Response:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT article_id FROM g1.kb_article "
            "WHERE tenant_id=%s AND article_id=%s",
            (tenant_id, article_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="article not found")
        await conn.execute(
            "DELETE FROM g1.kb_article WHERE article_id=%s", (article_id,)
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


# ── Incident links ─────────────────────────────────────────────────────────


class LinkIncident(BaseModel):
    incident_id: str


@router.post("/articles/{article_id}/incidents", status_code=status.HTTP_201_CREATED)
async def link_incident(
    request: Request, article_id: str, body: LinkIncident
) -> dict:
    tenant_id = _require_tenant(request)
    principal_id = _require_principal(request)

    if not body.incident_id.strip():
        raise HTTPException(status_code=422, detail="incident_id is required")

    async with db_tenant_connection(tenant_id) as conn:
        row = await conn.execute(
            "SELECT article_id FROM g1.kb_article "
            "WHERE tenant_id=%s AND article_id=%s",
            (tenant_id, article_id),
        )
        if await row.fetchone() is None:
            raise HTTPException(status_code=404, detail="article not found")

        try:
            await conn.execute(
                """
                INSERT INTO g1.kb_article_incident
                    (article_id, incident_id, tenant_id, linked_by)
                VALUES (%s, %s, %s, %s)
                """,
                (article_id, body.incident_id.strip(), tenant_id, principal_id),
            )
            await conn.commit()
        except Exception as exc:
            await conn.rollback()
            if "unique" in str(exc).lower() or "duplicate" in str(exc).lower():
                raise HTTPException(status_code=409, detail="incident already linked")
            raise

    return {"article_id": article_id, "incident_id": body.incident_id.strip()}


@router.delete(
    "/articles/{article_id}/incidents/{incident_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def unlink_incident(
    request: Request, article_id: str, incident_id: str
) -> Response:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        await conn.execute(
            "DELETE FROM g1.kb_article_incident "
            "WHERE article_id=%s AND incident_id=%s AND tenant_id=%s",
            (article_id, incident_id, tenant_id),
        )
        await conn.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
