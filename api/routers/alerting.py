"""Alerting router — canonical alert core model (wave4.alerting-core-model@1).

Reads are tenant-scoped and bounded. Transitions are committed only
through the repo's transition engine — there is no automatic
creation/resolution authority (policy evaluation is a separately
gated authorization), so the transition command endpoint is
development-gated: callers must supply the full accepted-decision
evidence including policy_id/policy_version.
"""

from __future__ import annotations

import secrets as _secrets

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.alerting_repo import (
    AlertingError,
    IntegrityFailure,
    commit_alert_transition,
    get_alert,
    list_alert_transitions,
    list_alerts,
)
from shared.config import settings
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/alerting", tags=["alerting"])


def _serialize(row: dict) -> dict:
    for k in ("opened_at", "resolved_at", "last_confirmed_at",
              "occurred_at", "created_at"):
        if row.get(k) is not None:
            row[k] = row[k].isoformat()
    return row


@router.get("/alerts")
async def list_alerts_endpoint(
        request: Request,
        tenant_id: str | None = None,
        lifecycle_state: str | None = None,
        source_id: str | None = None,
        limit: int = 50) -> list[dict]:
    """Bounded tenant-scoped alert projection reads."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        rows = await list_alerts(
            conn, tenant, lifecycle_state, source_id, limit)
    return [_serialize(r) for r in rows]


@router.get("/alerts/{alert_id}")
async def get_alert_endpoint(
        alert_id: str, request: Request,
        tenant_id: str | None = None) -> dict:
    """Alert projection + its immutable transition history."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        alert = await get_alert(conn, tenant, alert_id)
        if alert is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="alert not found")
        transitions = await list_alert_transitions(conn, tenant, alert_id)
    return {"alert": _serialize(alert),
            "transitions": [_serialize(t) for t in transitions]}


class TransitionRequest(BaseModel):
    """Explicit accepted-decision evidence — required because there
    is no policy-evaluation runtime to produce it."""
    alert_id: str | None = None          # generated when absent (create)
    alert_transition_id: str | None = None
    to_state: str                        # active | resolved
    transition_reason: str = "operator_decision"
    source_kind: str                     # monitoring_problem | monitoring_health_projection
    monitoring_source_id: str
    source_instance_generation: str
    monitoring_resource_id: str | None = None
    problem_id: str | None = None
    source_transition_id: str
    source_projection_revision: int
    policy_id: str
    policy_version: int


@router.post("/alerts/transitions", status_code=status.HTTP_201_CREATED)
async def commit_transition_endpoint(
        body: TransitionRequest, request: Request,
        tenant_id: str | None = None) -> dict:
    """Commit one alert lifecycle transition with explicit evidence.

    Development-gated: the policy/evaluation authorization that would
    produce this evidence automatically is a separate gate — until
    then this is the operator/verification path only.
    """
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    tenant = _authoritative_tenant(request, tenant_id)
    try:
        async with db_tenant_connection(tenant) as conn:
            alert = await commit_alert_transition(
                conn, tenant,
                alert_transition_id=body.alert_transition_id
                or f"alt-tr_{_secrets.token_urlsafe(18)}",
                alert_id=body.alert_id
                or f"alt_{_secrets.token_urlsafe(14)}",
                to_state=body.to_state,
                transition_reason=body.transition_reason,
                source_kind=body.source_kind,
                monitoring_source_id=body.monitoring_source_id,
                source_instance_generation=body.source_instance_generation,
                monitoring_resource_id=body.monitoring_resource_id,
                problem_id=body.problem_id,
                source_transition_id=body.source_transition_id,
                source_projection_revision=body.source_projection_revision,
                policy_id=body.policy_id,
                policy_version=body.policy_version,
                correlation_id=body.alert_transition_id
                or f"corr_{_secrets.token_urlsafe(12)}",
            )
            await conn.commit()
    except IntegrityFailure as exc:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    except AlertingError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=str(exc)) from exc
    return {"alert": _serialize(alert)}
