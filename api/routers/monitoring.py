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
from shared.audit import record_audit_event
from shared.db import db_tenant_connection
from shared.monitoring_repo import (
    create_zabbix_source,
    decode_cursor,
    enqueue_current_state_poll,
    enqueue_history_sync,
    enqueue_metric_definition_poll,
    enqueue_problem_state_sync,
    enqueue_sync_operation,
    get_onboarding_view,
    get_source,
    list_current_states,
    list_health_projections,
    list_history_observations,
    list_history_streams,
    list_metric_definitions,
    list_metric_history,
    list_problems,
    list_resources,
    list_sources,
    list_sync_operations,
    requeue_sync_operation,
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


def _ser_rows(payload: dict) -> dict:
    """ISO-serialize every datetime inside an {items, ...} envelope."""
    for item in payload.get("items", []):
        for k, v in item.items():
            if hasattr(v, "isoformat"):
                item[k] = v.isoformat()
    return payload


def _list_params(cursor: str | None, limit: int, view: str) -> dict:
    if view not in ("contract", "operational"):
        raise HTTPException(status_code=422,
                            detail="view must be contract|operational")
    if cursor:
        try:
            decode_cursor(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid cursor")
    return {"cursor": cursor, "limit": limit, "view": view}


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


class ProviderConfiguration(BaseModel):
    base_url: str


class ConfiguredScope(BaseModel):
    host_group_refs: list[str]


class SourceCreateRequest(BaseModel):
    """Accepts the canonical create-source contract shape
    (provider_configuration.base_url + configured_provider_scope) and
    the legacy flat dev shape (provider_base_url + host_group_refs)."""
    tenant_id: str | None = None  # dev-sandbox only; BFF ctx wins when present
    provider_profile: str | None = None
    display_name: str
    provider_instance_ref: str | None = None
    provider_configuration: ProviderConfiguration | None = None
    configured_provider_scope: ConfiguredScope | None = None
    provider_base_url: str | None = None   # legacy flat shape
    host_group_refs: list[str] | None = None
    credential_binding_ref: str
    idempotency_key: str | None = None
    # Optional: tenant supplies the provider token once — the API
    # writes it to the secrets store (0600, atomic) under the binding
    # ref. It is never logged and never reaches the database.
    api_token: str | None = None

    def resolved_base_url(self) -> str:
        url = (self.provider_configuration.base_url
               if self.provider_configuration else self.provider_base_url)
        if not url:
            raise HTTPException(status_code=422,
                                detail="provider_configuration.base_url required")
        return url

    def resolved_host_group_refs(self) -> list[str]:
        refs = (self.configured_provider_scope.host_group_refs
                if self.configured_provider_scope else self.host_group_refs)
        if not refs:
            raise HTTPException(
                status_code=422,
                detail="configured_provider_scope.host_group_refs required")
        return refs

    def resolved_instance_ref(self) -> str:
        if self.provider_instance_ref:
            return self.provider_instance_ref
        from urllib.parse import urlparse
        host = urlparse(self.resolved_base_url()).netloc or "provider"
        return f"zabbix:{host}"


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
    if body.provider_profile is not None and body.provider_profile != "zabbix":
        raise HTTPException(status_code=422,
                            detail="provider_profile must be 'zabbix'")
    base_url = body.resolved_base_url()
    group_refs = body.resolved_host_group_refs()
    # Contract pattern: base_url must be https:// — relaxed to http
    # only under the development runtime (local Zabbix has no TLS).
    if not settings.is_development and not base_url.startswith("https://"):
        raise HTTPException(
            status_code=422,
            detail="provider_configuration.base_url must be https://")
    try:
        # Domain validation before persistence (canonical input shape)
        ZabbixProviderConfiguration(base_url=base_url)
        ConfiguredProviderScope.from_refs(group_refs)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))

    if body.api_token:
        # Write the token to the secrets store BEFORE the source is
        # created — a failed write aborts onboarding cleanly. The
        # binding ref is validated (strict charset, no traversal).
        # When OpenBao is configured it is the authoritative store;
        # the mounted-file write stays as the worker fallback.
        from providers.credentials import (
            BaoCredentialResolver, write_binding_token)
        from jlmirror_monitoring.validation_worker import (
            CredentialResolutionError)
        try:
            bao = BaoCredentialResolver()
            if bao.available:
                bao.store_zabbix_api_token(
                    body.credential_binding_ref, body.api_token)
            write_binding_token(
                body.credential_binding_ref, body.api_token)
        except CredentialResolutionError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=str(exc))
        except OSError:
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail="credential store unavailable")

    key = body.idempotency_key or f"idem-{secrets.token_urlsafe(16)}"
    try:
        async with db_tenant_connection(tenant_id) as conn:
            result = await create_zabbix_source(
                conn,
                tenant_id=tenant_id,
                idempotency_key=key,
                display_name=body.display_name,
                provider_instance_ref=body.resolved_instance_ref(),
                provider_base_url=base_url,
                credential_binding_ref=body.credential_binding_ref,
                host_group_refs=group_refs,
                audit_ctx={
                    "actor_kind": "principal",
                    "actor_id": (getattr(
                        request.state, "jlmirror_context", {}) or {}
                    ).get("principal_id"),
                    "correlation_id": (getattr(
                        request.state, "jlmirror_context", {}) or {}
                    ).get("correlation_id"),
                },
            )
    except ValueError as exc:
        if "idempotency.key_reused" in str(exc):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc))
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc))
    return SourceResponse(**result)


