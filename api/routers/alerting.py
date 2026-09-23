"""Alerting router — canonical G7 alert policy + lifecycle.

Policy mutations (create version, set effective) require
`alerting:operate`; reads require `alerting:read`. Alert
occurrences are created/resolved ONLY by the evaluation engine
(shared/alerting_eval.py) after accepted resyncs — there is no
operator write path to alert lifecycle (the wave4 manual
transition endpoint is superseded).
"""

from __future__ import annotations

import hashlib
import json

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.audit import record_audit_event
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/alerting", tags=["alerting"])

_SOURCE_KINDS = ("monitoring_problem", "monitoring_health_projection")
_SEVERITIES = ("unknown", "informational", "warning",
               "degraded", "critical")
_HEALTH_CLASSES = ("unknown", "healthy", "degraded", "unhealthy")


def _content_hash(body: dict) -> str:
    canonical = json.dumps(body, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


def _ser(row) -> dict:
    out = dict(row)
    for k, v in out.items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out


# ---------------------------------------------------------------------------
# Policy administration (tenant:admin of alerting — alerting:operate)
# ---------------------------------------------------------------------------


class PolicyVersionCreate(BaseModel):
    policy_id: str
    source_kind: str                     # monitoring_problem | monitoring_health_projection
    problem_min_severity: str | None = None
    health_classes: list[str] = []
    monitoring_source_id: str | None = None
    monitoring_resource_id: str | None = None
    make_effective: bool = True


@router.get("/policies")
async def list_policies(request: Request,
                        tenant_id: str | None = None) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT pv.policy_id, pv.policy_version, pv.source_kind,
                   pv.problem_min_severity, pv.health_classes,
                   pv.monitoring_source_id, pv.monitoring_resource_id,
                   pv.superseded_at IS NOT NULL AS superseded,
                   ev.enabled AS effective_enabled,
                   ev.policy_version = pv.policy_version
                       AND ev.enabled AS is_effective,
                   pv.created_at
              FROM alerting.alert_policy_version pv
              LEFT JOIN alerting.alert_policy_effective_version ev
                ON ev.tenant_id = pv.tenant_id
               AND ev.policy_id = pv.policy_id
             WHERE pv.tenant_id = %s
             ORDER BY pv.policy_id, pv.policy_version
            """, (tenant,))
        cols = [d.name for d in cur.description]
        return [_ser(dict(zip(cols, r))) for r in await cur.fetchall()]


@router.post("/policies", status_code=status.HTTP_201_CREATED)
async def create_policy_version(request: Request,
                                body: PolicyVersionCreate,
                                tenant_id: str | None = None) -> dict:
    """Create the next immutable policy version. Optionally makes it
    the current effective ENABLED version (superseding the prior)."""
    tenant = _authoritative_tenant(request, tenant_id)
    if body.source_kind not in _SOURCE_KINDS:
        raise HTTPException(status_code=422, detail="bad source_kind")
    if body.source_kind == "monitoring_problem":
        if body.problem_min_severity not in _SEVERITIES:
            raise HTTPException(
                status_code=422,
                detail=f"problem_min_severity must be one of "
                       f"{_SEVERITIES}")
        if body.health_classes:
            raise HTTPException(
                status_code=422,
                detail="health_classes not allowed for "
                       "monitoring_problem")
    else:
        bad = [c for c in body.health_classes
               if c not in _HEALTH_CLASSES]
        if bad or not body.health_classes:
            raise HTTPException(
                status_code=422,
                detail=f"health_classes must be a non-empty subset "
                       f"of {_HEALTH_CLASSES}")

    content = {
        "source_kind": body.source_kind,
        "problem_min_severity": body.problem_min_severity,
        "health_classes": sorted(body.health_classes),
        "monitoring_source_id": body.monitoring_source_id,
        "monitoring_resource_id": body.monitoring_resource_id,
    }
    chash = _content_hash(content)

    async with db_tenant_connection(tenant) as conn:
        await conn.execute(
            "INSERT INTO alerting.alert_policy (tenant_id, policy_id) "
            "VALUES (%s, %s) ON CONFLICT DO NOTHING",
            (tenant, body.policy_id))
        cur = await conn.execute(
            """
            SELECT COALESCE(MAX(policy_version), 0) + 1
              FROM alerting.alert_policy_version
             WHERE tenant_id = %s AND policy_id = %s
            """, (tenant, body.policy_id))
        version = (await cur.fetchone())[0]
        await conn.execute(
            """
            INSERT INTO alerting.alert_policy_version
                (tenant_id, policy_id, policy_version, source_kind,
                 problem_min_severity, health_classes,
                 monitoring_source_id, monitoring_resource_id,
                 content_hash)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s)
            """,
            (tenant, body.policy_id, version, body.source_kind,
             body.problem_min_severity, body.health_classes or [],
             body.monitoring_source_id, body.monitoring_resource_id,
             chash))

        if body.make_effective:
            # Supersede prior effective version, point to this one.
            cur = await conn.execute(
                """
                SELECT policy_version
                  FROM alerting.alert_policy_effective_version
                 WHERE tenant_id = %s AND policy_id = %s
                """, (tenant, body.policy_id))
            prior = await cur.fetchone()
            if prior:
                await conn.execute(
                    """
                    UPDATE alerting.alert_policy_version
                       SET superseded_at = transaction_timestamp()
                     WHERE tenant_id=%s AND policy_id=%s
                       AND policy_version=%s
                    """, (tenant, body.policy_id, prior[0]))
            await conn.execute(
                """
                INSERT INTO alerting.alert_policy_effective_version
                    (tenant_id, policy_id, policy_version, enabled)
                VALUES (%s, %s, %s, TRUE)
                ON CONFLICT (tenant_id, policy_id) DO UPDATE
                SET policy_version = EXCLUDED.policy_version,
                    enabled = TRUE,
                    effective_at = transaction_timestamp()
                """, (tenant, body.policy_id, version))

        await record_audit_event(
            conn, tenant,
            action="alerting.policy_version.created",
            actor_kind="principal",
            actor_id=(getattr(request.state, "jlmirror_context", None)
                      or {}).get("principal_id", "unknown"),
            subject_type="alert_policy", subject_id=body.policy_id,
            detail={"policy_version": version,
                    "source_kind": body.source_kind,
                    "effective": body.make_effective})
        await conn.commit()
    return {"policy_id": body.policy_id, "policy_version": version,
            "content_hash": chash,
            "effective": body.make_effective}


class EffectiveSet(BaseModel):
    policy_version: int
    enabled: bool = True


@router.post("/policies/{policy_id}/effective")
async def set_effective_version(request: Request, policy_id: str,
                                body: EffectiveSet,
                                tenant_id: str | None = None) -> dict:
    """Select the effective version (or disable the policy). A
    superseded version can never be re-selected."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT superseded_at FROM alerting.alert_policy_version
             WHERE tenant_id = %s AND policy_id = %s
               AND policy_version = %s
            """, (tenant, policy_id, body.policy_version))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404,
                                detail="policy version not found")
        if row[0] is not None:
            raise HTTPException(
                status_code=409,
                detail="superseded version cannot regain authority")
        await conn.execute(
            """
            UPDATE alerting.alert_policy_version
               SET superseded_at = transaction_timestamp()
             WHERE tenant_id=%s AND policy_id=%s
               AND policy_version <> %s AND superseded_at IS NULL
            """, (tenant, policy_id, body.policy_version))
        await conn.execute(
            """
            INSERT INTO alerting.alert_policy_effective_version
                (tenant_id, policy_id, policy_version, enabled)
            VALUES (%s, %s, %s, %s)
            ON CONFLICT (tenant_id, policy_id) DO UPDATE
            SET policy_version = EXCLUDED.policy_version,
                enabled = EXCLUDED.enabled,
                effective_at = transaction_timestamp()
            """, (tenant, policy_id, body.policy_version,
                  body.enabled))
        await record_audit_event(
            conn, tenant,
            action="alerting.policy_version.effective_set",
            actor_kind="principal",
            actor_id=(getattr(request.state, "jlmirror_context", None)
                      or {}).get("principal_id", "unknown"),
            subject_type="alert_policy", subject_id=policy_id,
            detail={"policy_version": body.policy_version,
                    "enabled": body.enabled})
        await conn.commit()
    return {"policy_id": policy_id,
            "policy_version": body.policy_version,
            "enabled": body.enabled}


# ---------------------------------------------------------------------------
# Alert reads (bounded, tenant-scoped)
# ---------------------------------------------------------------------------


@router.get("/alerts")
async def list_alerts(request: Request,
                      tenant_id: str | None = None,
                      lifecycle_state: str | None = None,
                      source_id: str | None = None,
                      limit: int = 50) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT alert_id, policy_id, policy_version, source_kind,
                   source_subject_id, monitoring_source_id,
                   monitoring_resource_id, lifecycle_state,
                   source_occurrence_revision,
                   current_source_revision,
                   source_evidence_summary, opened_at, resolved_at
              FROM alerting.alert
             WHERE (%s::text IS NULL OR lifecycle_state = %s)
               AND (%s::text IS NULL OR monitoring_source_id = %s)
             ORDER BY (lifecycle_state = 'resolved'),
                      opened_at DESC LIMIT %s
            """, (lifecycle_state, lifecycle_state,
                  source_id, source_id, min(limit, 200)))
        cols = [d.name for d in cur.description]
        return [_ser(dict(zip(cols, r))) for r in await cur.fetchall()]


