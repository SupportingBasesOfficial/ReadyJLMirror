from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.auth import _require_operate, _require_ctx
from shared.db import db_connection
from shared.audit import record_audit_event

router = APIRouter(prefix="/patches", tags=["patches"])

SEVERITIES = ["critical", "high", "medium", "low", "info"]
PATCH_STATUSES = ["available", "approved", "rejected", "installing", "installed", "failed", "skipped"]
JOB_STATUSES = ["pending", "running", "completed", "failed", "cancelled"]


# ── Models ────────────────────────────────────────────────────────────────────

class ScanCreate(BaseModel):
    target_host: str
    target_type: str = "host"


class ScanWorkerUpdate(BaseModel):
    status: str
    patch_count: Optional[int] = None
    critical_count: Optional[int] = None
    error_message: Optional[str] = None


class PatchIngest(BaseModel):
    package_name: str
    current_version: Optional[str] = None
    available_version: str
    severity: str = "medium"
    category: Optional[str] = None
    cve_ids: list[str] = []
    description: Optional[str] = None
    requires_reboot: bool = False


class BulkIngest(BaseModel):
    scan_id: str
    target_host: str
    patches: list[PatchIngest]


class BulkApprove(BaseModel):
    patch_ids: list[str]


class JobCreate(BaseModel):
    target_host: str
    patch_ids: list[str]
    allow_reboot: bool = False
    scheduled_at: Optional[str] = None


class JobWorkerUpdate(BaseModel):
    status: str
    output: Optional[str] = None
    error_message: Optional[str] = None
    installed_count: Optional[int] = None
    failed_count: Optional[int] = None


# ── Scans ─────────────────────────────────────────────────────────────────────

@router.get("/scans")
async def list_scans(request: Request, limit: int = 100):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT s.*,
                   u.full_name AS initiated_by_name
            FROM g1.patch_scan s
            LEFT JOIN g1.user_account u ON u.id = s.initiated_by
            WHERE s.tenant_id = $1
            ORDER BY s.created_at DESC
            LIMIT $2
            """,
            tid, limit,
        )
    return [dict(r) for r in rows]


@router.post("/scans", status_code=201)
async def create_scan(request: Request, body: ScanCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    if body.target_type not in ("host", "device_group", "all"):
        raise HTTPException(400, "target_type inválido")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            INSERT INTO g1.patch_scan
                (tenant_id, target_host, target_type, initiated_by)
            VALUES ($1,$2,$3,$4)
            RETURNING *
            """,
            tid, body.target_host, body.target_type, actor,
        )
        await record_audit_event(conn, tid, actor, "patch_scan.create", row["id"],
                                 {"host": body.target_host})
    return dict(row)


@router.get("/scans/{scan_id}")
async def get_scan(request: Request, scan_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM g1.patch_scan WHERE id=$1 AND tenant_id=$2",
            scan_id, tid,
        )
    if not row:
        raise HTTPException(404, "scan não encontrado")
    return dict(row)


@router.put("/scans/{scan_id}")
async def update_scan_worker(request: Request, scan_id: UUID, body: ScanWorkerUpdate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    if body.status not in ("running", "completed", "failed"):
        raise HTTPException(400, "status inválido")
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.patch_scan SET
                status        = $3,
                patch_count   = COALESCE($4, patch_count),
                critical_count= COALESCE($5, critical_count),
                error_message = COALESCE($6, error_message),
                started_at    = CASE WHEN $3='running'   AND started_at IS NULL THEN NOW() ELSE started_at END,
                completed_at  = CASE WHEN $3 IN ('completed','failed') THEN NOW() ELSE completed_at END
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            scan_id, tid, body.status, body.patch_count,
            body.critical_count, body.error_message,
        )
    if not row:
        raise HTTPException(404, "scan não encontrado")
    return dict(row)


# ── Patches ───────────────────────────────────────────────────────────────────

@router.get("/")
async def list_patches(
    request: Request,
    host: Optional[str] = None,
    severity: Optional[str] = None,
    status: Optional[str] = None,
    requires_reboot: Optional[bool] = None,
    limit: int = 200,
):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    where = ["p.tenant_id=$1"]
    vals: list = [tid]
    n = 2
    if host:
        where.append(f"p.target_host=${ n}"); vals.append(host); n += 1
    if severity:
        where.append(f"p.severity=${n}"); vals.append(severity); n += 1
    if status:
        where.append(f"p.status=${n}"); vals.append(status); n += 1
    if requires_reboot is not None:
        where.append(f"p.requires_reboot=${n}"); vals.append(requires_reboot); n += 1
    vals.append(limit)
    async with db_connection() as conn:
        rows = await conn.fetch(
            f"""
            SELECT p.*,
                   u.full_name AS approved_by_name
            FROM g1.patch p
            LEFT JOIN g1.user_account u ON u.id = p.approved_by
            WHERE {' AND '.join(where)}
            ORDER BY
                CASE p.severity
                    WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                    WHEN 'medium' THEN 3 WHEN 'low' THEN 4 ELSE 5
                END,
                p.created_at DESC
            LIMIT ${n}
            """,
            *vals,
        )
    return [dict(r) for r in rows]


