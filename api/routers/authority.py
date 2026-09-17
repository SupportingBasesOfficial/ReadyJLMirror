"""Authority domain router — session and fence endpoints."""

from __future__ import annotations

from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

from shared.auth import (
    fence_store,
    session_store,
    make_dev_principal,
    utcnow,
    default_session_lifetime,
)
from shared.tenant import make_dev_tenant_context
from jlmirror_authority.session import (
    BrowserSessionHandle,
    issue_browser_session,
    resolve_browser_session,
    retire_browser_session,
)
from jlmirror_authority.fencing import acquire_next_fence
from jlmirror_authority.model import AdmissionDenied

router = APIRouter(prefix="/api/v1", tags=["authority"])


# ---------------------------------------------------------------------------
# Session endpoints
# ---------------------------------------------------------------------------


class SessionIssueRequest(BaseModel):
    principal_id: str
    credential_generation: str


class SessionIssueResponse(BaseModel):
    session_handle: str
    session_generation: str
    principal_id: str
    expires_at: str


@router.post("/auth/session/issue", response_model=SessionIssueResponse)
async def issue_session(
    body: SessionIssueRequest,
    x_principal_id: Annotated[str | None, Header()] = None,
) -> SessionIssueResponse:
    """Issue a browser session for the given principal (development mode)."""
    principal = make_dev_principal(body.principal_id, body.credential_generation)
    try:
        handle = issue_browser_session(
            authority=session_store,
            principal=principal,
            now=utcnow(),
            lifetime=default_session_lifetime(),
        )
    except AdmissionDenied as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc

    record = session_store.resolve(handle.digest)
    assert record is not None
    return SessionIssueResponse(
        session_handle=handle.value,
        session_generation=record.session_generation,
        principal_id=record.principal.principal_id,
        expires_at=record.expires_at.isoformat(),
    )


class SessionRetireRequest(BaseModel):
    session_handle: str


@router.post("/auth/session/retire", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def retire_session(body: SessionRetireRequest) -> None:
    """Retire a browser session by handle."""
    try:
        handle = BrowserSessionHandle(value=body.session_handle)
        retire_browser_session(authority=session_store, handle=handle, now=utcnow())
    except (AdmissionDenied, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=str(exc)) from exc


# ---------------------------------------------------------------------------
# Fence endpoints
# ---------------------------------------------------------------------------


class FenceBootstrapRequest(BaseModel):
    fence_scope_id: str
    generation_id: str


class FenceResponse(BaseModel):
    fence_scope_id: str
    current_fence_epoch: int
    current_generation_id: str
    authority_state: str


@router.post("/fence/bootstrap", response_model=FenceResponse)
async def bootstrap_fence(body: FenceBootstrapRequest) -> FenceResponse:
    """Bootstrap a fence scope with an initial generation."""
    record = fence_store.bootstrap(body.fence_scope_id, body.generation_id)
    return FenceResponse(
        fence_scope_id=record.fence_scope_id,
        current_fence_epoch=record.current_fence_epoch,
        current_generation_id=record.current_generation_id,
        authority_state=record.authority_state,
    )


class FenceAcquireRequest(BaseModel):
    fence_scope_id: str
    expected_predecessor_epoch: int
    expected_predecessor_generation_id: str
    successor_generation_id: str


@router.post("/fence/acquire", response_model=FenceResponse)
async def acquire_fence(body: FenceAcquireRequest) -> FenceResponse:
    """Acquire the next fence epoch for a scope."""
    try:
        record = acquire_next_fence(
            authority=fence_store,
            fence_scope_id=body.fence_scope_id,
            expected_predecessor_epoch=body.expected_predecessor_epoch,
            expected_predecessor_generation_id=body.expected_predecessor_generation_id,
            successor_generation_id=body.successor_generation_id,
        )
    except (AdmissionDenied, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc
    return FenceResponse(
        fence_scope_id=record.fence_scope_id,
        current_fence_epoch=record.current_fence_epoch,
        current_generation_id=record.current_generation_id,
        authority_state=record.authority_state,
    )


@router.get("/fence/current/{fence_scope_id}", response_model=FenceResponse | None)
async def current_fence(fence_scope_id: str) -> FenceResponse | None:
    """Get the current fence state for a scope."""
    record = fence_store.current(fence_scope_id)
    if record is None:
        return None
    return FenceResponse(
        fence_scope_id=record.fence_scope_id,
        current_fence_epoch=record.current_fence_epoch,
        current_generation_id=record.current_generation_id,
        authority_state=record.authority_state,
    )