class DiscoverGroupsRequest(BaseModel):
    provider_base_url: str
    # Transient token — used once for the discovery call, never
    # persisted or logged. The onboarding form supplies the same
    # token it will later submit as `api_token` on source creation.
    api_token: str


class DiscoveredGroup(BaseModel):
    groupid: str
    name: str | None = None


@router.post("/sources/discover-groups", response_model=list[DiscoveredGroup])
async def discover_groups(
    body: DiscoverGroupsRequest,
) -> list[DiscoveredGroup]:
    """List the host groups visible to a provider token.

    Lets the onboarding UI offer real scope choices instead of asking
    the tenant to hunt groupids in the Zabbix UI. The call goes
    through the same egress admission as the worker (allowlist + DNS
    pinning + SSRF screen); the token is used in memory only.
    """
    try:
        provider_config = ZabbixProviderConfiguration(
            base_url=body.provider_base_url)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=str(exc))
    if not body.api_token.strip():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="api_token required for discovery")

    import asyncio

    from providers.egress import DevOutboundAdmission
    from providers.zabbix import ZabbixClient
    from jlmirror_monitoring.validation_worker import (
        EgressAdmissionError,
        ProviderAuthenticationError,
        ProviderProtocolError,
        ProviderUnavailableError,
        ResolvedZabbixCredential,
    )

    try:
        endpoint = DevOutboundAdmission().admit_zabbix_api(provider_config)
    except EgressAdmissionError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail=str(exc))

    credential = ResolvedZabbixCredential(
        api_token=body.api_token.strip(),
        credential_generation_ref="cred-gen-transient:onboarding",
    )
    try:
        groups = await asyncio.to_thread(
            ZabbixClient().list_host_groups, endpoint, credential)
    except ProviderAuthenticationError:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST,
                            detail="provider rejected the API token")
    except ProviderUnavailableError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail=str(exc))
    except ProviderProtocolError as exc:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY,
                            detail=str(exc))
    return [DiscoveredGroup(groupid=g.groupid, name=g.name) for g in groups]


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
    async with db_tenant_connection(tenant) as conn:
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
    async with db_tenant_connection(tenant) as conn:
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
        async with db_tenant_connection(tenant) as conn:
            op_id = await enqueue_sync_operation(
                conn, tenant_id=tenant, source_id=source_id,
                responsibility_kind="host_inventory_sync",
            )
    except ValueError:
        raise HTTPException(status_code=404, detail="source not found")
    return {"monitoring_sync_operation_id": op_id, "state": "pending"}


@router.get("/sources/{source_id}/resources")
async def list_resources_endpoint(source_id: str, request: Request,
                                  tenant_id: str | None = None,
                                  cursor: str | None = None,
                                  limit: int = 500,
                                  view: str = "contract") -> dict:
    """G3 resource-list contract — {generation_state, items,
    next_cursor}. `view=operational` adds internal extension fields."""
    tenant = _authoritative_tenant(request, tenant_id)
    params = _list_params(cursor, limit, view)
    async with db_tenant_connection(tenant) as conn:
        payload = await list_resources(conn, tenant, source_id, **params)
    return _ser_rows(payload)


