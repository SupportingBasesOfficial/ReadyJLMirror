from fastapi import APIRouter, Request, HTTPException, Query
from pydantic import BaseModel, field_validator
from typing import Optional, List
from datetime import datetime
import uuid

from shared.auth import _require_operate, _require_ctx
from shared.db import db_connection
from shared.audit import record_audit_event

router = APIRouter(prefix="/api/v1", tags=["k8s"])

VALID_KINDS = {
    "Pod", "Deployment", "StatefulSet", "DaemonSet", "ReplicaSet",
    "Service", "Ingress", "ConfigMap", "Secret", "Namespace",
    "Node", "PersistentVolume", "PersistentVolumeClaim", "Job", "CronJob",
}
VALID_SYNC_STATUSES = {"pending", "running", "success", "failed", "cancelled"}


def _ser(v):
    if isinstance(v, datetime):
        return v.isoformat()
    return v


class ClusterCreate(BaseModel):
    name: str
    description: Optional[str] = None
    api_server: str
    kubeconfig_ref: Optional[str] = None
    credential_ref: Optional[str] = None
    default_namespace: str = "default"
    tls_verify: bool = True
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v):
        if not v.strip():
            raise ValueError("name cannot be empty")
        return v.strip()

    @field_validator("api_server")
    @classmethod
    def server_not_empty(cls, v):
        if not v.strip():
            raise ValueError("api_server cannot be empty")
        return v.strip()


class ClusterUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    api_server: Optional[str] = None
    kubeconfig_ref: Optional[str] = None
    credential_ref: Optional[str] = None
    default_namespace: Optional[str] = None
    tls_verify: Optional[bool] = None
    enabled: Optional[bool] = None


class ResourceUpsert(BaseModel):
    kind: str
    api_version: str = "v1"
    name: str
    namespace: Optional[str] = None
    labels: dict = {}
    phase: Optional[str] = None
    ready: Optional[str] = None
    status_summary: Optional[str] = None
    spec_summary: dict = {}

    @field_validator("kind")
    @classmethod
    def valid_kind(cls, v):
        if v not in VALID_KINDS:
            raise ValueError(f"kind must be one of {sorted(VALID_KINDS)}")
        return v


class SyncLogUpdate(BaseModel):
    status: str
    resource_count: Optional[int] = None
    kinds_synced: Optional[List[str]] = None
    error_message: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None

    @field_validator("status")
    @classmethod
    def valid_status(cls, v):
        if v not in VALID_SYNC_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_SYNC_STATUSES)}")
        return v


# ── Clusters ──────────────────────────────────────────────────────────────────

@router.get("/k8s/clusters")
async def list_clusters(request: Request):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        rows = await conn.fetch("""
            SELECT
                c.cluster_id, c.name, c.description, c.api_server,
                c.kubeconfig_ref, c.credential_ref, c.default_namespace,
                c.tls_verify, c.enabled, c.created_at,
                (SELECT COUNT(*) FROM g1.k8s_resource r WHERE r.cluster_id = c.cluster_id) AS cached_resources,
                s.sync_id AS last_sync_id,
                s.status AS last_sync_status,
                s.resource_count AS last_resource_count,
                s.created_at AS last_sync_at,
                s.finished_at AS last_sync_finished_at
            FROM g1.k8s_cluster c
            LEFT JOIN LATERAL (
                SELECT sync_id, status, resource_count, created_at, finished_at
                FROM g1.k8s_sync_log
                WHERE cluster_id = c.cluster_id
                ORDER BY created_at DESC LIMIT 1
            ) s ON TRUE
            WHERE c.tenant_id = $1
            ORDER BY c.name
        """, tid)
        return [
            {
                "cluster_id": str(r["cluster_id"]),
                "name": r["name"],
                "description": r["description"],
                "api_server": r["api_server"],
                "kubeconfig_ref": r["kubeconfig_ref"],
                "credential_ref": r["credential_ref"],
                "default_namespace": r["default_namespace"],
                "tls_verify": r["tls_verify"],
                "enabled": r["enabled"],
                "created_at": _ser(r["created_at"]),
                "cached_resources": r["cached_resources"],
                "last_sync": {
                    "sync_id": str(r["last_sync_id"]),
                    "status": r["last_sync_status"],
                    "resource_count": r["last_resource_count"],
                    "created_at": _ser(r["last_sync_at"]),
                    "finished_at": _ser(r["last_sync_finished_at"]),
                } if r["last_sync_id"] else None,
            }
            for r in rows
        ]
    finally:
        await conn.close()


