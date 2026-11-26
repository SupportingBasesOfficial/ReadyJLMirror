from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, field_validator
from typing import Optional, List
from datetime import datetime, timezone
import uuid

from shared.auth import _require_operate, _require_ctx
from shared.db import db_connection
from shared.audit import record_audit_event

router = APIRouter(prefix="/api/v1", tags=["backup"])

VALID_TARGET_TYPES = {"local", "s3", "sftp", "nfs", "rsync"}
VALID_STATUSES = {"pending", "running", "success", "failed", "cancelled"}


def _ser(v):
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def _row_to_dict(keys, row):
    return {k: _ser(v) for k, v in zip(keys, row)}


class JobCreate(BaseModel):
    name: str
    description: Optional[str] = None
    schedule_cron: Optional[str] = None
    target_type: str = "local"
    target_path: str = ""
    target_config: dict = {}
    pre_commands: List[str] = []
    post_commands: List[str] = []
    retention_days: int = 30
    max_snapshots: int = 10
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v):
        if not v.strip():
            raise ValueError("name cannot be empty")
        return v.strip()

    @field_validator("target_type")
    @classmethod
    def valid_target_type(cls, v):
        if v not in VALID_TARGET_TYPES:
            raise ValueError(f"target_type must be one of {sorted(VALID_TARGET_TYPES)}")
        return v

    @field_validator("retention_days")
    @classmethod
    def positive_retention(cls, v):
        if v < 1:
            raise ValueError("retention_days must be >= 1")
        return v

    @field_validator("max_snapshots")
    @classmethod
    def positive_max(cls, v):
        if v < 1:
            raise ValueError("max_snapshots must be >= 1")
        return v


class JobUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    schedule_cron: Optional[str] = None
    target_type: Optional[str] = None
    target_path: Optional[str] = None
    target_config: Optional[dict] = None
    pre_commands: Optional[List[str]] = None
    post_commands: Optional[List[str]] = None
    retention_days: Optional[int] = None
    max_snapshots: Optional[int] = None
    enabled: Optional[bool] = None

    @field_validator("target_type")
    @classmethod
    def valid_target_type(cls, v):
        if v is not None and v not in VALID_TARGET_TYPES:
            raise ValueError(f"target_type must be one of {sorted(VALID_TARGET_TYPES)}")
        return v


class SnapshotUpdate(BaseModel):
    status: str
    started_at: Optional[str] = None
    finished_at: Optional[str] = None
    size_bytes: Optional[int] = None
    checksum_sha256: Optional[str] = None
    snapshot_path: Optional[str] = None
    output: Optional[str] = None
    error_message: Optional[str] = None

    @field_validator("status")
    @classmethod
    def valid_status(cls, v):
        if v not in VALID_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_STATUSES)}")
        return v


@router.get("/backup/jobs")
async def list_jobs(request: Request):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        rows = await conn.fetch("""
            SELECT
                j.job_id, j.name, j.description, j.schedule_cron,
                j.target_type, j.target_path,
                j.pre_commands, j.post_commands,
                j.retention_days, j.max_snapshots, j.enabled,
                j.created_at,
                s.snapshot_id AS last_snapshot_id,
                s.status AS last_status,
                s.created_at AS last_snapshot_at,
                s.size_bytes AS last_size_bytes,
                s.finished_at AS last_finished_at
            FROM g1.backup_job j
            LEFT JOIN LATERAL (
                SELECT snapshot_id, status, created_at, size_bytes, finished_at
                FROM g1.backup_snapshot
                WHERE job_id = j.job_id
                ORDER BY created_at DESC
                LIMIT 1
            ) s ON TRUE
            WHERE j.tenant_id = $1
            ORDER BY j.name
        """, tid)
        jobs = {}
        for r in rows:
            jid = str(r["job_id"])
            if jid not in jobs:
                jobs[jid] = {
                    "job_id": jid,
                    "name": r["name"],
                    "description": r["description"],
                    "schedule_cron": r["schedule_cron"],
                    "target_type": r["target_type"],
                    "target_path": r["target_path"],
                    "pre_commands": list(r["pre_commands"] or []),
                    "post_commands": list(r["post_commands"] or []),
                    "retention_days": r["retention_days"],
                    "max_snapshots": r["max_snapshots"],
                    "enabled": r["enabled"],
                    "created_at": _ser(r["created_at"]),
                    "last_snapshot": {
                        "snapshot_id": str(r["last_snapshot_id"]) if r["last_snapshot_id"] else None,
                        "status": r["last_status"],
                        "created_at": _ser(r["last_snapshot_at"]),
                        "size_bytes": r["last_size_bytes"],
                        "finished_at": _ser(r["last_finished_at"]),
                    } if r["last_snapshot_id"] else None,
                }
        return list(jobs.values())
    finally:
        await conn.close()


