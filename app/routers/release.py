"""Release domain router — change outcome classification."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from jlmirror_release.model import OutcomeClass
from jlmirror_release.recovery import (
    RecoveryClassificationEvidence,
    classify_change_outcome,
)

router = APIRouter(prefix="/api/v1/release", tags=["release"])


class OutcomeClassifyRequest(BaseModel):
    evidence_reference: str
    authority_profile_and_version: str
    scope_binding: str
    current: bool
    effect_outcome_ambiguous: bool
    irreversible_without_governed_migration: bool
    previous_runtime_can_interpret_current_state: bool
    rollback_configuration_evidence_current: bool
    cell_compatibility_allows_previous: bool
    release_policy_and_verifier_current: bool
    release_target_state_allows_rollback: bool
    security_governance_reliability_current: bool
    required_evidence_preserved: bool


class OutcomeClassifyResponse(BaseModel):
    outcome: str


@router.post("/outcome/classify", response_model=OutcomeClassifyResponse)
async def classify_outcome(body: OutcomeClassifyRequest) -> OutcomeClassifyResponse:
    """Classify a change outcome from recovery evidence."""
    try:
        evidence = RecoveryClassificationEvidence(
            evidence_reference=body.evidence_reference,
            authority_profile_and_version=body.authority_profile_and_version,
            scope_binding=body.scope_binding,
            current=body.current,
            effect_outcome_ambiguous=body.effect_outcome_ambiguous,
            irreversible_without_governed_migration=body.irreversible_without_governed_migration,
            previous_runtime_can_interpret_current_state=body.previous_runtime_can_interpret_current_state,
            rollback_configuration_evidence_current=body.rollback_configuration_evidence_current,
            cell_compatibility_allows_previous=body.cell_compatibility_allows_previous,
            release_policy_and_verifier_current=body.release_policy_and_verifier_current,
            release_target_state_allows_rollback=body.release_target_state_allows_rollback,
            security_governance_reliability_current=body.security_governance_reliability_current,
            required_evidence_preserved=body.required_evidence_preserved,
        )
        outcome = classify_change_outcome(evidence, expected_scope=body.scope_binding)
    except (ValueError, TypeError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=str(exc)) from exc
    return OutcomeClassifyResponse(outcome=outcome.value)


@router.get("/outcomes", response_model=list[str])
async def list_outcomes() -> list[str]:
    """List all accepted outcome classes."""
    return [oc.value for oc in OutcomeClass]
