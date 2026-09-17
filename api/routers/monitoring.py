"""Monitoring domain router — real sources + health projection.

Real persistence: sources are created durably in `monitoring.*` and
validated by the validation worker (claim -> hostgroup.get -> fenced
complete). `/plan` and `/health/derive` expose the domain planner and
projector for exploration.

Tenant binding: when a signed BFF context is present
(request.state.jlmirror_context), the bound tenant is authority —
client-supplied tenant identifiers are never trusted. In development
sandbox mode (no BFF context), explicit tenant_id is accepted.
"""

from __future__ import annotations

import secrets
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, Request, status
from pydantic import BaseModel

from shared.config import settings
from shared.db import db_connection
from shared.monitoring_repo import (
    create_zabbix_source,
    enqueue_sync_operation,
    get_source,
    list_resources,
    list_sources,
)
from jlmirror_monitoring.source import (
    ConfiguredProviderScope,
    CreateMonitoringSourceCommand,
    ZabbixProviderConfiguration,
    plan_source_creation,
)
from jlmirror_monitoring.health_projection import (
    EvidenceState,
    HealthInput,
    SeverityClass,
    derive_health,
)

router = APIRouter(prefix="/api/v1/monitoring", tags=["monitoring"])


def _authoritative_tenant(request: Request, body_tenant: str | None) -> str:
    """Resolve the effective tenant — BFF context wins, dev fallback."""
    ctx = getattr(request.state, "jlmirror_context", None)
    if ctx is not None and ctx.get("tenant_id"):
        return ctx["tenant_id"]
    if settings.is_development and body_tenant:
        return body_tenant
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="no tenant authority",
    )


# ---------------------------------------------------------------------------
# Source planning
# ---------------------------------------------------------------------------


class ProviderScopeRequest(BaseModel):
    host_group_refs: list[str]


class SourcePlanRequest(BaseModel):
    tenant_id: str
    display_name: str
    provider_instance_ref: str
    base_url: str
    host_group_refs: list[str]
    credential_binding_ref: str


class SourcePlanResponse(BaseModel):
    monitoring_source_id: str
    provider_profile: str
    configuration_revision: int
    scope_revision: int
    sync_operation_id: str
    audit_evidence_id: str


@router.post("/sources/plan", response_model=SourcePlanResponse)
async def plan_source(
    body: SourcePlanRequest,
    x_principal_id: Annotated[str | None, Header()] = None,
    x_credential_generation: Annotated[str | None, Header()] = None,
) -> SourcePlanResponse:
    """Plan a monitoring source creation (Zabbix provider)."""
    provider_config = ZabbixProviderConfiguration(base_url=body.base_url)
    provider_scope = ConfiguredProviderScope.from_refs(body.host_group_refs)
    command = CreateMonitoringSourceCommand(
        tenant_id=body.tenant_id,
        display_name=body.display_name,
        provider_instance_ref=body.provider_instance_ref,
        provider_configuration=provider_config,
        credential_binding_ref=body.credential_binding_ref,
        configured_provider_scope=provider_scope,
    )
    plan = plan_source_creation(command)
    return SourcePlanResponse(
        monitoring_source_id=plan.source.monitoring_source_id,
        provider_profile=plan.source.provider_profile,
        configuration_revision=plan.source.configuration_revision,
        scope_revision=plan.source.scope_revision,
        sync_operation_id=plan.sync_operation.monitoring_sync_operation_id,
        audit_evidence_id=plan.audit_evidence_id,
    )


# ---------------------------------------------------------------------------
# Health projection
# ---------------------------------------------------------------------------


class HealthDeriveRequest(BaseModel):
    tenant_id: str
    monitoring_source_id: str
    source_instance_generation: str
    monitoring_resource_id: str
    source_is_current: bool
    resource_present: bool
    scope_is_current_and_in_scope: bool
    problem_completeness_is_current: bool
    evidence_state: str
    active_problem_severities: list[str]
    reason_refs: list[str] = []


class HealthDeriveResponse(BaseModel):
    health_class: str
    evidence_state: str
    reason_refs: list[str]