@router.post("/bulk-ingest", status_code=201)
async def bulk_ingest(request: Request, body: BulkIngest):
    """Worker ingests patches found during a scan."""
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    inserted = 0
    async with db_connection() as conn:
        scan = await conn.fetchrow(
            "SELECT id FROM g1.patch_scan WHERE id=$1 AND tenant_id=$2",
            body.scan_id, tid,
        )
        if not scan:
            raise HTTPException(404, "scan não encontrado")
        for p in body.patches:
            if p.severity not in SEVERITIES:
                continue
            await conn.execute(
                """
                INSERT INTO g1.patch
                    (tenant_id, scan_id, target_host, package_name,
                     current_version, available_version, severity, category,
                     cve_ids, description, requires_reboot)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
                ON CONFLICT DO NOTHING
                """,
                tid, body.scan_id, body.target_host, p.package_name,
                p.current_version, p.available_version, p.severity, p.category,
                p.cve_ids, p.description, p.requires_reboot,
            )
            inserted += 1
    return {"inserted": inserted}


@router.get("/{patch_id}")
async def get_patch(request: Request, patch_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM g1.patch WHERE id=$1 AND tenant_id=$2",
            patch_id, tid,
        )
    if not row:
        raise HTTPException(404, "patch não encontrado")
    return dict(row)


@router.post("/{patch_id}/approve")
async def approve_patch(request: Request, patch_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.patch SET
                status      = 'approved',
                approved_by = $3,
                approved_at = NOW(),
                updated_at  = NOW()
            WHERE id=$1 AND tenant_id=$2 AND status='available'
            RETURNING *
            """,
            patch_id, tid, actor,
        )
        if not row:
            raise HTTPException(404, "patch não encontrado ou não está disponível")
        await record_audit_event(conn, tid, actor, "patch.approve", patch_id, {})
    return dict(row)


@router.post("/{patch_id}/reject")
async def reject_patch(request: Request, patch_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            UPDATE g1.patch SET
                status     = 'rejected',
                updated_at = NOW()
            WHERE id=$1 AND tenant_id=$2 AND status IN ('available', 'approved')
            RETURNING *
            """,
            patch_id, tid,
        )
        if not row:
            raise HTTPException(404, "patch não encontrado")
        await record_audit_event(conn, tid, actor, "patch.reject", patch_id, {})
    return dict(row)


@router.post("/bulk-approve")
async def bulk_approve(request: Request, body: BulkApprove):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    if not body.patch_ids:
        raise HTTPException(400, "patch_ids obrigatório")
    ids = [UUID(pid) for pid in body.patch_ids]
    async with db_connection() as conn:
        result = await conn.execute(
            """
            UPDATE g1.patch SET
                status      = 'approved',
                approved_by = $2,
                approved_at = NOW(),
                updated_at  = NOW()
            WHERE tenant_id=$1 AND id = ANY($3) AND status='available'
            """,
            tid, actor, ids,
        )
        count = int(result.split()[-1])
        await record_audit_event(conn, tid, actor, "patch.bulk_approve", None,
                                 {"count": count, "ids": body.patch_ids})
    return {"approved": count}


# ── Jobs ──────────────────────────────────────────────────────────────────────

