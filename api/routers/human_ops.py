"""G8 human operations — responsibility, action assignment, ACK,
native visibility (canonical g8.human-operations@1).

Authority law: human-operations facts never grant authorization —
every mutation rereads the caller's effective permissions and stores
a bounded authority_snapshot as evidence. All writes are
tenant-scoped, audited, and idempotent by logical_action_id.
"""

from __future__ import annotations

import hashlib
import json
import secrets

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared import access
from shared.audit import record_audit_event
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/alerting", tags=["human-ops"])

_RESP_ROLES = ("technical_responsible", "service_owner", "operator",
               "customer_responsible")
_ACTION_KINDS = ("investigate_alert", "acknowledge_alert",
                 "review_alert", "customer_review_required")


def _hash(obj: dict) -> str:
    return hashlib.sha256(
        json.dumps(obj, sort_keys=True,
                   separators=(",", ":")).encode()).hexdigest()


async def _authority_snapshot(conn, tenant: str,
                              principal_id: str) -> dict:
    """Bounded immutable snapshot of the caller's admitted authority
    at effect time — evidence, not a replacement IAM."""
    perms = sorted(await access.effective_permissions(
        conn, principal_id, tenant))
    return {"principal_id": principal_id, "tenant_id": tenant,
            "permissions": perms}


async def _alert_or_404(conn, tenant: str, alert_id: str):
    cur = await conn.execute(
        "SELECT lifecycle_state FROM alerting.alert "
        "WHERE tenant_id=%s AND alert_id=%s", (tenant, alert_id))
    row = await cur.fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="alert not found")
    return row[0]


# ---------------------------------------------------------------------------
# Alert action assignment — exactly one current owner per alert
# ---------------------------------------------------------------------------


class AssignAction(BaseModel):
    owner_principal_id: str
    action_kind: str
    logical_action_id: str | None = None


@router.post("/alerts/{alert_id}/assign",
             status_code=status.HTTP_201_CREATED)