@router.post("/health/derive", response_model=HealthDeriveResponse)
async def derive_health_endpoint(body: HealthDeriveRequest) -> HealthDeriveResponse:
    """Derive a health decision from monitoring evidence."""
    try:
        health_input = HealthInput(
            tenant_id=body.tenant_id,
            monitoring_source_id=body.monitoring_source_id,
            source_instance_generation=body.source_instance_generation,
            monitoring_resource_id=body.monitoring_resource_id,
            source_is_current=body.source_is_current,
            resource_present=body.resource_present,
            scope_is_current_and_in_scope=body.scope_is_current_and_in_scope,
            problem_completeness_is_current=body.problem_completeness_is_current,
            evidence_state=EvidenceState(body.evidence_state),
            active_problem_severities=[SeverityClass(s) for s in body.active_problem_severities],
            reason_refs=tuple(body.reason_refs),
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    decision = derive_health(health_input)
    return HealthDeriveResponse(
        health_class=decision.health_class.value,
        evidence_state=decision.evidence_state.value,
        reason_refs=list(decision.reason_refs),
    )


# ---------------------------------------------------------------------------
# Real sources (durable persistence + validation worker)
# ---------------------------------------------------------------------------


class SourceCreateRequest(BaseModel):
    tenant_id: str | None = None  # dev-sandbox only; BFF ctx wins when present
    display_name: str
    provider_instance_ref: str
    provider_base_url: str
    credential_binding_ref: str
    host_group_refs: list[str]
    idempotency_key: str | None = None


class SourceResponse(BaseModel):
    monitoring_source_id: str
    monitoring_sync_operation_id: str
    idempotency_state: str
    reused: bool


@router.post("/sources", response_model=SourceResponse, status_code=201)
async def create_source(body: SourceCreateRequest, request: Request) -> SourceResponse:
    """Create a monitoring source durably (Zabbix profile).

    Atomic create-or-observe under the idempotency key; enqueues the
    `validation_and_initial_sync` operation for the worker.
    """
    tenant_id = _authoritative_tenant(request, body.tenant_id)
    try:
        # Domain validation before persistence (canonical input shape)
        ZabbixProviderConfiguration(base_url=body.provider_base_url)
        ConfiguredProviderScope.from_refs(body.host_group_refs)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    key = body.idempotency_key or f"idem-{secrets.token_urlsafe(16)}"
    try:
        async with db_connection() as conn:
            result = await create_zabbix_source(
                conn,
                tenant_id=tenant_id,
                idempotency_key=key,
                display_name=body.display_name,
                provider_instance_ref=body.provider_instance_ref,
                provider_base_url=body.provider_base_url,
                credential_binding_ref=body.credential_binding_ref,
                host_group_refs=body.host_group_refs,
            )
    except ValueError as exc:
        if "idempotency.key_reused" in str(exc):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return SourceResponse(**result)


class SourceDetailResponse(BaseModel):
    monitoring_source_id: str
    display_name: str
    operational_evidence_state: str
    configuration_revision: int
    scope_revision: int
    provider_instance_ref: str
    provider_base_url: str


@router.get("/sources", response_model=list[SourceDetailResponse])
async def list_sources_endpoint(request: Request, tenant_id: str | None = None) -> list[SourceDetailResponse]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_connection() as conn:
        rows = await list_sources(conn, tenant)
    return [
        SourceDetailResponse(
            monitoring_source_id=r["monitoring_source_id"],
            display_name=r["display_name"],
            operational_evidence_state=r["operational_evidence_state"],
            configuration_revision=r["configuration_revision"],
            scope_revision=r["scope_revision"],
            provider_instance_ref=r["provider_instance_ref"],
            provider_base_url=r["provider_base_url"],
        )
        for r in rows
    ]


@router.get("/sources/{source_id}")
async def get_source_endpoint(source_id: str, request: Request, tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_connection() as conn:
        row = await get_source(conn, tenant, source_id)
    if row is None:
        raise HTTPException(status_code=404, detail="source not found")
    row["configured_provider_scope"] = (
        row["configured_provider_scope"]
        if isinstance(row["configured_provider_scope"], dict)
        else {}
    )
    for k in ("last_successful_sync_at", "last_attempt_at"):
        if row.get(k) is not None:
            row[k] = row[k].isoformat()
    return row


@router.post("/sync/run", status_code=200)
async def run_sync_once() -> dict:
    """Dev trigger: run one validation pass over pending operations.

    In production the validation worker runs as its own process; this
    endpoint exists for local development and integration tests.
    """
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    import asyncio

    import psycopg
    from workers.validation import _process_pending

    def _run() -> int:
        with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
            return _process_pending(conn)

    processed = await asyncio.to_thread(_run)
    return {"processed": processed}


# ---------------------------------------------------------------------------
# Host inventory
# ---------------------------------------------------------------------------


@router.post("/sources/{source_id}/inventory", status_code=202)
async def enqueue_inventory(source_id: str, request: Request,
                            tenant_id: str | None = None) -> dict:
    """Enqueue a `host_inventory_sync` operation for the source.

    Snapshots the source's current generation + revisions into the new
    operation; the inventory worker claims it and collects host.get.
    """
    tenant = _authoritative_tenant(request, tenant_id)
    try:
        async with db_connection() as conn:
            op_id = await enqueue_sync_operation(
                conn, tenant_id=tenant, source_id=source_id,
                responsibility_kind="host_inventory_sync",
            )
    except ValueError:
        raise HTTPException(status_code=404, detail="source not found")
    return {"monitoring_sync_operation_id": op_id, "state": "pending"}


@router.get("/sources/{source_id}/resources")
async def list_resources_endpoint(source_id: str, request: Request,
                                  tenant_id: str | None = None) -> list[dict]:
    """List canonical monitored resources for a source."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_connection() as conn:
        rows = await list_resources(conn, tenant, source_id)
    for r in rows:
        for k in ("last_observed_at", "removed_at"):
            if r.get(k) is not None:
                r[k] = r[k].isoformat()
    return rows


@router.post("/inventory/run", status_code=200)
async def run_inventory_once() -> dict:
    """Dev trigger: one host-inventory pass over pending operations."""
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    import asyncio

    import psycopg
    from workers.inventory import _process_pending

    def _run() -> int:
        with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
            return _process_pending(conn)

    processed = await asyncio.to_thread(_run)
    return {"processed": processed}