@router.get("/jobs")
async def list_jobs(request: Request, limit: int = 100):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT j.*,
                   u.full_name AS created_by_name
            FROM g1.patch_job j
            LEFT JOIN g1.user_account u ON u.id = j.created_by
            WHERE j.tenant_id = $1
            ORDER BY j.created_at DESC
            LIMIT $2
            """,
            tid, limit,
        )
    return [dict(r) for r in rows]


@router.post("/jobs", status_code=201)
async def create_job(request: Request, body: JobCreate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    if not body.patch_ids:
        raise HTTPException(400, "patch_ids obrigatório")
    ids = [UUID(pid) for pid in body.patch_ids]
    async with db_connection() as conn:
        approved = await conn.fetchval(
            "SELECT COUNT(*) FROM g1.patch WHERE tenant_id=$1 AND id=ANY($2) AND status='approved'",
            tid, ids,
        )
        if approved != len(ids):
            raise HTTPException(400, "todos os patches precisam estar com status approved")
        row = await conn.fetchrow(
            """
            INSERT INTO g1.patch_job
                (tenant_id, target_host, patch_ids, allow_reboot, scheduled_at, created_by)
            VALUES ($1,$2,$3,$4,$5::timestamptz,$6)
            RETURNING *
            """,
            tid, body.target_host, ids, body.allow_reboot,
            body.scheduled_at, actor,
        )
        await conn.execute(
            "UPDATE g1.patch SET status='installing', updated_at=NOW() WHERE tenant_id=$1 AND id=ANY($2)",
            tid, ids,
        )
        await record_audit_event(conn, tid, actor, "patch_job.create", row["id"],
                                 {"host": body.target_host, "count": len(ids)})
    return dict(row)


@router.get("/jobs/{job_id}")
async def get_job(request: Request, job_id: UUID):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            "SELECT * FROM g1.patch_job WHERE id=$1 AND tenant_id=$2",
            job_id, tid,
        )
    if not row:
        raise HTTPException(404, "job não encontrado")
    return dict(row)


@router.put("/jobs/{job_id}")
async def update_job_worker(request: Request, job_id: UUID, body: JobWorkerUpdate):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    if body.status not in JOB_STATUSES:
        raise HTTPException(400, "status inválido")
    async with db_connection() as conn:
        job = await conn.fetchrow(
            "SELECT patch_ids FROM g1.patch_job WHERE id=$1 AND tenant_id=$2",
            job_id, tid,
        )
        if not job:
            raise HTTPException(404, "job não encontrado")
        row = await conn.fetchrow(
            """
            UPDATE g1.patch_job SET
                status          = $3,
                output          = COALESCE($4, output),
                error_message   = COALESCE($5, error_message),
                installed_count = COALESCE($6, installed_count),
                failed_count    = COALESCE($7, failed_count),
                started_at      = CASE WHEN $3='running' AND started_at IS NULL THEN NOW() ELSE started_at END,
                completed_at    = CASE WHEN $3 IN ('completed','failed','cancelled') THEN NOW() ELSE completed_at END
            WHERE id=$1 AND tenant_id=$2
            RETURNING *
            """,
            job_id, tid, body.status, body.output, body.error_message,
            body.installed_count, body.failed_count,
        )
        if body.status == "completed":
            await conn.execute(
                "UPDATE g1.patch SET status='installed', updated_at=NOW() WHERE tenant_id=$1 AND id=ANY($2)",
                tid, job["patch_ids"],
            )
        elif body.status == "failed":
            await conn.execute(
                "UPDATE g1.patch SET status='failed', updated_at=NOW() WHERE tenant_id=$1 AND id=ANY($2)",
                tid, job["patch_ids"],
            )
    return dict(row)


@router.post("/jobs/{job_id}/cancel", status_code=204)
async def cancel_job(request: Request, job_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]
    async with db_connection() as conn:
        job = await conn.fetchrow(
            "SELECT patch_ids FROM g1.patch_job WHERE id=$1 AND tenant_id=$2 AND status IN ('pending','running')",
            job_id, tid,
        )
        if not job:
            raise HTTPException(404, "job não encontrado ou não pode ser cancelado")
        await conn.execute(
            "UPDATE g1.patch_job SET status='cancelled', completed_at=NOW() WHERE id=$1",
            job_id,
        )
        await conn.execute(
            "UPDATE g1.patch SET status='approved', updated_at=NOW() WHERE tenant_id=$1 AND id=ANY($2) AND status='installing'",
            tid, job["patch_ids"],
        )
        await record_audit_event(conn, tid, actor, "patch_job.cancel", job_id, {})


# ── Stats ─────────────────────────────────────────────────────────────────────

@router.get("/stats")
async def get_stats(request: Request):
    ctx = _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        row = await conn.fetchrow(
            """
            SELECT
                (SELECT COUNT(*) FROM g1.patch WHERE tenant_id=$1 AND status='available') AS available_count,
                (SELECT COUNT(*) FROM g1.patch WHERE tenant_id=$1 AND severity='critical' AND status='available') AS critical_available,
                (SELECT COUNT(*) FROM g1.patch WHERE tenant_id=$1 AND status='approved') AS approved_count,
                (SELECT COUNT(*) FROM g1.patch WHERE tenant_id=$1 AND status='installed') AS installed_count,
                (SELECT COUNT(*) FROM g1.patch_scan WHERE tenant_id=$1) AS total_scans,
                (SELECT COUNT(*) FROM g1.patch_job WHERE tenant_id=$1 AND status IN ('pending','running')) AS active_jobs
            """,
            tid,
        )
    return dict(row)