@router.get("/sources/{source_id}/onboarding")
async def onboarding_view_endpoint(source_id: str, request: Request,
                                   tenant_id: str | None = None) -> dict:
    """G2 onboarding-view contract — validation state for the source."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        view = await get_onboarding_view(conn, tenant, source_id)
    if view is None:
        raise HTTPException(status_code=404, detail="source not found")
    return view


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


# ---------------------------------------------------------------------------
# Metric definitions
# ---------------------------------------------------------------------------


@router.post("/sources/{source_id}/metrics/poll", status_code=202)
async def enqueue_metric_poll(source_id: str, request: Request,
                              tenant_id: str | None = None) -> dict:
    """Enqueue the next `metric_definition_poll` for the source.

    Assigns the next poll generation within the source's current epoch;
    the metrics worker claims it and collects item.get.
    """
    tenant = _authoritative_tenant(request, tenant_id)
    try:
        async with db_tenant_connection(tenant) as conn:
            op_id = await enqueue_metric_definition_poll(
                conn, tenant_id=tenant, source_id=source_id
            )
    except ValueError:
        raise HTTPException(status_code=404, detail="source not found")
    return {"monitoring_sync_operation_id": op_id, "state": "pending"}


@router.get("/sources/{source_id}/metrics")
async def list_metrics_endpoint(source_id: str, request: Request,
                                tenant_id: str | None = None,
                                cursor: str | None = None,
                                limit: int = 500,
                                view: str = "contract") -> dict:
    """G4 metric-definitions contract — {items, next_cursor}."""
    tenant = _authoritative_tenant(request, tenant_id)
    params = _list_params(cursor, limit, view)
    async with db_tenant_connection(tenant) as conn:
        payload = await list_metric_definitions(
            conn, tenant, source_id, **params)
    return _ser_rows(payload)


@router.post("/metrics/run", status_code=200)
async def run_metrics_once() -> dict:
    """Dev trigger: one metric-definition poll pass over pending ops."""
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    import asyncio

    import psycopg
    from workers.metrics import _process_pending

    def _run() -> int:
        with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
            return _process_pending(conn)

    processed = await asyncio.to_thread(_run)
    return {"processed": processed}


# ---------------------------------------------------------------------------
# Metric current state
# ---------------------------------------------------------------------------


@router.post("/sources/{source_id}/current/poll", status_code=202)
async def enqueue_current_poll(source_id: str, request: Request,
                               tenant_id: str | None = None) -> dict:
    """Enqueue the next `current_state_poll` for the source."""
    tenant = _authoritative_tenant(request, tenant_id)
    try:
        async with db_tenant_connection(tenant) as conn:
            op_id = await enqueue_current_state_poll(
                conn, tenant_id=tenant, source_id=source_id
            )
    except ValueError:
        raise HTTPException(status_code=404, detail="source not found")
    return {"monitoring_sync_operation_id": op_id, "state": "pending"}


@router.get("/sources/{source_id}/current")
async def list_current_endpoint(source_id: str, request: Request,
                                tenant_id: str | None = None,
                                cursor: str | None = None,
                                limit: int = 500,
                                view: str = "contract") -> dict:
    """G4 metric-current contract — {items, next_cursor}."""
    tenant = _authoritative_tenant(request, tenant_id)
    params = _list_params(cursor, limit, view)
    async with db_tenant_connection(tenant) as conn:
        payload = await list_current_states(
            conn, tenant, source_id, **params)
    return _ser_rows(payload)


@router.post("/current/run", status_code=200)
async def run_current_once() -> dict:
    """Dev trigger: one current-state poll pass over pending ops."""
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    import asyncio

    import psycopg
    from workers.current_state import _process_pending

    def _run() -> int:
        with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
            return _process_pending(conn)

    processed = await asyncio.to_thread(_run)
    return {"processed": processed}


# ---------------------------------------------------------------------------
# Metric history
# ---------------------------------------------------------------------------


@router.post("/sources/{source_id}/history/poll", status_code=202)
async def enqueue_history_poll(source_id: str, request: Request,
                               tenant_id: str | None = None,
                               time_from: int | None = None,
                               time_till: int | None = None) -> dict:
    """Enqueue a bounded metric_history_sync window for the source."""
    import time as _time

    tenant = _authoritative_tenant(request, tenant_id)
    till = time_till if time_till is not None else int(_time.time())
    frm = time_from if time_from is not None else till - 3600
    if frm <= 0 or till < frm or till - frm > 86_400:
        raise HTTPException(status_code=422, detail="invalid history window")
    async with db_tenant_connection(tenant) as conn:
        op_id = await enqueue_history_sync(
            conn, tenant, source_id, time_from=frm, time_till=till
        )
    if op_id is None:
        raise HTTPException(status_code=404, detail="source not found")
    return {
        "monitoring_sync_operation_id": op_id,
        "state": "pending",
        "time_from": frm,
        "time_till": till,
    }


@router.get("/sources/{source_id}/history")
async def list_history_endpoint(source_id: str, request: Request,
                                tenant_id: str | None = None,
                                limit: int = 500) -> list[dict]:
    """List immutable historical metric observations for a source."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        rows = await list_history_observations(
            conn, tenant, source_id, limit=limit
        )
    for r in rows:
        if r.get("observed_at") is not None:
            r["observed_at"] = r["observed_at"].isoformat()
    return rows