async def assign_alert_action(alert_id: str, request: Request,
                              body: AssignAction,
                              tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    actor = ctx.get("principal_id", "dev-operator")
    if body.action_kind not in _ACTION_KINDS:
        raise HTTPException(status_code=422,
                            detail=f"action_kind one of {_ACTION_KINDS}")
    logical_id = body.logical_action_id or f"act_{secrets.token_urlsafe(12)}"
    assign_id = f"asg_{secrets.token_urlsafe(12)}"
    content = {"alert_id": alert_id,
               "owner_principal_id": body.owner_principal_id,
               "action_kind": body.action_kind}
    async with db_tenant_connection(tenant) as conn:
        await _alert_or_404(conn, tenant, alert_id)
        snapshot = await _authority_snapshot(conn, tenant, actor)
        # Idempotency: same logical_action_id replays recorded effect.
        cur = await conn.execute(
            """
            SELECT action_assignment_id
              FROM human_operations.alert_action_assignment
             WHERE tenant_id=%s AND logical_action_id=%s
            """, (tenant, logical_id))
        prior = await cur.fetchone()
        if prior:
            return {"action_assignment_id": prior[0],
                    "logical_action_id": logical_id, "replayed": True}
        # Atomic reassignment: close current, open successor.
        await conn.execute(
            """
            UPDATE human_operations.alert_action_assignment
               SET effective_until = transaction_timestamp(),
                   ended_by_principal_id = %s,
                   end_reason = 'reassigned'
             WHERE tenant_id=%s AND alert_id=%s
               AND effective_until IS NULL
            """, (actor, tenant, alert_id))
        await conn.execute(
            """
            INSERT INTO human_operations.alert_action_assignment
                (tenant_id, action_assignment_id, alert_id,
                 owner_principal_id, action_kind, logical_action_id,
                 content_hash, assigned_by_principal_id,
                 authority_snapshot)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
            """,
            (tenant, assign_id, alert_id, body.owner_principal_id,
             body.action_kind, logical_id, _hash(content), actor,
             json.dumps(snapshot)))
        await conn.execute(
            """
            INSERT INTO human_operations.current_action_projection
                (tenant_id, alert_id, action_assignment_id,
                 owner_principal_id, current_action,
                 projection_revision)
            VALUES (%s,%s,%s,%s,%s,1)
            ON CONFLICT (tenant_id, alert_id) DO UPDATE
            SET action_assignment_id = EXCLUDED.action_assignment_id,
                owner_principal_id = EXCLUDED.owner_principal_id,
                current_action = EXCLUDED.current_action,
                projection_revision =
                    current_action_projection.projection_revision + 1,
                projected_at = transaction_timestamp()
            """,
            (tenant, alert_id, assign_id, body.owner_principal_id,
             body.action_kind))
        await record_audit_event(
            conn, tenant, action="alerting.action.assigned",
            actor_kind="principal", actor_id=actor,
            subject_type="alert", subject_id=alert_id,
            detail={"owner": body.owner_principal_id,
                    "action_kind": body.action_kind})
        await conn.commit()
    return {"action_assignment_id": assign_id,
            "logical_action_id": logical_id}


# ---------------------------------------------------------------------------
# ACK — append-only evidence, never mutates lifecycle
# ---------------------------------------------------------------------------


class AckBody(BaseModel):
    note: str | None = None
    logical_action_id: str | None = None


@router.post("/alerts/{alert_id}/ack",
             status_code=status.HTTP_201_CREATED)
async def acknowledge_alert(alert_id: str, request: Request,
                            body: AckBody,
                            tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    actor = ctx.get("principal_id", "dev-operator")
    logical_id = body.logical_action_id or f"ack_{secrets.token_urlsafe(12)}"
    ack_id = f"ack_{secrets.token_urlsafe(12)}"
    content = {"alert_id": alert_id, "principal_id": actor,
               "note": body.note}
    async with db_tenant_connection(tenant) as conn:
        await _alert_or_404(conn, tenant, alert_id)
        snapshot = await _authority_snapshot(conn, tenant, actor)
        cur = await conn.execute(
            """
            SELECT acknowledgement_id
              FROM human_operations.alert_acknowledgement
             WHERE tenant_id=%s AND logical_action_id=%s
            """, (tenant, logical_id))
        prior = await cur.fetchone()
        if prior:
            return {"acknowledgement_id": prior[0], "replayed": True}
        await conn.execute(
            """
            INSERT INTO human_operations.alert_acknowledgement
                (tenant_id, acknowledgement_id, alert_id, principal_id,
                 logical_action_id, content_hash, authority_snapshot,
                 note)
            VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s)
            """,
            (tenant, ack_id, alert_id, actor, logical_id,
             _hash(content), json.dumps(snapshot), body.note))
        await record_audit_event(
            conn, tenant, action="alerting.alert.acknowledged",
            actor_kind="principal", actor_id=actor,
            subject_type="alert", subject_id=alert_id)
        await conn.commit()
    return {"acknowledgement_id": ack_id,
            "logical_action_id": logical_id}


# ---------------------------------------------------------------------------
# Resource responsibility — multiple concurrent principals, terminal
# closure, never reopened
# ---------------------------------------------------------------------------


class ResponsibilityCreate(BaseModel):
    monitoring_resource_id: str
    principal_id: str
    responsibility_role: str = "operator"
    assignment_source: str = "manual"
    logical_action_id: str | None = None


@router.post("/resources/responsibilities",
             status_code=status.HTTP_201_CREATED)
async def assign_responsibility(request: Request,
                                body: ResponsibilityCreate,
                                tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    actor = ctx.get("principal_id", "dev-operator")
    if body.responsibility_role not in _RESP_ROLES:
        raise HTTPException(status_code=422,
                            detail=f"role one of {_RESP_ROLES}")
    logical_id = (body.logical_action_id
                  or f"resp_{secrets.token_urlsafe(12)}")
    assign_id = f"resp_{secrets.token_urlsafe(12)}"
    content = {"monitoring_resource_id": body.monitoring_resource_id,
               "principal_id": body.principal_id,
               "responsibility_role": body.responsibility_role}
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "SELECT 1 FROM monitoring.monitoring_resource "
            "WHERE tenant_id=%s AND monitoring_resource_id=%s",
            (tenant, body.monitoring_resource_id))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404,
                                detail="resource not found")
        snapshot = await _authority_snapshot(conn, tenant, actor)
        cur = await conn.execute(
            """
            SELECT responsibility_assignment_id
              FROM human_operations.resource_responsibility_assignment
             WHERE tenant_id=%s AND logical_action_id=%s
            """, (tenant, logical_id))
        prior = await cur.fetchone()
        if prior:
            return {"responsibility_assignment_id": prior[0],
                    "replayed": True}
        await conn.execute(
            """
            INSERT INTO human_operations.resource_responsibility_assignment
                (tenant_id, responsibility_assignment_id,
                 monitoring_resource_id, principal_id,
                 responsibility_role, assignment_source,
                 logical_action_id, content_hash,
                 assigned_by_principal_id, authority_snapshot)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb)
            """,
            (tenant, assign_id, body.monitoring_resource_id,
             body.principal_id, body.responsibility_role,
             body.assignment_source, logical_id, _hash(content),
             actor, json.dumps(snapshot)))
        await record_audit_event(
            conn, tenant, action="ops.responsibility.assigned",
            actor_kind="principal", actor_id=actor,
            subject_type="monitoring_resource",
            subject_id=body.monitoring_resource_id,
            detail={"principal_id": body.principal_id,
                    "role": body.responsibility_role})
        await conn.commit()
    return {"responsibility_assignment_id": assign_id,
            "logical_action_id": logical_id}


class EndResponsibility(BaseModel):
    end_reason: str


@router.post("/resources/responsibilities/{assignment_id}/end")
async def end_responsibility(request: Request, assignment_id: str,
                             body: EndResponsibility,
                             tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    actor = ctx.get("principal_id", "dev-operator")
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            UPDATE human_operations.resource_responsibility_assignment
               SET effective_until = transaction_timestamp(),
                   ended_by_principal_id = %s,
                   end_reason = %s
             WHERE tenant_id=%s AND responsibility_assignment_id=%s
               AND effective_until IS NULL
            """, (actor, body.end_reason, tenant, assignment_id))
        if cur.rowcount != 1:
            raise HTTPException(
                status_code=404,
                detail="assignment not found or already closed")
        await record_audit_event(
            conn, tenant, action="ops.responsibility.ended",
            actor_kind="principal", actor_id=actor,
            subject_type="responsibility_assignment",
            subject_id=assignment_id,
            detail={"end_reason": body.end_reason})
        await conn.commit()
    return {"responsibility_assignment_id": assignment_id,
            "state": "ended"}


# ---------------------------------------------------------------------------
# Native visibility — platform_native_authenticated_view@1 only.
# Requirement needs an ACTIVE alert; receipt must come from the
# exact required viewer and may be late (post-resolution is late
# evidence — it never mutates alert/action state).
# ---------------------------------------------------------------------------


class VisibilityRequirementCreate(BaseModel):
    required_viewer_principal_id: str
    viewer_side: str = "internal"
    presentation_ref: str = "alert_detail_view"
    logical_action_id: str | None = None


@router.post("/alerts/{alert_id}/visibility-requirements",
             status_code=status.HTTP_201_CREATED)
async def create_visibility_requirement(
        alert_id: str, request: Request,
        body: VisibilityRequirementCreate,
        tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    actor = ctx.get("principal_id", "dev-operator")
    if body.viewer_side not in ("internal", "customer"):
        raise HTTPException(status_code=422,
                            detail="viewer_side internal|customer")
    logical_id = (body.logical_action_id
                  or f"vreq_{secrets.token_urlsafe(12)}")
    req_id = f"vreq_{secrets.token_urlsafe(12)}"
    content = {"alert_id": alert_id,
               "required_viewer_principal_id":
                   body.required_viewer_principal_id,
               "viewer_side": body.viewer_side,
               "presentation_ref": body.presentation_ref}
    async with db_tenant_connection(tenant) as conn:
        lifecycle = await _alert_or_404(conn, tenant, alert_id)
        if lifecycle != "active":
            raise HTTPException(
                status_code=409,
                detail="visibility requirement requires an "
                       "ACTIVE alert")
        snapshot = await _authority_snapshot(conn, tenant, actor)
        cur = await conn.execute(
            """
            SELECT visibility_requirement_id
              FROM human_operations.visibility_requirement
             WHERE tenant_id=%s AND logical_action_id=%s
            """, (tenant, logical_id))
        prior = await cur.fetchone()
        if prior:
            return {"visibility_requirement_id": prior[0],
                    "replayed": True}
        await conn.execute(
            """
            INSERT INTO human_operations.visibility_requirement
                (tenant_id, visibility_requirement_id, alert_id,
                 required_viewer_principal_id, viewer_side,
                 capability_class, presentation_ref,
                 logical_action_id, content_hash,
                 created_by_principal_id, authority_snapshot)
            VALUES (%s,%s,%s,%s,%s,
                    'platform_native_authenticated_view@1',
                    %s,%s,%s,%s,%s::jsonb)
            """,
            (tenant, req_id, alert_id,
             body.required_viewer_principal_id, body.viewer_side,
             body.presentation_ref, logical_id, _hash(content),
             actor, json.dumps(snapshot)))
        await record_audit_event(
            conn, tenant,
            action="ops.visibility_requirement.created",
            actor_kind="principal", actor_id=actor,
            subject_type="alert", subject_id=alert_id,
            detail={"viewer": body.required_viewer_principal_id,
                    "side": body.viewer_side})
        await conn.commit()
    return {"visibility_requirement_id": req_id,
            "logical_action_id": logical_id}


@router.post("/visibility-requirements/{requirement_id}/receipts",
             status_code=status.HTTP_201_CREATED)
async def record_visibility_receipt(
        requirement_id: str, request: Request,
        tenant_id: str | None = None) -> dict:
    """The exact required viewer records their native view. May be
    late (alert already resolved) — it is evidence, never a
    mutation of alert/action state."""
    tenant = _authoritative_tenant(request, tenant_id)
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    actor = ctx.get("principal_id", "dev-operator")
    session_evidence = {
        "session_generation":
            ctx.get("session_generation"),
        "authenticated_at": ctx.get("ts")}
    receipt_id = f"vrcpt_{secrets.token_urlsafe(12)}"
    logical_id = f"vrcpt:{requirement_id}:{actor}"
    content = {"visibility_requirement_id": requirement_id,
               "viewer_principal_id": actor}
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT required_viewer_principal_id, alert_id
              FROM human_operations.visibility_requirement
             WHERE tenant_id=%s AND visibility_requirement_id=%s
            """, (tenant, requirement_id))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404,
                                detail="requirement not found")
        if row[0] != actor:
            raise HTTPException(
                status_code=403,
                detail="receipt requires the exact required viewer")
        snapshot = await _authority_snapshot(conn, tenant, actor)
        cur = await conn.execute(
            """
            SELECT visibility_receipt_id
              FROM human_operations.visibility_receipt
             WHERE tenant_id=%s AND logical_action_id=%s
            """, (tenant, logical_id))
        prior = await cur.fetchone()
        if prior:
            return {"visibility_receipt_id": prior[0],
                    "replayed": True}
        await conn.execute(
            """
            INSERT INTO human_operations.visibility_receipt
                (tenant_id, visibility_receipt_id,
                 visibility_requirement_id, viewer_principal_id,
                 logical_action_id, content_hash,
                 authority_snapshot, session_evidence)
            VALUES (%s,%s,%s,%s,%s,%s,%s::jsonb,%s::jsonb)
            """,
            (tenant, receipt_id, requirement_id, actor,
             logical_id, _hash(content), json.dumps(snapshot),
             json.dumps(session_evidence)))
        await record_audit_event(
            conn, tenant, action="ops.visibility_receipt.recorded",
            actor_kind="principal", actor_id=actor,
            subject_type="visibility_requirement",
            subject_id=requirement_id)
        await conn.commit()
    return {"visibility_receipt_id": receipt_id,
            "logical_action_id": logical_id}