@router.post("/k8s/clusters", status_code=201)
async def create_cluster(request: Request, body: ClusterCreate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        row = await conn.fetchrow("""
            INSERT INTO g1.k8s_cluster
                (tenant_id, name, description, api_server, kubeconfig_ref,
                 credential_ref, default_namespace, tls_verify, enabled, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
            RETURNING cluster_id, name, description, api_server, default_namespace,
                      tls_verify, enabled, created_at
        """, tid, body.name, body.description, body.api_server, body.kubeconfig_ref,
            body.credential_ref, body.default_namespace, body.tls_verify, body.enabled, actor)
        await record_audit_event(conn, tid, actor, "k8s_cluster.create", str(row["cluster_id"]), {})
        d = dict(row)
        d["cluster_id"] = str(d["cluster_id"])
        d["created_at"] = _ser(d["created_at"])
        return d
    finally:
        await conn.close()


@router.get("/k8s/clusters/{cluster_id}")
async def get_cluster(request: Request, cluster_id: str):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        row = await conn.fetchrow(
            "SELECT * FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if not row:
            raise HTTPException(404, "cluster not found")
        d = dict(row)
        d["cluster_id"] = str(d["cluster_id"])
        d["created_at"] = _ser(d["created_at"])
        return d
    finally:
        await conn.close()


@router.put("/k8s/clusters/{cluster_id}")
async def update_cluster(request: Request, cluster_id: str, body: ClusterUpdate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        existing = await conn.fetchrow(
            "SELECT cluster_id FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if not existing:
            raise HTTPException(404, "cluster not found")
        updates = {k: v for k, v in body.model_dump(exclude_none=True).items()}
        if not updates:
            raise HTTPException(400, "no fields to update")
        set_clauses, vals = [], []
        for i, (k, v) in enumerate(updates.items(), start=1):
            set_clauses.append(f"{k} = ${i}")
            vals.append(v)
        vals.extend([uuid.UUID(cluster_id), tid])
        await conn.execute(
            f"UPDATE g1.k8s_cluster SET {', '.join(set_clauses)} WHERE cluster_id=${len(vals)-1} AND tenant_id=${len(vals)}",
            *vals
        )
        await record_audit_event(conn, tid, actor, "k8s_cluster.update", cluster_id, updates)
        return {"ok": True}
    finally:
        await conn.close()


@router.delete("/k8s/clusters/{cluster_id}", status_code=204)
async def delete_cluster(request: Request, cluster_id: str):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        result = await conn.execute(
            "DELETE FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if result == "DELETE 0":
            raise HTTPException(404, "cluster not found")
        await record_audit_event(conn, tid, actor, "k8s_cluster.delete", cluster_id, {})
    finally:
        await conn.close()


# ── Resources (cache) ─────────────────────────────────────────────────────────

@router.get("/k8s/clusters/{cluster_id}/resources")
async def list_resources(
    request: Request,
    cluster_id: str,
    kind: Optional[str] = Query(None),
    namespace: Optional[str] = Query(None),
    search: Optional[str] = Query(None),
    limit: int = Query(200, le=1000),
):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        cluster = await conn.fetchrow(
            "SELECT cluster_id FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if not cluster:
            raise HTTPException(404, "cluster not found")
        conditions = ["cluster_id=$1"]
        params = [uuid.UUID(cluster_id)]
        i = 2
        if kind:
            conditions.append(f"kind=${i}")
            params.append(kind)
            i += 1
        if namespace:
            conditions.append(f"namespace=${i}")
            params.append(namespace)
            i += 1
        if search:
            conditions.append(f"name ILIKE ${i}")
            params.append(f"%{search}%")
            i += 1
        params.append(limit)
        rows = await conn.fetch(
            f"""SELECT resource_id, kind, api_version, name, namespace, labels,
                       phase, ready, status_summary, last_synced_at, created_at
                FROM g1.k8s_resource
                WHERE {' AND '.join(conditions)}
                ORDER BY kind, namespace NULLS LAST, name
                LIMIT ${i}""",
            *params
        )
        return [
            {
                "resource_id": str(r["resource_id"]),
                "kind": r["kind"],
                "api_version": r["api_version"],
                "name": r["name"],
                "namespace": r["namespace"],
                "labels": dict(r["labels"]) if r["labels"] else {},
                "phase": r["phase"],
                "ready": r["ready"],
                "status_summary": r["status_summary"],
                "last_synced_at": _ser(r["last_synced_at"]),
                "created_at": _ser(r["created_at"]),
            }
            for r in rows
        ]
    finally:
        await conn.close()


@router.post("/k8s/clusters/{cluster_id}/resources", status_code=201)
async def upsert_resource(request: Request, cluster_id: str, body: ResourceUpsert):
    """Worker uses this to upsert a resource into the cache."""
    access = await _require_operate(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        cluster = await conn.fetchrow(
            "SELECT cluster_id FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if not cluster:
            raise HTTPException(404, "cluster not found")
        import json as _json
        row = await conn.fetchrow("""
            INSERT INTO g1.k8s_resource
                (cluster_id, tenant_id, kind, api_version, name, namespace,
                 labels, phase, ready, status_summary, spec_summary, last_synced_at)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
            ON CONFLICT (cluster_id, kind, name, namespace) DO UPDATE SET
                api_version = EXCLUDED.api_version,
                labels = EXCLUDED.labels,
                phase = EXCLUDED.phase,
                ready = EXCLUDED.ready,
                status_summary = EXCLUDED.status_summary,
                spec_summary = EXCLUDED.spec_summary,
                last_synced_at = now()
            RETURNING resource_id, kind, name, namespace, last_synced_at
        """, uuid.UUID(cluster_id), tid, body.kind, body.api_version, body.name,
            body.namespace, _json.dumps(body.labels), body.phase, body.ready,
            body.status_summary, _json.dumps(body.spec_summary))
        return {
            "resource_id": str(row["resource_id"]),
            "kind": row["kind"],
            "name": row["name"],
            "namespace": row["namespace"],
            "last_synced_at": _ser(row["last_synced_at"]),
        }
    finally:
        await conn.close()


@router.delete("/k8s/clusters/{cluster_id}/resources", status_code=204)
async def clear_resources(request: Request, cluster_id: str, kind: Optional[str] = Query(None)):
    """Worker clears stale resources before a full sync."""
    access = await _require_operate(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        cluster = await conn.fetchrow(
            "SELECT cluster_id FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if not cluster:
            raise HTTPException(404, "cluster not found")
        if kind:
            await conn.execute(
                "DELETE FROM g1.k8s_resource WHERE cluster_id=$1 AND tenant_id=$2 AND kind=$3",
                uuid.UUID(cluster_id), tid, kind
            )
        else:
            await conn.execute(
                "DELETE FROM g1.k8s_resource WHERE cluster_id=$1 AND tenant_id=$2",
                uuid.UUID(cluster_id), tid
            )
    finally:
        await conn.close()


@router.get("/k8s/clusters/{cluster_id}/summary")
async def cluster_summary(request: Request, cluster_id: str):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        cluster = await conn.fetchrow(
            "SELECT cluster_id FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if not cluster:
            raise HTTPException(404, "cluster not found")
        rows = await conn.fetch("""
            SELECT kind, COUNT(*) AS count,
                   COUNT(*) FILTER (WHERE phase = 'Running') AS running,
                   COUNT(*) FILTER (WHERE phase = 'Pending') AS pending,
                   COUNT(*) FILTER (WHERE phase NOT IN ('Running', 'Pending') AND phase IS NOT NULL) AS other
            FROM g1.k8s_resource
            WHERE cluster_id=$1
            GROUP BY kind
            ORDER BY kind
        """, uuid.UUID(cluster_id))
        return {r["kind"]: {"count": r["count"], "running": r["running"], "pending": r["pending"], "other": r["other"]} for r in rows}
    finally:
        await conn.close()


# ── Sync ──────────────────────────────────────────────────────────────────────

@router.post("/k8s/clusters/{cluster_id}/sync", status_code=201)
async def trigger_sync(request: Request, cluster_id: str):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        cluster = await conn.fetchrow(
            "SELECT cluster_id, enabled FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if not cluster:
            raise HTTPException(404, "cluster not found")
        row = await conn.fetchrow("""
            INSERT INTO g1.k8s_sync_log (cluster_id, tenant_id, status, triggered_by)
            VALUES ($1,$2,'pending',$3)
            RETURNING sync_id, status, created_at
        """, uuid.UUID(cluster_id), tid, actor)
        await record_audit_event(conn, tid, actor, "k8s_sync.trigger", str(row["sync_id"]), {"cluster_id": cluster_id})
        return {
            "sync_id": str(row["sync_id"]),
            "status": row["status"],
            "created_at": _ser(row["created_at"]),
        }
    finally:
        await conn.close()


@router.get("/k8s/clusters/{cluster_id}/sync-logs")
async def list_sync_logs(request: Request, cluster_id: str, limit: int = 50):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        cluster = await conn.fetchrow(
            "SELECT cluster_id FROM g1.k8s_cluster WHERE cluster_id=$1 AND tenant_id=$2",
            uuid.UUID(cluster_id), tid
        )
        if not cluster:
            raise HTTPException(404, "cluster not found")
        rows = await conn.fetch("""
            SELECT sync_id, cluster_id, status, triggered_by, resource_count,
                   kinds_synced, error_message, started_at, finished_at, created_at
            FROM g1.k8s_sync_log
            WHERE cluster_id=$1 AND tenant_id=$2
            ORDER BY created_at DESC LIMIT $3
        """, uuid.UUID(cluster_id), tid, limit)
        return [
            {
                "sync_id": str(r["sync_id"]),
                "cluster_id": str(r["cluster_id"]),
                "status": r["status"],
                "triggered_by": r["triggered_by"],
                "resource_count": r["resource_count"],
                "kinds_synced": list(r["kinds_synced"] or []),
                "error_message": r["error_message"],
                "started_at": _ser(r["started_at"]),
                "finished_at": _ser(r["finished_at"]),
                "created_at": _ser(r["created_at"]),
                "duration_s": int((r["finished_at"] - r["started_at"]).total_seconds()) if r["started_at"] and r["finished_at"] else None,
            }
            for r in rows
        ]
    finally:
        await conn.close()


@router.put("/k8s/sync-logs/{sync_id}")
async def update_sync_log(request: Request, sync_id: str, body: SyncLogUpdate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        existing = await conn.fetchrow(
            "SELECT sync_id FROM g1.k8s_sync_log WHERE sync_id=$1 AND tenant_id=$2",
            uuid.UUID(sync_id), tid
        )
        if not existing:
            raise HTTPException(404, "sync log not found")
        updates = {k: v for k, v in body.model_dump(exclude_none=True).items()}
        set_clauses, vals = [], []
        for i, (k, v) in enumerate(updates.items(), start=1):
            set_clauses.append(f"{k} = ${i}")
            vals.append(v)
        vals.extend([uuid.UUID(sync_id), tid])
        await conn.execute(
            f"UPDATE g1.k8s_sync_log SET {', '.join(set_clauses)} WHERE sync_id=${len(vals)-1} AND tenant_id=${len(vals)}",
            *vals
        )
        return {"ok": True}
    finally:
        await conn.close()