@router.get("/alerts/{alert_id}")
async def get_alert(alert_id: str, request: Request,
                    tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT alert_id, policy_id, policy_version, source_kind,
                   source_subject_id, monitoring_source_id,
                   monitoring_resource_id, lifecycle_state,
                   source_occurrence_revision,
                   current_source_revision, source_evidence_summary,
                   opened_at, resolved_at
              FROM alerting.alert
             WHERE alert_id = %s
            """, (alert_id,))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404,
                                detail="alert not found")
        cols = [d.name for d in cur.description]
        alert = _ser(dict(zip(cols, row)))
        cur = await conn.execute(
            """
            SELECT alert_transition_id, from_lifecycle_state,
                   to_lifecycle_state, source_revision, occurred_at
              FROM alerting.alert_transition
             WHERE alert_id = %s ORDER BY occurred_at
            """, (alert_id,))
        cols = [d.name for d in cur.description]
        transitions = [_ser(dict(zip(cols, r)))
                       for r in await cur.fetchall()]
    return {"alert": alert, "transitions": transitions}


@router.get("/inbox")
async def list_inbox(request: Request,
                     tenant_id: str | None = None,
                     state: str | None = None,
                     limit: int = 100) -> list[dict]:
    """G6 consumer diagnostics — transport receipts (NOT alerts)."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT message_id, contract_name, correlation_id,
                   causation_id, state, resync_result_class,
                   source_revision_current, last_error_class,
                   received_at, completed_at
              FROM alerting.inbox_receipt
             WHERE (%s::text IS NULL OR state = %s)
             ORDER BY received_at DESC LIMIT %s
            """, (state, state, min(limit, 200)))
        cols = [d.name for d in cur.description]
        return [_ser(dict(zip(cols, r))) for r in await cur.fetchall()]
