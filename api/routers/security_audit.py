"""G-SecAudit: Security Audit — rules, on-demand scan, findings with remediation."""

from __future__ import annotations

import json
import uuid
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/security-audit", tags=["security-audit"])

_SEVERITIES = {"critical", "high", "medium", "low"}
_CONDITION_TYPES = {"metric_threshold", "manual"}
_STATUSES = {"open", "resolved", "false_positive"}


def _require_tenant(request: Request) -> str:
    tid = (getattr(request.state, "jlmirror_context", None) or {}).get("tenant_id")
    if not tid:
        raise HTTPException(status_code=403, detail="tenant context required")
    return tid


def _principal(request: Request) -> str:
    return (getattr(request.state, "jlmirror_context", None) or {}).get(
        "principal_id", "unknown"
    )


async def _require_operator(request: Request) -> str:
    from shared import access

    ctx = getattr(request.state, "jlmirror_context", None) or {}
    tenant_id = ctx.get("tenant_id")
    principal_id = ctx.get("principal_id")
    if not tenant_id or not principal_id:
        raise HTTPException(status_code=403, detail="tenant context required")
    async with db_connection() as conn:
        perms = await access.effective_permissions(conn, principal_id, tenant_id)
    if "monitoring:operate" not in perms and "tenant:admin" not in perms:
        raise HTTPException(status_code=403, detail="monitoring:operate required")
    return tenant_id


# ── Models ─────────────────────────────────────────────────────────────────


class CreateRule(BaseModel):
    name: str
    description: str = ""
    severity: str = "medium"
    condition_type: str = "manual"
    condition_config: dict = {}


