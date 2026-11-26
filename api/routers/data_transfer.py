from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel
from typing import Optional
from uuid import UUID
import json

from shared.auth import _require_operate, _require_ctx
from shared.db import db_connection
from shared.audit import record_audit_event

router = APIRouter(prefix="/data-transfer", tags=["data-transfer"])

ENTITY_TYPES = [
    "devices", "users", "alerts", "monitors", "services",
    "vulnerabilities", "assets", "patches", "discovery_results",
]

FORMATS = ["csv", "xlsx", "json"]


# ── Pydantic models ──────────────────────────────────────────────────────────

class TemplateCreate(BaseModel):
    name: str
    entity_type: str
    columns: list = []
    filters: dict = {}
    format: str = "csv"


class ExportCreate(BaseModel):
    entity_type: str
    format: str = "csv"
    columns: list = []
    filters: dict = {}
    template_id: Optional[str] = None


class ExportWorkerUpdate(BaseModel):
    status: str
    row_count: Optional[int] = None
    file_size_bytes: Optional[int] = None
    file_key: Optional[str] = None
    error_message: Optional[str] = None


class ImportCreate(BaseModel):
    entity_type: str
    format: str = "csv"
    file_name: str
    file_size_bytes: Optional[int] = None
    file_key: Optional[str] = None
    mapping: dict = {}


class ImportWorkerUpdate(BaseModel):
    status: str
    row_count: Optional[int] = None
    imported_count: Optional[int] = None
    error_count: Optional[int] = None
    errors: list = []
    error_message: Optional[str] = None


# ── Templates ─────────────────────────────────────────────────────────────────

@router.get("/templates")
async def list_templates(request: Request):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT t.*, u.full_name AS created_by_name
            FROM g1.export_template t
            LEFT JOIN g1.user_account u ON u.id = t.created_by
            WHERE t.tenant_id = $1
            ORDER BY t.name
            """,
            tid,
        )
    return [dict(r) for r in rows]


@router.post("/templates", status_code=201)
async def create_template(request: Request, body: TemplateCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    if body.entity_type not in ENTITY_TYPES:
        raise HTTPException(400, f"entity_type inválido: {body.entity_type}")
    if body.format not in FORMATS:
        raise HTTPException(400, f"format inválido: {body.format}")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO g1.export_template
                (tenant_id, name, entity_type, columns, filters, format, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING *
            """,
            tid, body.name, body.entity_type,
            json.dumps(body.columns), json.dumps(body.filters),
            body.format, actor,
        )
        await record_audit_event(conn, tid, actor, "export_template.create", row["id"], {"name": body.name})
    return dict(row)


@router.get("/templates/{template_id}")
async def get_template(request: Request, template_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM g1.export_template WHERE id=$1 AND tenant_id=$2",
            template_id, tid,
        )
    if not row:
        raise HTTPException(404, "template não encontrado")
    return dict(row)


@router.put("/templates/{template_id}")
async def update_template(request: Request, template_id: UUID, body: TemplateCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.export_template
            SET name=$3, entity_type=$4, columns=$5, filters=$6, format=$7, updated_at=NOW()
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            template_id, tid, body.name, body.entity_type,
            json.dumps(body.columns), json.dumps(body.filters), body.format,
        )
    if not row:
        raise HTTPException(404, "template não encontrado")
    return dict(row)


