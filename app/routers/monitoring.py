"""Monitoring domain router — source planning and health projection."""

from __future__ import annotations

from typing import Annotated, Sequence

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

from app.auth import utcnow
from app.tenant import make_dev_tenant_context
from jlmirror_monitoring.source import (
    ConfiguredProviderScope,
    CreateMonitoringSourceCommand,
    ZabbixProviderConfiguration,
    plan_source_creation,
)
from jlmirror_monitoring.health_projection import (
    EvidenceState,
    HealthClass,
    HealthDecision,
    HealthInput,
    SeverityClass,
    derive_health,
    semantic_health_change,
)

router = APIRouter(prefix="/api/v1/monitoring", tags=["monitoring"])


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
