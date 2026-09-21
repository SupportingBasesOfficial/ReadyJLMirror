"""G10 ITSM incident router — canonical g10.itsm-incident@1.

All Incident effects go through the canonical SECURITY DEFINER
functions in `itsm.*` — the app role holds no direct table
privilege. Each call runs inside its own transaction under
`SET LOCAL ROLE jlmirror_g10_itsm_app_invoker`, so the boundary
never leaks into neighbouring statements.

G10 owns Incident state only: it never mutates Alert lifecycle,
G8 action ownership or G9 delivery state. Provider ticket refs
are evidence/linkage, never platform identity.
"""

from __future__ import annotations

import json
import secrets

import psycopg
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.db import db_connection

router = APIRouter(prefix="/api/v1/alerting", tags=["itsm"])

_INVOKER_ROLE = "jlmirror_g10_itsm_app_invoker"
_POLICY_REVISION = "g10.itsm-incident@1"

# g10.* RAISE EXCEPTION -> HTTP shape. Unknown g10.* defaults to 409.
_G10_ERRORS = {
    "g10.incident_missing": status.HTTP_404_NOT_FOUND,
    "g10.incident_input_invalid": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "g10.assignment_input_invalid":
        status.HTTP_422_UNPROCESSABLE_ENTITY,
    "g10.comment_input_invalid": status.HTTP_422_UNPROCESSABLE_ENTITY,
    "g10.active_alert_required": status.HTTP_409_CONFLICT,
    "g10.current_authority_required": status.HTTP_403_FORBIDDEN,
}


async def _g10(fn: str, params: tuple) -> dict | list | None:
    """Invoke one canonical g10 function inside a dedicated
    transaction as the app invoker — never alongside other SQL."""
    async with db_connection() as conn:
        try:
            async with conn.transaction():
                await conn.execute(
                    f"SET LOCAL ROLE {_INVOKER_ROLE}")
                cur = await conn.execute(
                    f"SELECT itsm.{fn}("
                    + ",".join(["%s"] * len(params)) + ")",
                    params)
                row = await cur.fetchone()
        except psycopg.errors.RaiseException as exc:
            msg = str(exc)
            code = next(
                (v for k, v in _G10_ERRORS.items() if k in msg),
                status.HTTP_409_CONFLICT)
            raise HTTPException(status_code=code, detail=msg) from exc
        return row[0] if row else None


def _snapshot(tenant: str, actor: str, action: str) -> str:
    """Bounded current-authority evidence — validated inside the
    functions; never grants anything by itself."""
    return json.dumps(
        {"tenant_id": tenant, "principal_id": actor,
         "current": True, "action": action,
         "policy_revision": _POLICY_REVISION},
        separators=(",", ":"))


def _actor(request: Request) -> str:
    ctx = request.state.jlmirror_context or {}
    return ctx.get("principal_id", "dev-operator")


def _logical(body_id: str | None) -> str:
    return body_id or f"la_{secrets.token_urlsafe(12)}"


class IncidentCreate(BaseModel):
    title: str
    description: str | None = None
    logical_action_id: str | None = None


@router.post("/alerts/{alert_id}/incidents",
             status_code=status.HTTP_201_CREATED)
async def create_incident(alert_id: str, request: Request,
                          body: IncidentCreate,
                          tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    actor = _actor(request)
    res = await _g10(
        "g10_create_incident",
        (tenant, alert_id, body.title, body.description, actor,
         _logical(body.logical_action_id),
         _snapshot(tenant, actor, "alerting:operate")))
    return res


@router.get("/alerts/{alert_id}/incidents")
async def list_alert_incidents(alert_id: str, request: Request,
                               tenant_id: str | None = None) -> list:
    tenant = _authoritative_tenant(request, tenant_id)
    return await _g10("g10_list_alert_incidents", (tenant, alert_id))


@router.get("/incidents/{incident_id}")
async def get_incident(incident_id: str, request: Request,
                       tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    res = await _g10("g10_get_incident", (tenant, incident_id))
    if res is None:
        raise HTTPException(status_code=404, detail="incident not found")
    return res


class TransitionCreate(BaseModel):
    target_state: str
    logical_action_id: str | None = None


@router.post("/incidents/{incident_id}/transition")
async def transition_incident(incident_id: str, request: Request,
                              body: TransitionCreate,
                              tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    actor = _actor(request)
    return await _g10(
        "g10_transition_incident",
        (tenant, incident_id, body.target_state, actor,
         _logical(body.logical_action_id),
         _snapshot(tenant, actor, "alerting:operate")))


class AssignmentCreate(BaseModel):
    assignee_principal_id: str
    logical_action_id: str | None = None


@router.post("/incidents/{incident_id}/assignments",
             status_code=status.HTTP_201_CREATED)
async def assign_incident(incident_id: str, request: Request,
                          body: AssignmentCreate,
                          tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    actor = _actor(request)
    return await _g10(
        "g10_assign_incident",
        (tenant, incident_id, body.assignee_principal_id, actor,
         _logical(body.logical_action_id),
         _snapshot(tenant, actor, "alerting:operate")))


class CommentCreate(BaseModel):
    body: str
    logical_action_id: str | None = None


@router.post("/incidents/{incident_id}/comments",
             status_code=status.HTTP_201_CREATED)
async def add_comment(incident_id: str, request: Request,
                      body: CommentCreate,
                      tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    actor = _actor(request)
    return await _g10(
        "g10_add_comment",
        (tenant, incident_id, body.body, actor,
         _logical(body.logical_action_id),
         _snapshot(tenant, actor, "alerting:operate")))