class UpdateRule(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    severity: Optional[str] = None
    condition_type: Optional[str] = None
    condition_config: Optional[dict] = None
    enabled: Optional[bool] = None


class UpdateFinding(BaseModel):
    status: Optional[str] = None
    remediation: Optional[str] = None


# ── Rules ───────────────────────────────────────────────────────────────────


@router.get("/rules")
async def list_rules(request: Request) -> list:
    tenant_id = _require_tenant(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT rule_id, name, description, severity,
                   condition_type, condition_config, enabled, created_at
              FROM g1.security_rule
             WHERE tenant_id = %s
             ORDER BY
               CASE severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                             WHEN 'medium'   THEN 3 ELSE 4 END,
               name
            """,
            (tenant_id,),
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in await cur.fetchall()]
    for r in rows:
        if r.get("created_at"):
            r["created_at"] = r["created_at"].isoformat()
        if isinstance(r.get("condition_config"), str):
            try:
                r["condition_config"] = json.loads(r["condition_config"])
            except Exception:
                pass
    return rows


@router.post("/rules", status_code=status.HTTP_201_CREATED)
async def create_rule(request: Request, body: CreateRule) -> dict:
    tenant_id = await _require_operator(request)
    actor = _principal(request)
    name = body.name.strip()
    if not name:
        raise HTTPException(status_code=422, detail="name is required")
    if len(name) > 200:
        raise HTTPException(status_code=422, detail="name max 200 chars")
    if body.severity not in _SEVERITIES:
        raise HTTPException(
            status_code=422, detail=f"severity must be one of {sorted(_SEVERITIES)}"
        )
    if body.condition_type not in _CONDITION_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"condition_type must be one of {sorted(_CONDITION_TYPES)}",
        )

    rule_id = str(uuid.uuid4())
    async with db_tenant_connection(tenant_id) as conn:
        try:
            await conn.execute(
                """
                INSERT INTO g1.security_rule
                    (rule_id, tenant_id, name, description, severity,
                     condition_type, condition_config, created_by)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                """,
                (
                    rule_id, tenant_id, name, body.description,
                    body.severity, body.condition_type,
                    json.dumps(body.condition_config), actor,
                ),
            )
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(
                    status_code=409, detail=f"rule '{name}' already exists"
                )
            raise
        await record_audit_event(
            conn, tenant_id,
            action="secaudit.rule.created",
            actor_kind="principal", actor_id=actor,
            subject_type="security_rule", subject_id=rule_id,
        )
        await conn.commit()
    return {"rule_id": rule_id, "name": name, "severity": body.severity}


@router.put("/rules/{rule_id}")
async def update_rule(
    request: Request, rule_id: str, body: UpdateRule
) -> dict:
    tenant_id = await _require_operator(request)
    actor = _principal(request)
    if body.severity and body.severity not in _SEVERITIES:
        raise HTTPException(
            status_code=422, detail=f"severity must be one of {sorted(_SEVERITIES)}"
        )
    if body.condition_type and body.condition_type not in _CONDITION_TYPES:
        raise HTTPException(
            status_code=422,
            detail=f"condition_type must be one of {sorted(_CONDITION_TYPES)}",
        )

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT rule_id FROM g1.security_rule WHERE tenant_id=%s AND rule_id=%s",
            (tenant_id, rule_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="rule not found")

        sets, vals = [], []
        for field in ("name", "description", "severity", "condition_type", "enabled"):
            v = getattr(body, field)
            if v is not None:
                sets.append(f"{field} = %s")
                vals.append(v)
        if body.condition_config is not None:
            sets.append("condition_config = %s")
            vals.append(json.dumps(body.condition_config))
        if not sets:
            return {"rule_id": rule_id, "updated": False}
        vals.extend([tenant_id, rule_id])
        await conn.execute(
            f"UPDATE g1.security_rule SET {', '.join(sets)} "
            f"WHERE tenant_id=%s AND rule_id=%s",
            vals,
        )
        await record_audit_event(
            conn, tenant_id,
            action="secaudit.rule.updated",
            actor_kind="principal", actor_id=actor,
            subject_type="security_rule", subject_id=rule_id,
        )
        await conn.commit()
    return {"rule_id": rule_id, "updated": True}


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(request: Request, rule_id: str):
    tenant_id = await _require_operator(request)
    actor = _principal(request)
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "DELETE FROM g1.security_rule WHERE tenant_id=%s AND rule_id=%s",
            (tenant_id, rule_id),
        )
        if cur.rowcount != 1:
            raise HTTPException(status_code=404, detail="rule not found")
        await record_audit_event(
            conn, tenant_id,
            action="secaudit.rule.deleted",
            actor_kind="principal", actor_id=actor,
            subject_type="security_rule", subject_id=rule_id,
        )
        await conn.commit()


# ── Scan ────────────────────────────────────────────────────────────────────


@router.post("/scan")
async def run_scan(request: Request) -> dict:
    """Run all enabled rules against available monitoring data.

    For metric_threshold rules: compares canonical_value from
    metric_current_state against config.threshold (float comparison).
    For manual rules: creates a single open finding with detail
    "pending_manual_review" (de-duplicated by rule_id).

    Findings are de-duplicated: an existing open finding for the same
    (rule_id, resource_ref) is not duplicated.
    """
    tenant_id = await _require_operator(request)
    actor = _principal(request)
    created = 0
    skipped = 0

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            """
            SELECT rule_id, name, condition_type, condition_config
              FROM g1.security_rule
             WHERE tenant_id = %s AND enabled = TRUE
            """,
            (tenant_id,),
        )
        rules = await cur.fetchall()

        for (rid, rname, ctype, cfg) in rules:
            if isinstance(cfg, str):
                try:
                    cfg = json.loads(cfg)
                except Exception:
                    cfg = {}

            if ctype == "metric_threshold":
                metric_def_id = cfg.get("metric_definition_id", "")
                threshold = cfg.get("threshold")
                operator = cfg.get("operator", "gt")  # gt | lt | gte | lte
                if not metric_def_id or threshold is None:
                    skipped += 1
                    continue

                # Find all resources exceeding threshold
                op_sql = {
                    "gt": ">", "lt": "<", "gte": ">=", "lte": "<=",
                }.get(operator, ">")
                viol_cur = await conn.execute(
                    f"""
                    SELECT mcs.monitoring_resource_id,
                           mcs.canonical_value::text
                      FROM monitoring.metric_current_state mcs
                     WHERE mcs.tenant_id = %s
                       AND mcs.metric_definition_id = %s
                       AND mcs.evidence_state = 'current'
                       AND (mcs.canonical_value::float {op_sql} %s::float)
                    """,
                    (tenant_id, metric_def_id, float(threshold)),
                )
                violations = await viol_cur.fetchall()

                for (resource_ref, actual_val) in violations:
                    # de-duplicate
                    dedup = await conn.execute(
                        """
                        SELECT 1 FROM g1.security_finding
                         WHERE tenant_id=%s AND rule_id=%s
                           AND resource_ref=%s AND status='open'
                        """,
                        (tenant_id, rid, resource_ref),
                    )
                    if await dedup.fetchone():
                        skipped += 1
                        continue
                    finding_id = str(uuid.uuid4())
                    await conn.execute(
                        """
                        INSERT INTO g1.security_finding
                            (finding_id, tenant_id, rule_id, resource_ref, detail)
                        VALUES (%s, %s, %s, %s, %s)
                        """,
                        (
                            finding_id, tenant_id, rid, resource_ref,
                            f"Value {actual_val} {op_sql} threshold {threshold}",
                        ),
                    )
                    created += 1

            else:  # manual
                dedup = await conn.execute(
                    """
                    SELECT 1 FROM g1.security_finding
                     WHERE tenant_id=%s AND rule_id=%s AND status='open'
                    """,
                    (tenant_id, rid),
                )
                if await dedup.fetchone():
                    skipped += 1
                    continue
                finding_id = str(uuid.uuid4())
                await conn.execute(
                    """
                    INSERT INTO g1.security_finding
                        (finding_id, tenant_id, rule_id, detail)
                    VALUES (%s, %s, %s, %s)
                    """,
                    (finding_id, tenant_id, rid, "pending_manual_review"),
                )
                created += 1

        await record_audit_event(
            conn, tenant_id,
            action="secaudit.scan.completed",
            actor_kind="principal", actor_id=actor,
            subject_type="security_scan", subject_id=tenant_id,
            detail={"created": created, "skipped": skipped},
        )
        await conn.commit()

    return {"created": created, "skipped": skipped, "rules_evaluated": len(rules)}


# ── Findings ────────────────────────────────────────────────────────────────


@router.get("/findings")
async def list_findings(
    request: Request,
    rule_id: Optional[str] = None,
    status_filter: Optional[str] = None,
    severity: Optional[str] = None,
    limit: int = 100,
) -> list:
    tenant_id = _require_tenant(request)
    clauses = ["f.tenant_id = %s"]
    params: list = [tenant_id]
    if rule_id:
        clauses.append("f.rule_id = %s")
        params.append(rule_id)
    if status_filter:
        clauses.append("f.status = %s")
        params.append(status_filter)
    if severity:
        clauses.append("r.severity = %s")
        params.append(severity)
    params.append(min(limit, 500))

    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            f"""
            SELECT f.finding_id, f.rule_id, r.name AS rule_name,
                   r.severity, f.resource_ref, f.status,
                   f.detail, f.remediation, f.found_at, f.resolved_at
              FROM g1.security_finding f
              JOIN g1.security_rule r ON r.rule_id = f.rule_id
             WHERE {' AND '.join(clauses)}
             ORDER BY
               CASE r.severity WHEN 'critical' THEN 1 WHEN 'high' THEN 2
                               WHEN 'medium'   THEN 3 ELSE 4 END,
               f.found_at DESC
             LIMIT %s
            """,
            tuple(params),
        )
        cols = [d[0] for d in cur.description]
        rows = [dict(zip(cols, r)) for r in await cur.fetchall()]
    for r in rows:
        for ts in ("found_at", "resolved_at"):
            if r.get(ts):
                r[ts] = r[ts].isoformat()
    return rows


@router.patch("/findings/{finding_id}")
async def update_finding(
    request: Request, finding_id: str, body: UpdateFinding
) -> dict:
    tenant_id = await _require_operator(request)
    actor = _principal(request)
    if body.status and body.status not in _STATUSES:
        raise HTTPException(
            status_code=422, detail=f"status must be one of {sorted(_STATUSES)}"
        )
    async with db_tenant_connection(tenant_id) as conn:
        cur = await conn.execute(
            "SELECT finding_id FROM g1.security_finding "
            "WHERE tenant_id=%s AND finding_id=%s",
            (tenant_id, finding_id),
        )
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="finding not found")

        sets, vals = [], []
        if body.status is not None:
            sets.append("status = %s")
            vals.append(body.status)
            if body.status in ("resolved", "false_positive"):
                sets.append("resolved_at = now()")
            else:
                sets.append("resolved_at = NULL")
        if body.remediation is not None:
            sets.append("remediation = %s")
            vals.append(body.remediation)
        if not sets:
            return {"finding_id": finding_id, "updated": False}
        vals.extend([tenant_id, finding_id])
        await conn.execute(
            f"UPDATE g1.security_finding SET {', '.join(sets)} "
            f"WHERE tenant_id=%s AND finding_id=%s",
            vals,
        )
        await record_audit_event(
            conn, tenant_id,
            action="secaudit.finding.updated",
            actor_kind="principal", actor_id=actor,
            subject_type="security_finding", subject_id=finding_id,
            detail={"status": body.status, "has_remediation": body.remediation is not None},
        )
        await conn.commit()
    return {"finding_id": finding_id, "updated": True}
