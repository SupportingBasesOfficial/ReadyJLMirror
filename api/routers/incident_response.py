"""G11 Incident Response router — ApplicationErrorEvent push ingest +
IncidentResponsePolicy per-tenant configuration.

All effects go through SECURITY DEFINER functions in `incident_response.*`
under SET LOCAL ROLE jlmirror_g11_ir_app_invoker. The policy evaluation
(severity threshold, auto_open_ticket, manual_override_only) runs in Python
so the router stays the single source of action-enqueue decisions.
"""

from __future__ import annotations

import hashlib
import json
import secrets
from datetime import datetime, timezone

import psycopg
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel, field_validator

from api.routers.monitoring import _authoritative_tenant
from shared.audit import record_audit_event
from shared.db import db_connection, db_tenant_connection

router = APIRouter(prefix="/api/v1/alerting", tags=["incident_response"])

_INVOKER_ROLE = "jlmirror_g11_ir_app_invoker"
_POLICY_REVISION = "g11.incident-response@1"

_SEVERITIES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"]
_SEVERITY_ORDER = {s: i for i, s in enumerate(_SEVERITIES)}

_G11_ERRORS = {
    "g11.event_missing": status.HTTP_404_NOT_FOUND,
    "g11.policy_invalid_severity": status.HTTP_422_UNPROCESSABLE_ENTITY,
}


async def _g11(fn: str, params: tuple):
    async with db_connection() as conn:
        try:
            async with conn.transaction():
                await conn.execute(f"SET LOCAL ROLE {_INVOKER_ROLE}")
                cur = await conn.execute(
                    f"SELECT incident_response.{fn}("
                    + ",".join(["%s"] * len(params)) + ")",
                    params)
                row = await cur.fetchone()
        except psycopg.errors.RaiseException as exc:
            msg = str(exc)
            code = next(
                (v for k, v in _G11_ERRORS.items() if k in msg),
                status.HTTP_409_CONFLICT)
            raise HTTPException(status_code=code, detail=msg) from exc
        return row[0] if row else None


def _actor(request: Request) -> str:
    ctx = getattr(request.state, "jlmirror_context", None) or {}
    return ctx.get("principal_id", "dev-operator")


def _minute_bucket(occurred_at: str) -> str:
    return occurred_at[:16]  # "2026-09-23T14:05"


def _deterministic_id(prefix: str, *parts: str) -> str:
    digest = hashlib.sha256("|".join(parts).encode()).hexdigest()
    return f"{prefix}{digest}"


def _evaluate_policy(severity_hint: str | None, policy: dict) -> list[str]:
    if policy.get("manual_override_only"):
        return []
    actions: list[str] = []
    threshold = policy.get("severity_threshold", "HIGH")
    hint_order = _SEVERITY_ORDER.get(severity_hint or "", -1)
    threshold_order = _SEVERITY_ORDER.get(threshold, _SEVERITY_ORDER["HIGH"])
    meets = hint_order >= threshold_order
    if meets:
        if policy.get("auto_open_ticket"):
            actions.append("open_ticket")
        for ch in (policy.get("notify_channels") or []):
            on_severities = ch.get("on_severities", [])
            if not on_severities or (severity_hint and severity_hint in on_severities):
                actions.append("notify")
                break
        for tr in (policy.get("automation_triggers") or []):
            if tr.get("event") == "ERROR_EVENT":
                actions.append("automation")
                break
    return actions


# ─── Policy endpoints ──────────────────────────────────────────────────────────

@router.get("/tenants/{path_tenant}/incident-response-policy")
async def get_policy(path_tenant: str, request: Request,
                     tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id or path_tenant)
    result = await _g11("g11_get_policy", (tenant,))
    return result or {}


class PolicyUpsert(BaseModel):
    severity_threshold: str = "HIGH"
    auto_open_ticket: bool = False
    manual_override_only: bool = False
    notify_channels: list[dict] = []
    automation_triggers: list[dict] = []

    @field_validator("severity_threshold")
    @classmethod
    def _valid_severity(cls, v: str) -> str:
        if v not in _SEVERITIES:
            raise ValueError(f"severity_threshold must be one of {_SEVERITIES}")
        return v


@router.put("/tenants/{path_tenant}/incident-response-policy")
async def upsert_policy(path_tenant: str, request: Request,
                        body: PolicyUpsert,
                        tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id or path_tenant)
    actor = _actor(request)
    from psycopg.types.json import Jsonb
    result = await _g11("g11_upsert_policy", (
        tenant,
        body.severity_threshold,
        body.auto_open_ticket,
        body.manual_override_only,
        Jsonb(body.notify_channels),
        Jsonb(body.automation_triggers),
        actor,
    ))
    return result or {}


# ─── Event push endpoints ──────────────────────────────────────────────────────