@router.post("/backup/jobs", status_code=201)
async def create_job(request: Request, body: JobCreate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        row = await conn.fetchrow("""
            INSERT INTO g1.backup_job
                (tenant_id, name, description, schedule_cron, target_type, target_path,
                 target_config, pre_commands, post_commands, retention_days, max_snapshots,
                 enabled, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            RETURNING job_id, name, description, schedule_cron, target_type, target_path,
                      retention_days, max_snapshots, enabled, created_at
        """, tid, body.name, body.description, body.schedule_cron,
            body.target_type, body.target_path,
            body.target_config, body.pre_commands, body.post_commands,
            body.retention_days, body.max_snapshots, body.enabled, actor)
        await record_audit_event(conn, tid, actor, "backup_job.create", str(row["job_id"]), {})
        return dict(row)
    finally:
        await conn.close()


@router.get("/backup/jobs/{job_id}")
async def get_job(request: Request, job_id: str):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        row = await conn.fetchrow(
            "SELECT * FROM g1.backup_job WHERE job_id=$1 AND tenant_id=$2",
            uuid.UUID(job_id), tid
        )
        if not row:
            raise HTTPException(404, "backup job not found")
        d = dict(row)
        d["job_id"] = str(d["job_id"])
        d["created_at"] = _ser(d["created_at"])
        d["pre_commands"] = list(d["pre_commands"] or [])
        d["post_commands"] = list(d["post_commands"] or [])
        d.pop("target_config", None)  # don't expose credentials
        return d
    finally:
        await conn.close()


@router.put("/backup/jobs/{job_id}")
async def update_job(request: Request, job_id: str, body: JobUpdate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        existing = await conn.fetchrow(
            "SELECT job_id FROM g1.backup_job WHERE job_id=$1 AND tenant_id=$2",
            uuid.UUID(job_id), tid
        )
        if not existing:
            raise HTTPException(404, "backup job not found")
        updates = {k: v for k, v in body.model_dump(exclude_none=True).items()}
        if not updates:
            raise HTTPException(400, "no fields to update")
        set_clauses = []
        vals = []
        for i, (k, v) in enumerate(updates.items(), start=1):
            set_clauses.append(f"{k} = ${i}")
            vals.append(v)
        vals.extend([uuid.UUID(job_id), tid])
        await conn.execute(
            f"UPDATE g1.backup_job SET {', '.join(set_clauses)} WHERE job_id=${len(vals)-1} AND tenant_id=${len(vals)}",
            *vals
        )
        await record_audit_event(conn, tid, actor, "backup_job.update", job_id, updates)
        return {"ok": True}
    finally:
        await conn.close()


@router.delete("/backup/jobs/{job_id}", status_code=204)
async def delete_job(request: Request, job_id: str):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        result = await conn.execute(
            "DELETE FROM g1.backup_job WHERE job_id=$1 AND tenant_id=$2",
            uuid.UUID(job_id), tid
        )
        if result == "DELETE 0":
            raise HTTPException(404, "backup job not found")
        await record_audit_event(conn, tid, actor, "backup_job.delete", job_id, {})
    finally:
        await conn.close()


@router.post("/backup/jobs/{job_id}/trigger", status_code=201)
async def trigger_snapshot(request: Request, job_id: str):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        job = await conn.fetchrow(
            "SELECT job_id, enabled FROM g1.backup_job WHERE job_id=$1 AND tenant_id=$2",
            uuid.UUID(job_id), tid
        )
        if not job:
            raise HTTPException(404, "backup job not found")
        row = await conn.fetchrow("""
            INSERT INTO g1.backup_snapshot (job_id, tenant_id, status, triggered_by)
            VALUES ($1, $2, 'pending', $3)
            RETURNING snapshot_id, status, triggered_by, created_at
        """, uuid.UUID(job_id), tid, actor)
        await record_audit_event(conn, tid, actor, "backup_snapshot.trigger", str(row["snapshot_id"]), {"job_id": job_id})
        return {
            "snapshot_id": str(row["snapshot_id"]),
            "status": row["status"],
            "triggered_by": row["triggered_by"],
            "created_at": _ser(row["created_at"]),
        }
    finally:
        await conn.close()


@router.get("/backup/jobs/{job_id}/snapshots")
async def list_snapshots(request: Request, job_id: str, limit: int = 50):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        job = await conn.fetchrow(
            "SELECT job_id FROM g1.backup_job WHERE job_id=$1 AND tenant_id=$2",
            uuid.UUID(job_id), tid
        )
        if not job:
            raise HTTPException(404, "backup job not found")
        rows = await conn.fetch("""
            SELECT snapshot_id, job_id, status, triggered_by,
                   started_at, finished_at, size_bytes, checksum_sha256,
                   snapshot_path, error_message, created_at
            FROM g1.backup_snapshot
            WHERE job_id=$1 AND tenant_id=$2
            ORDER BY created_at DESC
            LIMIT $3
        """, uuid.UUID(job_id), tid, limit)
        return [
            {
                "snapshot_id": str(r["snapshot_id"]),
                "job_id": str(r["job_id"]),
                "status": r["status"],
                "triggered_by": r["triggered_by"],
                "started_at": _ser(r["started_at"]),
                "finished_at": _ser(r["finished_at"]),
                "size_bytes": r["size_bytes"],
                "checksum_sha256": r["checksum_sha256"],
                "snapshot_path": r["snapshot_path"],
                "error_message": r["error_message"],
                "created_at": _ser(r["created_at"]),
                "duration_s": int((r["finished_at"] - r["started_at"]).total_seconds()) if r["started_at"] and r["finished_at"] else None,
            }
            for r in rows
        ]
    finally:
        await conn.close()


@router.put("/backup/snapshots/{snapshot_id}")
async def update_snapshot(request: Request, snapshot_id: str, body: SnapshotUpdate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        existing = await conn.fetchrow(
            "SELECT snapshot_id FROM g1.backup_snapshot WHERE snapshot_id=$1 AND tenant_id=$2",
            uuid.UUID(snapshot_id), tid
        )
        if not existing:
            raise HTTPException(404, "snapshot not found")
        updates = {k: v for k, v in body.model_dump(exclude_none=True).items()}
        set_clauses = []
        vals = []
        for i, (k, v) in enumerate(updates.items(), start=1):
            set_clauses.append(f"{k} = ${i}")
            vals.append(v)
        vals.extend([uuid.UUID(snapshot_id), tid])
        await conn.execute(
            f"UPDATE g1.backup_snapshot SET {', '.join(set_clauses)} WHERE snapshot_id=${len(vals)-1} AND tenant_id=${len(vals)}",
            *vals
        )
        return {"ok": True}
    finally:
        await conn.close()


@router.delete("/backup/snapshots/{snapshot_id}", status_code=204)
async def delete_snapshot(request: Request, snapshot_id: str):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        result = await conn.execute(
            "DELETE FROM g1.backup_snapshot WHERE snapshot_id=$1 AND tenant_id=$2",
            uuid.UUID(snapshot_id), tid
        )
        if result == "DELETE 0":
            raise HTTPException(404, "snapshot not found")
        await record_audit_event(conn, tid, actor, "backup_snapshot.delete", snapshot_id, {})
    finally:
        await conn.close()


@router.get("/backup/stats")
async def backup_stats(request: Request):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        row = await conn.fetchrow("""
            SELECT
                COUNT(DISTINCT j.job_id) FILTER (WHERE j.enabled) AS active_jobs,
                COUNT(s.snapshot_id) FILTER (WHERE s.created_at > now() - interval '24 hours') AS snapshots_24h,
                COUNT(s.snapshot_id) FILTER (WHERE s.status = 'success' AND s.created_at > now() - interval '24 hours') AS success_24h,
                COUNT(s.snapshot_id) FILTER (WHERE s.status = 'failed' AND s.created_at > now() - interval '24 hours') AS failed_24h,
                COUNT(s.snapshot_id) FILTER (WHERE s.status = 'pending') AS pending_total,
                COALESCE(SUM(s.size_bytes) FILTER (WHERE s.status = 'success'), 0) AS total_bytes_stored
            FROM g1.backup_job j
            LEFT JOIN g1.backup_snapshot s ON s.job_id = j.job_id
            WHERE j.tenant_id = $1
        """, tid)
        return dict(row)
    finally:
        await conn.close()
