from fastapi import APIRouter, Request, HTTPException
from pydantic import BaseModel, field_validator
from typing import Optional, List
from datetime import datetime
import uuid
import json

from shared.auth import _require_operate, _require_ctx
from shared.db import db_connection
from shared.audit import record_audit_event

router = APIRouter(prefix="/api/v1", tags=["firewall"])

VALID_BACKENDS = {"iptables", "nftables", "ufw"}
VALID_ACTIONS = {"ACCEPT", "DROP", "REJECT", "LOG"}
VALID_DIRECTIONS = {"INPUT", "OUTPUT", "FORWARD"}
VALID_DEPLOY_STATUSES = {"pending", "running", "success", "failed", "cancelled"}


def _ser(v):
    if isinstance(v, datetime):
        return v.isoformat()
    return v


def _rule_to_dict(r) -> dict:
    return {
        "rule_id": str(r["rule_id"]),
        "ruleset_id": str(r["ruleset_id"]),
        "position": r["position"],
        "action": r["action"],
        "direction": r["direction"],
        "protocol": r["protocol"],
        "src_ip": r["src_ip"],
        "dst_ip": r["dst_ip"],
        "src_port": r["src_port"],
        "dst_port": r["dst_port"],
        "comment": r["comment"],
        "enabled": r["enabled"],
        "created_at": _ser(r["created_at"]),
    }


class RulesetCreate(BaseModel):
    name: str
    description: Optional[str] = None
    device_id: Optional[str] = None
    target_host: str
    target_port: int = 22
    target_user: str = "root"
    backend: str = "iptables"
    credential_ref: Optional[str] = None
    enabled: bool = True

    @field_validator("name")
    @classmethod
    def name_not_empty(cls, v):
        if not v.strip():
            raise ValueError("name cannot be empty")
        return v.strip()

    @field_validator("target_host")
    @classmethod
    def host_not_empty(cls, v):
        if not v.strip():
            raise ValueError("target_host cannot be empty")
        return v.strip()

    @field_validator("backend")
    @classmethod
    def valid_backend(cls, v):
        if v not in VALID_BACKENDS:
            raise ValueError(f"backend must be one of {sorted(VALID_BACKENDS)}")
        return v