@router.delete("/templates/{template_id}", status_code=204)
async def delete_template(request: Request, template_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        result = await conn.execute(
            "DELETE FROM g1.export_template WHERE id=$1 AND tenant_id=$2",
            template_id, tid,
        )
    if result == "DELETE 0":
        raise HTTPException(404, "template não encontrado")


# ── Export jobs ───────────────────────────────────────────────────────────────

@router.get("/exports")
async def list_exports(
    request: Request,
    status: Optional[str] = None,
    entity_type: Optional[str] = None,
    limit: int = 50,
):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    where = ["j.tenant_id=$1"]
    vals: list = [tid]
    n = 2
    if status:
        where.append(f"j.status=${ n}")
        vals.append(status)
        n += 1
    if entity_type:
        where.append(f"j.entity_type=${n}")
        vals.append(entity_type)
        n += 1
    vals.append(limit)
    async with db_connection() as conn:
        rows = await conn.fetch(
            f"""
            SELECT j.*, t.name AS template_name, u.full_name AS created_by_name
            FROM g1.export_job j
            LEFT JOIN g1.export_template t ON t.id = j.template_id
            LEFT JOIN g1.user_account u ON u.id = j.created_by
            WHERE {' AND '.join(where)}
            ORDER BY j.created_at DESC
            LIMIT ${n}
            """,
            *vals,
        )
    return [dict(r) for r in rows]


@router.post("/exports", status_code=201)
async def create_export(request: Request, body: ExportCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    if body.entity_type not in ENTITY_TYPES:
        raise HTTPException(400, f"entity_type inválido: {body.entity_type}")
    if body.format not in FORMATS:
        raise HTTPException(400, f"format inválido: {body.format}")

    columns = body.columns
    filters = body.filters
    template_id = None

    if body.template_id:
        async with db_connection() as conn:
            tmpl = await conn.fetchrow(
                "SELECT * FROM g1.export_template WHERE id=$1 AND tenant_id=$2",
                body.template_id, tid,
            )
            if not tmpl:
                raise HTTPException(404, "template não encontrado")
            template_id = tmpl["id"]
            if not columns:
                columns = tmpl["columns"]
            if not filters:
                filters = tmpl["filters"]

    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO g1.export_job
                (tenant_id, template_id, entity_type, format, filters, columns, status, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,'pending',$7)
            RETURNING *
            """,
            tid, template_id, body.entity_type, body.format,
            json.dumps(filters), json.dumps(columns), actor,
        )
        await record_audit_event(conn, tid, actor, "export_job.create", row["id"],
                                 {"entity_type": body.entity_type, "format": body.format})
    return dict(row)


@router.get("/exports/{job_id}")
async def get_export(request: Request, job_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT j.*, t.name AS template_name, u.full_name AS created_by_name
            FROM g1.export_job j
            LEFT JOIN g1.export_template t ON t.id = j.template_id
            LEFT JOIN g1.user_account u ON u.id = j.created_by
            WHERE j.id=$1 AND j.tenant_id=$2
            """,
            job_id, tid,
        )
    if not row:
        raise HTTPException(404, "export não encontrado")
    return dict(row)


@router.put("/exports/{job_id}")
async def update_export(request: Request, job_id: UUID, body: ExportWorkerUpdate):
    """Worker: atualiza status do export job."""
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    valid = {"running", "completed", "failed"}
    if body.status not in valid:
        raise HTTPException(400, f"status inválido: {body.status}")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.export_job SET
                status=$3,
                row_count=COALESCE($4, row_count),
                file_size_bytes=COALESCE($5, file_size_bytes),
                file_key=COALESCE($6, file_key),
                error_message=COALESCE($7, error_message),
                started_at=CASE WHEN $3='running' AND started_at IS NULL THEN NOW() ELSE started_at END,
                completed_at=CASE WHEN $3 IN ('completed','failed') THEN NOW() ELSE completed_at END
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            job_id, tid, body.status,
            body.row_count, body.file_size_bytes, body.file_key, body.error_message,
        )
    if not row:
        raise HTTPException(404, "export não encontrado")
    return dict(row)


# ── Import jobs ───────────────────────────────────────────────────────────────

@router.get("/imports")
async def list_imports(
    request: Request,
    status: Optional[str] = None,
    entity_type: Optional[str] = None,
    limit: int = 50,
):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    where = ["j.tenant_id=$1"]
    vals: list = [tid]
    n = 2
    if status:
        where.append(f"j.status=${n}")
        vals.append(status)
        n += 1
    if entity_type:
        where.append(f"j.entity_type=${n}")
        vals.append(entity_type)
        n += 1
    vals.append(limit)
    async with db_connection() as conn:
        rows = await conn.fetch(
            f"""
            SELECT j.*, u.full_name AS created_by_name
            FROM g1.import_job j
            LEFT JOIN g1.user_account u ON u.id = j.created_by
            WHERE {' AND '.join(where)}
            ORDER BY j.created_at DESC
            LIMIT ${n}
            """,
            *vals,
        )
    return [dict(r) for r in rows]