class ErrorEventPush(BaseModel):
    application_id: str
    error_code: str
    error_message: str
    occurred_at: str
    source_principal_id: str | None = None
    principal_id: str | None = None
    operation: str | None = None
    session_context: str | None = None
    severity_hint: str | None = None
    raw_payload: dict | None = None
    logical_action_id: str | None = None

    @field_validator("severity_hint")
    @classmethod
    def _valid_severity(cls, v: str | None) -> str | None:
        if v is not None and v not in _SEVERITIES:
            raise ValueError(f"severity_hint must be one of {_SEVERITIES}")
        return v


@router.post("/tenants/{path_tenant}/application-error-events",
             status_code=status.HTTP_202_ACCEPTED)
async def push_error_event(path_tenant: str, request: Request,
                           body: ErrorEventPush,
                           tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id or path_tenant)
    actor = _actor(request)
    logical_id = body.logical_action_id or f"aee_{secrets.token_urlsafe(12)}"

    # 1-minute bucket deduplication
    bucket = _minute_bucket(body.occurred_at)
    try:
        occurred_ts = datetime.fromisoformat(body.occurred_at.replace("Z", "+00:00"))
    except ValueError:
        raise HTTPException(status_code=422, detail="occurred_at must be ISO-8601")
    bucket_ts = occurred_ts.replace(second=0, microsecond=0)

    event_id = _deterministic_id(
        "evt:", tenant, body.application_id, body.error_code,
        bucket_ts.isoformat(), secrets.token_hex(8))

    from psycopg.types.json import Jsonb

    is_new = await _g11("g11_claim_dedupe", (
        tenant, body.application_id, body.error_code, bucket_ts, event_id,
    ))

    if not is_new:
        return {"status": "deduplicated", "bucket": bucket}

    await _g11("g11_store_event", (
        event_id, tenant, body.application_id, body.error_code,
        body.error_message, occurred_ts,
        body.source_principal_id or actor,
        body.principal_id, body.operation, body.session_context,
        body.severity_hint,
        Jsonb(body.raw_payload) if body.raw_payload else None,
        logical_id,
    ))

    # Fetch policy and evaluate actions
    policy = await _g11("g11_get_policy", (tenant,)) or {}
    action_kinds = _evaluate_policy(body.severity_hint, policy)
    enqueued: list[str] = []
    for kind in action_kinds:
        req_id = _deterministic_id(f"req_{kind}:", tenant, event_id, kind)
        await _g11("g11_enqueue_action", (tenant, event_id, kind, req_id))
        enqueued.append(kind)

    return {
        "status": "accepted",
        "event_id": event_id,
        "actions_enqueued": enqueued,
    }


@router.get("/tenants/{path_tenant}/application-error-events")
async def list_error_events(path_tenant: str, request: Request,
                            tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id or path_tenant)
    events = await _g11("g11_list_events", (tenant,))
    return {"events": events or []}


@router.get("/tenants/{path_tenant}/application-error-events/{event_id}")
async def get_error_event(path_tenant: str, event_id: str,
                          request: Request,
                          tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id or path_tenant)
    result = await _g11("g11_get_event", (tenant, event_id))
    return result or {}


# ─── Operator mark-as-processed ───────────────────────────────────────────────

class EventStatusUpdate(BaseModel):
    status: str

    @field_validator("status")
    @classmethod
    def _valid_status(cls, v: str) -> str:
        if v != "processed":
            raise ValueError(
                "only status='processed' is supported on this endpoint")
        return v


@router.patch(
    "/tenants/{path_tenant}/application-error-events/{event_id}",
    status_code=status.HTTP_200_OK,
)
async def mark_event_processed(
    path_tenant: str,
    event_id: str,
    request: Request,
    body: EventStatusUpdate,
    tenant_id: str | None = None,
) -> dict:
    """Mark an application-error-event as processed by an operator.

    Delegates the status update to incident_response.g11_mark_event_processed
    (SECURITY DEFINER, runs as jlmirror_g11_ir_executor) which validates
    tenant ownership and sets status = 'processed' on
    incident_response.application_error_event.

    The audit event is written in a separate tenant-scoped transaction
    because the invoker role (jlmirror_g11_ir_app_invoker) does not hold
    INSERT on audit.audit_event; only the base jlmirror_app role does.
    """
    tenant = _authoritative_tenant(request, tenant_id or path_tenant)
    actor = _actor(request)

    # 1. Validate event belongs to tenant and update status to 'processed'.
    #    g11_mark_event_processed raises g11.event_missing if not found,
    #    which _g11 maps to HTTP 404 via _G11_ERRORS.
    result = await _g11("g11_mark_event_processed", (tenant, event_id, actor))

    # 2. Audit event — separate tenant-context connection because
    #    SET LOCAL ROLE (used inside _g11) drops jlmirror_app permissions.
    async with db_tenant_connection(tenant) as conn:
        await record_audit_event(
            conn, tenant,
            action="incident_response.event.processed",
            actor_kind="principal",
            actor_id=actor,
            subject_type="application_error_event",
            subject_id=event_id,
            detail={"status": "processed"})
        await conn.commit()

    return result or {}