class RulesetUpdate(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    device_id: Optional[str] = None
    target_host: Optional[str] = None
    target_port: Optional[int] = None
    target_user: Optional[str] = None
    backend: Optional[str] = None
    credential_ref: Optional[str] = None
    enabled: Optional[bool] = None

    @field_validator("backend")
    @classmethod
    def valid_backend(cls, v):
        if v is not None and v not in VALID_BACKENDS:
            raise ValueError(f"backend must be one of {sorted(VALID_BACKENDS)}")
        return v


class RuleCreate(BaseModel):
    position: int = 100
    action: str = "ACCEPT"
    direction: str = "INPUT"
    protocol: Optional[str] = None
    src_ip: Optional[str] = None
    dst_ip: Optional[str] = None
    src_port: Optional[str] = None
    dst_port: Optional[str] = None
    comment: Optional[str] = None
    enabled: bool = True

    @field_validator("action")
    @classmethod
    def valid_action(cls, v):
        if v not in VALID_ACTIONS:
            raise ValueError(f"action must be one of {sorted(VALID_ACTIONS)}")
        return v

    @field_validator("direction")
    @classmethod
    def valid_direction(cls, v):
        if v not in VALID_DIRECTIONS:
            raise ValueError(f"direction must be one of {sorted(VALID_DIRECTIONS)}")
        return v


class RuleUpdate(BaseModel):
    position: Optional[int] = None
    action: Optional[str] = None
    direction: Optional[str] = None
    protocol: Optional[str] = None
    src_ip: Optional[str] = None
    dst_ip: Optional[str] = None
    src_port: Optional[str] = None
    dst_port: Optional[str] = None
    comment: Optional[str] = None
    enabled: Optional[bool] = None

    @field_validator("action")
    @classmethod
    def valid_action(cls, v):
        if v is not None and v not in VALID_ACTIONS:
            raise ValueError(f"action must be one of {sorted(VALID_ACTIONS)}")
        return v


class DeploymentUpdate(BaseModel):
    status: str
    output: Optional[str] = None
    error_message: Optional[str] = None
    started_at: Optional[str] = None
    finished_at: Optional[str] = None

    @field_validator("status")
    @classmethod
    def valid_status(cls, v):
        if v not in VALID_DEPLOY_STATUSES:
            raise ValueError(f"status must be one of {sorted(VALID_DEPLOY_STATUSES)}")
        return v


# ── Rulesets ─────────────────────────────────────────────────────────────────

@router.get("/firewall/rulesets")
async def list_rulesets(request: Request):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        rows = await conn.fetch("""
            SELECT
                rs.ruleset_id, rs.name, rs.description, rs.device_id,
                rs.target_host, rs.target_port, rs.target_user, rs.backend,
                rs.credential_ref, rs.enabled, rs.created_at,
                (SELECT COUNT(*) FROM g1.firewall_rule r WHERE r.ruleset_id = rs.ruleset_id AND r.enabled) AS rule_count,
                d.deployment_id AS last_deploy_id,
                d.status AS last_deploy_status,
                d.created_at AS last_deploy_at,
                d.finished_at AS last_deploy_finished_at
            FROM g1.firewall_ruleset rs
            LEFT JOIN LATERAL (
                SELECT deployment_id, status, created_at, finished_at
                FROM g1.firewall_deployment
                WHERE ruleset_id = rs.ruleset_id
                ORDER BY created_at DESC LIMIT 1
            ) d ON TRUE
            WHERE rs.tenant_id = $1
            ORDER BY rs.name
        """, tid)
        return [
            {
                "ruleset_id": str(r["ruleset_id"]),
                "name": r["name"],
                "description": r["description"],
                "device_id": r["device_id"],
                "target_host": r["target_host"],
                "target_port": r["target_port"],
                "target_user": r["target_user"],
                "backend": r["backend"],
                "credential_ref": r["credential_ref"],
                "enabled": r["enabled"],
                "created_at": _ser(r["created_at"]),
                "rule_count": r["rule_count"],
                "last_deployment": {
                    "deployment_id": str(r["last_deploy_id"]),
                    "status": r["last_deploy_status"],
                    "created_at": _ser(r["last_deploy_at"]),
                    "finished_at": _ser(r["last_deploy_finished_at"]),
                } if r["last_deploy_id"] else None,
            }
            for r in rows
        ]
    finally:
        await conn.close()


@router.post("/firewall/rulesets", status_code=201)
async def create_ruleset(request: Request, body: RulesetCreate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        row = await conn.fetchrow("""
            INSERT INTO g1.firewall_ruleset
                (tenant_id, name, description, device_id, target_host, target_port,
                 target_user, backend, credential_ref, enabled, created_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
            RETURNING ruleset_id, name, description, target_host, target_port,
                      target_user, backend, enabled, created_at
        """, tid, body.name, body.description, body.device_id,
            body.target_host, body.target_port, body.target_user,
            body.backend, body.credential_ref, body.enabled, actor)
        await record_audit_event(conn, tid, actor, "firewall_ruleset.create", str(row["ruleset_id"]), {})
        d = dict(row)
        d["ruleset_id"] = str(d["ruleset_id"])
        d["created_at"] = _ser(d["created_at"])
        return d
    finally:
        await conn.close()


@router.get("/firewall/rulesets/{ruleset_id}")
async def get_ruleset(request: Request, ruleset_id: str):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        rs = await conn.fetchrow(
            "SELECT * FROM g1.firewall_ruleset WHERE ruleset_id=$1 AND tenant_id=$2",
            uuid.UUID(ruleset_id), tid
        )
        if not rs:
            raise HTTPException(404, "ruleset not found")
        rules = await conn.fetch(
            "SELECT * FROM g1.firewall_rule WHERE ruleset_id=$1 ORDER BY position, created_at",
            uuid.UUID(ruleset_id)
        )
        d = dict(rs)
        d["ruleset_id"] = str(d["ruleset_id"])
        d["created_at"] = _ser(d["created_at"])
        d["rules"] = [_rule_to_dict(r) for r in rules]
        return d
    finally:
        await conn.close()


@router.put("/firewall/rulesets/{ruleset_id}")
async def update_ruleset(request: Request, ruleset_id: str, body: RulesetUpdate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        existing = await conn.fetchrow(
            "SELECT ruleset_id FROM g1.firewall_ruleset WHERE ruleset_id=$1 AND tenant_id=$2",
            uuid.UUID(ruleset_id), tid
        )
        if not existing:
            raise HTTPException(404, "ruleset not found")
        updates = {k: v for k, v in body.model_dump(exclude_none=True).items()}
        if not updates:
            raise HTTPException(400, "no fields to update")
        set_clauses = []
        vals = []
        for i, (k, v) in enumerate(updates.items(), start=1):
            set_clauses.append(f"{k} = ${i}")
            vals.append(v)
        vals.extend([uuid.UUID(ruleset_id), tid])
        await conn.execute(
            f"UPDATE g1.firewall_ruleset SET {', '.join(set_clauses)} WHERE ruleset_id=${len(vals)-1} AND tenant_id=${len(vals)}",
            *vals
        )
        await record_audit_event(conn, tid, actor, "firewall_ruleset.update", ruleset_id, updates)
        return {"ok": True}
    finally:
        await conn.close()


@router.delete("/firewall/rulesets/{ruleset_id}", status_code=204)
async def delete_ruleset(request: Request, ruleset_id: str):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        result = await conn.execute(
            "DELETE FROM g1.firewall_ruleset WHERE ruleset_id=$1 AND tenant_id=$2",
            uuid.UUID(ruleset_id), tid
        )
        if result == "DELETE 0":
            raise HTTPException(404, "ruleset not found")
        await record_audit_event(conn, tid, actor, "firewall_ruleset.delete", ruleset_id, {})
    finally:
        await conn.close()


# ── Rules ─────────────────────────────────────────────────────────────────────

@router.get("/firewall/rulesets/{ruleset_id}/rules")
async def list_rules(request: Request, ruleset_id: str):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        rs = await conn.fetchrow(
            "SELECT ruleset_id FROM g1.firewall_ruleset WHERE ruleset_id=$1 AND tenant_id=$2",
            uuid.UUID(ruleset_id), tid
        )
        if not rs:
            raise HTTPException(404, "ruleset not found")
        rules = await conn.fetch(
            "SELECT * FROM g1.firewall_rule WHERE ruleset_id=$1 ORDER BY position, created_at",
            uuid.UUID(ruleset_id)
        )
        return [_rule_to_dict(r) for r in rules]
    finally:
        await conn.close()


@router.post("/firewall/rulesets/{ruleset_id}/rules", status_code=201)
async def add_rule(request: Request, ruleset_id: str, body: RuleCreate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        rs = await conn.fetchrow(
            "SELECT ruleset_id FROM g1.firewall_ruleset WHERE ruleset_id=$1 AND tenant_id=$2",
            uuid.UUID(ruleset_id), tid
        )
        if not rs:
            raise HTTPException(404, "ruleset not found")
        row = await conn.fetchrow("""
            INSERT INTO g1.firewall_rule
                (ruleset_id, tenant_id, position, action, direction, protocol,
                 src_ip, dst_ip, src_port, dst_port, comment, enabled)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
            RETURNING *
        """, uuid.UUID(ruleset_id), tid, body.position, body.action, body.direction,
            body.protocol, body.src_ip, body.dst_ip, body.src_port, body.dst_port,
            body.comment, body.enabled)
        await record_audit_event(conn, tid, actor, "firewall_rule.create", str(row["rule_id"]), {"ruleset_id": ruleset_id})
        return _rule_to_dict(row)
    finally:
        await conn.close()


@router.put("/firewall/rules/{rule_id}")
async def update_rule(request: Request, rule_id: str, body: RuleUpdate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        existing = await conn.fetchrow(
            "SELECT rule_id FROM g1.firewall_rule WHERE rule_id=$1 AND tenant_id=$2",
            uuid.UUID(rule_id), tid
        )
        if not existing:
            raise HTTPException(404, "rule not found")
        updates = {k: v for k, v in body.model_dump(exclude_none=True).items()}
        if not updates:
            raise HTTPException(400, "no fields to update")
        set_clauses = []
        vals = []
        for i, (k, v) in enumerate(updates.items(), start=1):
            set_clauses.append(f"{k} = ${i}")
            vals.append(v)
        vals.extend([uuid.UUID(rule_id), tid])
        await conn.execute(
            f"UPDATE g1.firewall_rule SET {', '.join(set_clauses)} WHERE rule_id=${len(vals)-1} AND tenant_id=${len(vals)}",
            *vals
        )
        await record_audit_event(conn, tid, actor, "firewall_rule.update", rule_id, updates)
        return {"ok": True}
    finally:
        await conn.close()


@router.delete("/firewall/rules/{rule_id}", status_code=204)
async def delete_rule(request: Request, rule_id: str):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        result = await conn.execute(
            "DELETE FROM g1.firewall_rule WHERE rule_id=$1 AND tenant_id=$2",
            uuid.UUID(rule_id), tid
        )
        if result == "DELETE 0":
            raise HTTPException(404, "rule not found")
        await record_audit_event(conn, tid, actor, "firewall_rule.delete", rule_id, {})
    finally:
        await conn.close()


# ── Deploy ────────────────────────────────────────────────────────────────────

@router.post("/firewall/rulesets/{ruleset_id}/deploy", status_code=201)
async def trigger_deploy(request: Request, ruleset_id: str, comment: Optional[str] = None):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    actor = access.get("user_id", "system")
    conn = await db_connection()
    try:
        rs = await conn.fetchrow(
            "SELECT ruleset_id FROM g1.firewall_ruleset WHERE ruleset_id=$1 AND tenant_id=$2",
            uuid.UUID(ruleset_id), tid
        )
        if not rs:
            raise HTTPException(404, "ruleset not found")
        # snapshot das regras atuais
        rules = await conn.fetch(
            "SELECT * FROM g1.firewall_rule WHERE ruleset_id=$1 ORDER BY position, created_at",
            uuid.UUID(ruleset_id)
        )
        snapshot = [_rule_to_dict(r) for r in rules]
        ver = await conn.fetchrow("""
            INSERT INTO g1.firewall_rule_version (ruleset_id, tenant_id, rules_snapshot, comment, created_by)
            VALUES ($1,$2,$3,$4,$5)
            RETURNING version_id, created_at
        """, uuid.UUID(ruleset_id), tid, json.dumps(snapshot), comment, actor)
        deploy = await conn.fetchrow("""
            INSERT INTO g1.firewall_deployment (ruleset_id, tenant_id, version_id, status, triggered_by)
            VALUES ($1,$2,$3,'pending',$4)
            RETURNING deployment_id, status, created_at
        """, uuid.UUID(ruleset_id), tid, ver["version_id"], actor)
        await record_audit_event(conn, tid, actor, "firewall_deployment.trigger", str(deploy["deployment_id"]), {"ruleset_id": ruleset_id, "version_id": str(ver["version_id"])})
        return {
            "deployment_id": str(deploy["deployment_id"]),
            "version_id": str(ver["version_id"]),
            "status": deploy["status"],
            "created_at": _ser(deploy["created_at"]),
        }
    finally:
        await conn.close()


@router.get("/firewall/rulesets/{ruleset_id}/deployments")
async def list_deployments(request: Request, ruleset_id: str, limit: int = 50):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        rs = await conn.fetchrow(
            "SELECT ruleset_id FROM g1.firewall_ruleset WHERE ruleset_id=$1 AND tenant_id=$2",
            uuid.UUID(ruleset_id), tid
        )
        if not rs:
            raise HTTPException(404, "ruleset not found")
        rows = await conn.fetch("""
            SELECT deployment_id, ruleset_id, version_id, status, triggered_by,
                   output, error_message, started_at, finished_at, created_at
            FROM g1.firewall_deployment
            WHERE ruleset_id=$1 AND tenant_id=$2
            ORDER BY created_at DESC LIMIT $3
        """, uuid.UUID(ruleset_id), tid, limit)
        return [
            {
                "deployment_id": str(r["deployment_id"]),
                "ruleset_id": str(r["ruleset_id"]),
                "version_id": str(r["version_id"]) if r["version_id"] else None,
                "status": r["status"],
                "triggered_by": r["triggered_by"],
                "output": r["output"],
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


@router.put("/firewall/deployments/{deployment_id}")
async def update_deployment(request: Request, deployment_id: str, body: DeploymentUpdate):
    access = await _require_operate(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        existing = await conn.fetchrow(
            "SELECT deployment_id FROM g1.firewall_deployment WHERE deployment_id=$1 AND tenant_id=$2",
            uuid.UUID(deployment_id), tid
        )
        if not existing:
            raise HTTPException(404, "deployment not found")
        updates = {k: v for k, v in body.model_dump(exclude_none=True).items()}
        set_clauses = []
        vals = []
        for i, (k, v) in enumerate(updates.items(), start=1):
            set_clauses.append(f"{k} = ${i}")
            vals.append(v)
        vals.extend([uuid.UUID(deployment_id), tid])
        await conn.execute(
            f"UPDATE g1.firewall_deployment SET {', '.join(set_clauses)} WHERE deployment_id=${len(vals)-1} AND tenant_id=${len(vals)}",
            *vals
        )
        return {"ok": True}
    finally:
        await conn.close()


@router.get("/firewall/rulesets/{ruleset_id}/versions")
async def list_versions(request: Request, ruleset_id: str, limit: int = 20):
    access = await _require_ctx(request)
    tid = access["tenant_id"]
    conn = await db_connection()
    try:
        rs = await conn.fetchrow(
            "SELECT ruleset_id FROM g1.firewall_ruleset WHERE ruleset_id=$1 AND tenant_id=$2",
            uuid.UUID(ruleset_id), tid
        )
        if not rs:
            raise HTTPException(404, "ruleset not found")
        rows = await conn.fetch("""
            SELECT version_id, ruleset_id,
                   jsonb_array_length(rules_snapshot) AS rule_count,
                   comment, created_at, created_by
            FROM g1.firewall_rule_version
            WHERE ruleset_id=$1 AND tenant_id=$2
            ORDER BY created_at DESC LIMIT $3
        """, uuid.UUID(ruleset_id), tid, limit)
        return [
            {
                "version_id": str(r["version_id"]),
                "rule_count": r["rule_count"],
                "comment": r["comment"],
                "created_at": _ser(r["created_at"]),
                "created_by": r["created_by"],
            }
            for r in rows
        ]
    finally:
        await conn.close()