# ---------------------------------------------------------------------------
# Reads — timeline + current projection
# ---------------------------------------------------------------------------


@router.get("/alerts/{alert_id}/timeline")
async def alert_timeline(alert_id: str, request: Request,
                         tenant_id: str | None = None) -> dict:
    """Read projection over assignment/ack/visibility facts."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        await _alert_or_404(conn, tenant, alert_id)
        events: list[dict] = []
        cur = await conn.execute(
            """
            SELECT action_assignment_id, owner_principal_id,
                   action_kind, effective_from, effective_until,
                   end_reason
              FROM human_operations.alert_action_assignment
             WHERE tenant_id=%s AND alert_id=%s
             ORDER BY effective_from
            """, (tenant, alert_id))
        for r in await cur.fetchall():
            events.append({"kind": "action_assigned", "id": r[0],
                           "owner": r[1], "action": r[2],
                           "at": r[3].isoformat()})
            if r[4]:
                events.append({"kind": "action_ended", "id": r[0],
                               "reason": r[5], "at": r[4].isoformat()})
        cur = await conn.execute(
            """
            SELECT acknowledgement_id, principal_id, note,
                   acknowledged_at
              FROM human_operations.alert_acknowledgement
             WHERE tenant_id=%s AND alert_id=%s
            """, (tenant, alert_id))
        for r in await cur.fetchall():
            events.append({"kind": "acknowledged", "id": r[0],
                           "principal_id": r[1], "note": r[2],
                           "at": r[3].isoformat()})
        cur = await conn.execute(
            """
            SELECT visibility_requirement_id,
                   required_viewer_principal_id, viewer_side,
                   created_at
              FROM human_operations.visibility_requirement
             WHERE tenant_id=%s AND alert_id=%s
            """, (tenant, alert_id))
        for r in await cur.fetchall():
            events.append({"kind": "visibility_required", "id": r[0],
                           "viewer": r[1], "side": r[2],
                           "at": r[3].isoformat()})
        cur = await conn.execute(
            """
            SELECT vr.visibility_receipt_id, vr.viewer_principal_id,
                   vr.observed_at
              FROM human_operations.visibility_receipt vr
              JOIN human_operations.visibility_requirement rq
                ON rq.tenant_id = vr.tenant_id
               AND rq.visibility_requirement_id =
                   vr.visibility_requirement_id
             WHERE vr.tenant_id=%s AND rq.alert_id=%s
            """, (tenant, alert_id))
        for r in await cur.fetchall():
            events.append({"kind": "visibility_received", "id": r[0],
                           "viewer": r[1], "at": r[2].isoformat()})
        events.sort(key=lambda e: e["at"])
        cur = await conn.execute(
            """
            SELECT current_action, owner_principal_id,
                   projection_revision
              FROM human_operations.current_action_projection
             WHERE tenant_id=%s AND alert_id=%s
            """, (tenant, alert_id))
        proj = await cur.fetchone()
    return {"alert_id": alert_id,
            "current_action": ({"action": proj[0], "owner": proj[1],
                                "revision": proj[2]}
                               if proj else
                               {"action": "no_human_action_required",
                                "owner": None, "revision": 0}),
            "timeline": events}