@router.post("/imports", status_code=201)
async def create_import(request: Request, body: ImportCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    if body.entity_type not in ENTITY_TYPES:
        raise HTTPException(400, f"entity_type inválido: {body.entity_type}")
    if body.format not in FORMATS:
        raise HTTPException(400, f"format inválido: {body.format}")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO g1.import_job
                (tenant_id, entity_type, format, file_name, file_size_bytes,
                 file_key, mapping, status, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,'pending',$8)
            RETURNING *
            """,
            tid, body.entity_type, body.format, body.file_name,
            body.file_size_bytes, body.file_key,
            json.dumps(body.mapping), actor,
        )
        await record_audit_event(conn, tid, actor, "import_job.create", row["id"],
                                 {"entity_type": body.entity_type, "file_name": body.file_name})
    return dict(row)


@router.get("/imports/{job_id}")
async def get_import(request: Request, job_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT j.*, u.full_name AS created_by_name
            FROM g1.import_job j
            LEFT JOIN g1.user_account u ON u.id = j.created_by
            WHERE j.id=$1 AND j.tenant_id=$2
            """,
            job_id, tid,
        )
    if not row:
        raise HTTPException(404, "import não encontrado")
    return dict(row)


@router.put("/imports/{job_id}")
async def update_import(request: Request, job_id: UUID, body: ImportWorkerUpdate):
    """Worker: atualiza status do import job."""
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    valid = {"validating", "importing", "completed", "failed", "cancelled"}
    if body.status not in valid:
        raise HTTPException(400, f"status inválido: {body.status}")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.import_job SET
                status=$3,
                row_count=COALESCE($4, row_count),
                imported_count=COALESCE($5, imported_count),
                error_count=COALESCE($6, error_count),
                errors=COALESCE($7::jsonb, errors),
                error_message=COALESCE($8, error_message),
                started_at=CASE WHEN $3='validating' AND started_at IS NULL THEN NOW() ELSE started_at END,
                completed_at=CASE WHEN $3 IN ('completed','failed','cancelled') THEN NOW() ELSE completed_at END
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            job_id, tid, body.status,
            body.row_count, body.imported_count, body.error_count,
            json.dumps(body.errors) if body.errors else None,
            body.error_message,
        )
    if not row:
        raise HTTPException(404, "import não encontrado")
    return dict(row)


@router.post("/imports/{job_id}/confirm", status_code=200)
async def confirm_import(request: Request, job_id: UUID):
    """Move import de 'validating' → 'importing'."""
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.import_job SET status='importing'
            WHERE id=$1 AND tenant_id=$2 AND status='validating'
            RETURNING *
            """,
            job_id, tid,
        )
        if not row:
            raise HTTPException(409, "import não está no estado 'validating'")
        await record_audit_event(conn, tid, actor, "import_job.confirm", job_id, {})
    return dict(row)


@router.post("/imports/{job_id}/cancel", status_code=200)
async def cancel_import(request: Request, job_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.import_job SET status='cancelled', completed_at=NOW()
            WHERE id=$1 AND tenant_id=$2 AND status IN ('pending','validating')
            RETURNING *
            """,
            job_id, tid,
        )
        if not row:
            raise HTTPException(409, "import não pode ser cancelado neste estado")
        await record_audit_event(conn, tid, actor, "import_job.cancel", job_id, {})
    return dict(row)


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def get_stats(request: Request):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                (SELECT COUNT(*) FROM g1.export_job WHERE tenant_id=$1 AND status='pending') AS pending_exports,
                (SELECT COUNT(*) FROM g1.export_job WHERE tenant_id=$1 AND status='running') AS running_exports,
                (SELECT COUNT(*) FROM g1.export_job WHERE tenant_id=$1 AND status='completed') AS completed_exports,
                (SELECT COUNT(*) FROM g1.export_job WHERE tenant_id=$1 AND status='failed') AS failed_exports,
                (SELECT COUNT(*) FROM g1.import_job WHERE tenant_id=$1 AND status IN ('pending','validating','importing')) AS active_imports,
                (SELECT COUNT(*) FROM g1.export_template WHERE tenant_id=$1) AS total_templates
            """,
            tid,
        )
    return dict(row)
