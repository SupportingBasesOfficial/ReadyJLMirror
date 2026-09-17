"""Async domain router — outbox operations."""

from __future__ import annotations

import secrets
from datetime import timedelta
from typing import Annotated

from fastapi import APIRouter, Header, HTTPException, status
from pydantic import BaseModel

from shared.auth import utcnow
from shared.tenant import make_dev_tenant_context
from jlmirror_async.model import (
    ComparisonEvidence,
    MessageClass,
    MessageScope,
)
from jlmirror_async.outbox import (
    BrokerPublicationReceipt,
    InMemoryOutboxLedger,
    OutboxClaim,
    tenant_message_from_context,
)

router = APIRouter(prefix="/api/v1/async", tags=["async"])

# Singleton in-memory outbox (development only)
_outbox = InMemoryOutboxLedger()
_msg_counter = 0


def _next_message_id() -> str:
    global _msg_counter
    _msg_counter += 1
    return f"msg-dev-{_msg_counter:08d}"


class OutboxAppendRequest(BaseModel):
    tenant_id: str
    principal_id: str
    credential_generation: str
    message_class: str
    contract_name: str
    contract_version: str
    producer: str
    correlation_id: str
    data_classification: str
    serialization_profile_id: str
    encoded_payload: str  # base64 or utf-8


class OutboxAppendResponse(BaseModel):
    record_id: int
    message_id: str


@router.post("/outbox/append", response_model=OutboxAppendResponse)
async def outbox_append(body: OutboxAppendRequest) -> OutboxAppendResponse:
    """Append a committed message to the outbox."""
    ctx = make_dev_tenant_context(
        body.tenant_id, body.principal_id, body.credential_generation
    )
    try:
        comparison_evidence = ComparisonEvidence(
            comparison_profile_id="comparison.sha256@1",
            comparison_profile_version="1",
            evidence_form="digest",
            evidence=secrets.token_bytes(32),
        )
        message = tenant_message_from_context(
            ctx,
            message_id=_next_message_id(),
            producer_message_scope=MessageScope.TENANT.value,
            message_class=MessageClass(body.message_class),
            contract_name=body.contract_name,
            contract_version=body.contract_version,
            producer=body.producer,
            correlation_id=body.correlation_id,
            data_classification=body.data_classification,
            serialization_profile_id=body.serialization_profile_id,
            encoded_payload=body.encoded_payload.encode("utf-8"),
            comparison_evidence=comparison_evidence,
            occurred_at=utcnow(),
        )
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc

    record_id = _outbox.append_committed(message)
    return OutboxAppendResponse(record_id=record_id, message_id=message.message_id)


class OutboxClaimNextResponse(BaseModel):
    record_id: int
    message_id: str
    claimed: bool


@router.post("/outbox/claim-next", response_model=OutboxClaimNextResponse)
async def outbox_claim_next() -> OutboxClaimNextResponse:
    """Claim the next pending outbox message for dispatch."""
    now = utcnow()
    claim = _outbox.claim_next(
        owner_id="worker-dev-1",
        observed_at=now,
        claim_expires_at=now + timedelta(minutes=5),
    )
    if claim is None:
        return OutboxClaimNextResponse(record_id=0, message_id="", claimed=False)
    return OutboxClaimNextResponse(
        record_id=claim.record_id, message_id=claim.message.message_id, claimed=True
    )


class OutboxMarkPublishedRequest(BaseModel):
    record_id: int
    receipt_id: str


@router.post("/outbox/mark-published", status_code=status.HTTP_204_NO_CONTENT, response_model=None)
async def outbox_mark_published(body: OutboxMarkPublishedRequest) -> None:
    """Mark a claimed outbox message as published."""
    now = utcnow()
    # In dev mode, re-claim to get a valid claim object
    claim = _outbox.claim_next(
        owner_id="worker-dev-publish",
        observed_at=now,
        claim_expires_at=now + timedelta(minutes=1),
    )
    if claim is None or claim.record_id != body.record_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="could not claim the specified record for publication",
        )
    receipt = BrokerPublicationReceipt(receipt_id=body.receipt_id, observed_at=now)
    try:
        _outbox.mark_published(claim=claim, receipt=receipt, observed_at=now)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail=str(exc)) from exc


class OutboxPendingResponse(BaseModel):
    pending: list[str]


@router.get("/outbox/pending", response_model=OutboxPendingResponse)
async def outbox_pending() -> OutboxPendingResponse:
    """List pending outbox message IDs."""
    messages = _outbox.pending_messages(observed_at=utcnow())
    return OutboxPendingResponse(pending=[m.message_id for m in messages])
