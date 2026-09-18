"""Observability domain router — reliability/observability catalog joins."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from jlmirror_observability.catalog import (
    ObservationError,
    ReliabilityObservabilityJoin,
    join_for,
)

router = APIRouter(prefix="/api/v1/observability", tags=["observability"])


class ObservabilityJoinResponse(BaseModel):
    reliability_profile_id: str
    profile_version: int
    diagnostic_signal_ids: list[str]
    health_profile_ids: list[str]
    sli_profile_ids: list[str]
    impact_sli_profile_ids: list[str]
    alert_profile_ids: list[str]
    required_fault_vectors: list[str]
    direct_sli_no_applicable_case_reason: str | None
    product_selector: str | None


def _join_to_response(join: ReliabilityObservabilityJoin) -> ObservabilityJoinResponse:
    return ObservabilityJoinResponse(
        reliability_profile_id=join.reliability_profile_id,
        profile_version=join.profile_version,
        diagnostic_signal_ids=list(join.diagnostic_signal_ids),
        health_profile_ids=list(join.health_profile_ids),
        sli_profile_ids=list(join.sli_profile_ids),
        impact_sli_profile_ids=list(join.impact_sli_profile_ids),
        alert_profile_ids=list(join.alert_profile_ids),
        required_fault_vectors=list(join.required_fault_vectors),
        direct_sli_no_applicable_case_reason=join.direct_sli_no_applicable_case_reason,
        product_selector=join.product_selector,
    )


@router.get("/profiles", response_model=list[str])
async def list_profiles() -> list[str]:
    """List all known reliability profile IDs."""
    # The catalog exposes joins via a private dict; we enumerate via a known set.
    # In production this would come from a repository.
    from jlmirror_observability.catalog import RELIABILITY_OBSERVABILITY_JOINS
    return sorted(RELIABILITY_OBSERVABILITY_JOINS.keys())


@router.get("/profiles/{profile_id}", response_model=ObservabilityJoinResponse)
async def get_profile(profile_id: str) -> ObservabilityJoinResponse:
    """Get the observability join for a reliability profile."""
    try:
        join = join_for(profile_id)
    except ObservationError as exc:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail=str(exc)) from exc
    return _join_to_response(join)


@router.get("/slo")
async def slo_snapshot() -> dict:
    """In-process SLO probe (ADR-017): latency distribution + error
    rate per endpoint over the last N requests. SLO definitions
    come later; the observation points are live now."""
    from shared import slo
    return slo.snapshot()


@router.get("/audit-events")
async def list_audit_events_endpoint(
        request: Request,
        tenant_id: str | None = None,
        action: str | None = None,
        subject_type: str | None = None,
        subject_id: str | None = None,
        limit: int = 100) -> list[dict]:
    """Durable accountability evidence (SEC-AUD): immutable audit
    events committed atomically with the mutations they describe —
    newest first, tenant-scoped, bounded."""
    from api.routers.monitoring import _authoritative_tenant
    from shared.audit import list_audit_events
    from shared.db import db_tenant_connection

    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        rows = await list_audit_events(
            conn, tenant, action=action, subject_type=subject_type,
            subject_id=subject_id, limit=limit)
    for r in rows:
        if r.get("occurred_at") is not None:
            r["occurred_at"] = r["occurred_at"].isoformat()
    return rows