@router.get("/sources/{source_id}/metrics/{metric_definition_id}/history")
async def metric_history_endpoint(
        source_id: str, metric_definition_id: str, request: Request,
        tenant_id: str | None = None,
        window_from: int | None = None,
        window_till: int | None = None,
        cursor: str | None = None,
        limit: int = 500) -> dict:
    """G4 metric-history contract — per-definition windowed view."""
    import time as _time

    tenant = _authoritative_tenant(request, tenant_id)
    till = window_till if window_till is not None else int(_time.time())
    frm = window_from if window_from is not None else till - 3600
    if frm <= 0 or till < frm or till - frm > 86_400 * 30:
        raise HTTPException(status_code=422, detail="invalid window")
    if cursor:
        try:
            decode_cursor(cursor)
        except ValueError:
            raise HTTPException(status_code=400, detail="invalid cursor")
    async with db_tenant_connection(tenant) as conn:
        payload = await list_metric_history(
            conn, tenant, source_id, metric_definition_id,
            window_from=frm, window_till=till,
            cursor=cursor, limit=limit)
    if payload is None:
        raise HTTPException(status_code=404,
                            detail="metric definition not found")
    return _ser_rows(payload)


@router.get("/sources/{source_id}/history/streams")
async def list_history_streams_endpoint(source_id: str, request: Request,
                                        tenant_id: str | None = None
                                        ) -> list[dict]:
    """List per-stream history checkpoints for a source."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        rows = await list_history_streams(conn, tenant, source_id)
    for r in rows:
        if r.get("updated_at") is not None:
            r["updated_at"] = r["updated_at"].isoformat()
    return rows


@router.post("/history/run", status_code=200)
async def run_history_once() -> dict:
    """Dev trigger: one history pass — drains sync ops and projects
    pending acceptance envelopes into metric_observation."""
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    import asyncio

    import psycopg
    from workers.history import _process_pending as _run_history

    def _run() -> int:
        with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
            return _run_history(conn)

    processed = await asyncio.to_thread(_run)
    return {"processed": processed}


# ---------------------------------------------------------------------------
# Problem state
# ---------------------------------------------------------------------------


@router.post("/sources/{source_id}/problems/poll", status_code=202)
async def enqueue_problem_poll(source_id: str, request: Request,
                               tenant_id: str | None = None) -> dict:
    """Enqueue a problem_state_sync op — requires source evidence 'current'."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        op_id = await enqueue_problem_state_sync(conn, tenant, source_id)
    if op_id is None:
        raise HTTPException(status_code=404, detail="source not found")
    return {"monitoring_sync_operation_id": op_id, "state": "pending"}


@router.get("/sources/{source_id}/problems")
async def list_problems_endpoint(source_id: str, request: Request,
                                 tenant_id: str | None = None,
                                 active_only: bool = False,
                                 cursor: str | None = None,
                                 limit: int = 500,
                                 view: str = "contract") -> dict:
    """G5 problems contract — {items, next_cursor}, severity-ordered."""
    tenant = _authoritative_tenant(request, tenant_id)
    params = _list_params(cursor, limit, view)
    async with db_tenant_connection(tenant) as conn:
        payload = await list_problems(
            conn, tenant, source_id, active_only=active_only, **params)
    return _ser_rows(payload)


@router.post("/problems/run", status_code=200)
async def run_problems_once() -> dict:
    """Dev trigger: one problem-state poll pass over pending ops."""
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    import asyncio

    import psycopg
    from workers.problem_state import _process_pending as _run_problems

    def _run() -> int:
        with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
            return _run_problems(conn)

    processed = await asyncio.to_thread(_run)
    return {"processed": processed}


# ---------------------------------------------------------------------------
# Health projection (canonical derived authority — no provider polling)
# ---------------------------------------------------------------------------


