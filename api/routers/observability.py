"""Observability domain router — reliability/observability catalog joins."""

from __future__ import annotations

import csv
import io
import json
from datetime import datetime

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
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


def _build_audit_clauses(
    tenant: str,
    action: str | None,
    subject_type: str | None,
    subject_id: str | None,
    actor_id: str | None,
    occurred_after: datetime | None,
    occurred_before: datetime | None,
) -> tuple[list[str], list]:
    """Build WHERE clauses and params for audit_event queries."""
    clauses: list[str] = ["tenant_id = %s"]
    params: list = [tenant]
    if action:
        clauses.append("action = %s")
        params.append(action)
    if subject_type:
        clauses.append("subject_type = %s")
        params.append(subject_type)
    if subject_id:
        clauses.append("subject_id = %s")
        params.append(subject_id)
    if actor_id:
        clauses.append("actor_id = %s")
        params.append(actor_id)
    if occurred_after:
        clauses.append("occurred_at > %s")
        params.append(occurred_after)
    if occurred_before:
        clauses.append("occurred_at < %s")
        params.append(occurred_before)
    return clauses, params


@router.get("/audit-events")
async def list_audit_events_endpoint(
        request: Request,
        tenant_id: str | None = None,
        action: str | None = None,
        subject_type: str | None = None,
        subject_id: str | None = None,
        actor_id: str | None = None,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        limit: int = 100,
        offset: int = 0) -> list[dict]:
    """Durable accountability evidence (SEC-AUD): immutable audit
    events committed atomically with the mutations they describe —
    newest first, tenant-scoped, bounded.

    Optional filters: action, subject_type, subject_id, actor_id,
    occurred_after (ISO 8601), occurred_before (ISO 8601)."""
    from api.routers.monitoring import _authoritative_tenant
    from shared.db import db_tenant_connection

    tenant = _authoritative_tenant(request, tenant_id)
    clauses, params = _build_audit_clauses(
        tenant, action, subject_type, subject_id,
        actor_id, occurred_after, occurred_before)
    params.append(min(limit, 200))
    params.append(max(offset, 0))

    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            f"""
            SELECT audit_event_id, action, actor_kind, actor_id,
                   subject_type, subject_id, detail, correlation_id,
                   occurred_at, tenant_id
              FROM audit.audit_event
             WHERE {' AND '.join(clauses)}
             ORDER BY occurred_at DESC
             LIMIT %s OFFSET %s
            """,
            tuple(params))
        keys = ("audit_event_id", "action", "actor_kind", "actor_id",
                "subject_type", "subject_id", "detail", "correlation_id",
                "occurred_at", "tenant_id")
        rows = [dict(zip(keys, r)) for r in await cur.fetchall()]

    for r in rows:
        if r.get("occurred_at") is not None:
            r["occurred_at"] = r["occurred_at"].isoformat()
    return rows


@router.get("/audit-events/export")
async def export_audit_events(
        request: Request,
        tenant_id: str | None = None,
        action: str | None = None,
        subject_type: str | None = None,
        subject_id: str | None = None,
        actor_id: str | None = None,
        occurred_after: datetime | None = None,
        occurred_before: datetime | None = None,
        limit: int = 10000):
    """Export audit events as a CSV file (SEC-AUD).

    Accepts the same filters as GET /audit-events.
    Returns Content-Type: text/csv with all matching events,
    newest first. Default limit: 10 000 rows."""
    from api.routers.monitoring import _authoritative_tenant
    from shared.db import db_tenant_connection

    tenant = _authoritative_tenant(request, tenant_id)
    clauses, params = _build_audit_clauses(
        tenant, action, subject_type, subject_id,
        actor_id, occurred_after, occurred_before)
    params.append(min(limit, 10_000))

    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            f"""
            SELECT occurred_at, actor_id, action, subject_type,
                   subject_id, tenant_id, detail
              FROM audit.audit_event
             WHERE {' AND '.join(clauses)}
             ORDER BY occurred_at DESC
             LIMIT %s
            """,
            tuple(params))
        rows = await cur.fetchall()

    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(["occurred_at", "actor_id", "action", "subject_type",
                     "subject_id", "tenant_id", "detail"])
    for r in rows:
        writer.writerow([
            r[0].isoformat() if r[0] is not None else "",
            r[1] if r[1] is not None else "",
            r[2] if r[2] is not None else "",
            r[3] if r[3] is not None else "",
            r[4] if r[4] is not None else "",
            r[5] if r[5] is not None else "",
            json.dumps(r[6]) if r[6] is not None else "",
        ])

    buf.seek(0)
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv",
        headers={"Content-Disposition": "attachment; filename=\"audit_export.csv\""},
    )