@router.get("/sources/{source_id}/operations")
async def list_operations_endpoint(
        source_id: str, request: Request,
        tenant_id: str | None = None,
        state: str | None = None) -> list[dict]:
    """DLQ visibility (ADR-010): durable sync operations for a source —
    pending, running, succeeded, reconciliation_required, failed_terminal —
    newest first. state filter narrows to one class."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        rows = await list_sync_operations(conn, tenant, source_id, state)
    for r in rows:
        for k in ("created_at", "started_at", "completed_at"):
            if r.get(k) is not None:
                r[k] = r[k].isoformat()
    return rows


@router.post("/sources/{source_id}/operations/{operation_id}/requeue")
async def requeue_operation_endpoint(
        source_id: str, operation_id: str, request: Request,
        tenant_id: str | None = None) -> dict:
    """Operator reconciliation: move a failed operation
    (reconciliation_required | failed_terminal) back to `pending`
    so a worker can claim it again."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        ok = await requeue_sync_operation(
            conn, tenant, source_id, operation_id)
        if ok:
            ctx = getattr(request.state, "jlmirror_context", {}) or {}
            await record_audit_event(
                conn, tenant,
                action="monitoring.operation.requeued",
                actor_kind="operator",
                actor_id=ctx.get("principal_id"),
                subject_type="sync_operation",
                subject_id=operation_id,
                detail={"monitoring_source_id": source_id},
                correlation_id=ctx.get("correlation_id"))
        await conn.commit()
    if not ok:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="operation is not in a requeueable state")
    return {"state": "pending"}


@router.get("/sources/{source_id}/health")
async def list_health_endpoint(source_id: str, request: Request,
                               tenant_id: str | None = None,
                               cursor: str | None = None,
                               limit: int = 500,
                               view: str = "contract") -> dict:
    """G5 health contract — {items, next_cursor} with problem_refs."""
    tenant = _authoritative_tenant(request, tenant_id)
    params = _list_params(cursor, limit, view)
    async with db_tenant_connection(tenant) as conn:
        payload = await list_health_projections(
            conn, tenant, source_id, **params)
    return _ser_rows(payload)


@router.post("/health/run", status_code=200)
async def run_health_once() -> dict:
    """Dev trigger: one health projection sweep over all sources."""
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    import asyncio

    import psycopg
    from workers.health import _process_pending as _run_health

    def _run() -> int:
        with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
            return _run_health(conn)

    processed = await asyncio.to_thread(_run)
    return {"projected": processed}


# ---------------------------------------------------------------------------
# Publication outbox (durable monitoring domain events)
# ---------------------------------------------------------------------------


@router.get("/outbox/messages")
async def list_outbox_endpoint(request: Request,
                               tenant_id: str | None = None,
                               state: str | None = None,
                               limit: int = 100) -> list[dict]:
    """List durable outbox messages (publication audit trail)."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT record_id, message_id, contract_name, contract_version,
                   subject_type, subject_id, dispatch_state, attempt_count,
                   redrive_count, last_error_class, published_receipt_id,
                   published_at, appended_at
              FROM monitoring.monitoring_outbox
             WHERE tenant_id = %s
               AND (%s IS NULL OR dispatch_state = %s)
             ORDER BY record_id DESC LIMIT %s
            """,
            (tenant, state, state, min(limit, 1000)),
        )
        keys = ("record_id", "message_id", "contract_name",
                "contract_version", "subject_type", "subject_id",
                "dispatch_state", "attempt_count", "redrive_count",
                "last_error_class", "published_receipt_id", "published_at",
                "appended_at")
        rows = [dict(zip(keys, r)) for r in await cur.fetchall()]
    for r in rows:
        for k in ("published_at", "appended_at"):
            if r.get(k) is not None:
                r[k] = r[k].isoformat()
    return rows


@router.post("/outbox/{record_id}/redrive")
async def redrive_outbox_endpoint(request: Request, record_id: int,
                                  tenant_id: str | None = None) -> dict:
    """Operator redrive of a quarantined outbox message (DLQ path).

    Bounded by redrive_count — a permanently poisoned message cannot
    be redriven forever. The dispatcher picks it up on the next tick.
    """
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "SELECT monitoring.redrive_outbox_message(%s, %s)",
            (tenant, record_id))
        ok = (await cur.fetchone())[0]
        if ok:
            ctx = getattr(request.state, "jlmirror_context", {}) or {}
            await record_audit_event(
                conn, tenant,
                action="monitoring.outbox.redriven",
                actor_kind="operator",
                actor_id=ctx.get("principal_id"),
                subject_type="outbox_message",
                subject_id=str(record_id),
                correlation_id=ctx.get("correlation_id"))
        await conn.commit()
    if not ok:
        raise HTTPException(
            status_code=409,
            detail="message is not quarantined or redrive cap reached")
    return {"record_id": record_id, "redriven": True}


@router.post("/outbox/run", status_code=200)
async def run_outbox_once() -> dict:
    """Dev trigger: one durable outbox dispatch pass."""
    if not settings.is_development:
        raise HTTPException(status_code=403, detail="not available")
    import asyncio

    import psycopg
    from workers.outbox_dispatcher import _publish_durable

    def _run() -> int:
        with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
            return _publish_durable(conn)

    published = await asyncio.to_thread(_run)
    return {"published": published}
