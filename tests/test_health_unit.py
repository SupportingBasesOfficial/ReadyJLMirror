"""Health projection unit tests — canonical derive_health semantics.

Covers:
  - healthy requires fully-current authority
  - critical -> unhealthy, warning/degraded -> degraded
  - non-current evidence degrades 'current' to reconciliation_required
  - unknown-severity-only -> unknown
  - semantic change detection
  - reason_refs bounds
"""

from __future__ import annotations

import pytest

from jlmirror_monitoring.health_projection import (
    EvidenceState,
    HealthClass,
    HealthDecision,
    HealthInput,
    MAX_HEALTH_REASON_REFS,
    SeverityClass,
    derive_health,
    semantic_health_change,
)


def _input(
    *,
    source_current=True,
    present=True,
    scope_ok=True,
    problems_current=True,
    evidence=EvidenceState.CURRENT,
    severities=(),
    reasons=(),
) -> HealthInput:
    return HealthInput(
        tenant_id="tenant:test",
        monitoring_source_id="src-1",
        source_instance_generation="gen-1",
        monitoring_resource_id="res-1",
        source_is_current=source_current,
        resource_present=present,
        scope_is_current_and_in_scope=scope_ok,
        problem_completeness_is_current=problems_current,
        evidence_state=evidence,
        active_problem_severities=severities,
        reason_refs=reasons,
    )


def test_healthy_requires_current_authority():
    d = derive_health(_input())
    assert d.health_class is HealthClass.HEALTHY
    assert d.evidence_state is EvidenceState.CURRENT


def test_critical_severity_unhealthy():
    d = derive_health(_input(severities=[SeverityClass.CRITICAL]))
    assert d.health_class is HealthClass.UNHEALTHY


def test_warning_and_degraded_severity_degraded():
    for sev in (SeverityClass.WARNING, SeverityClass.DEGRADED):
        d = derive_health(_input(severities=[sev]))
        assert d.health_class is HealthClass.DEGRADED


def test_unknown_severity_only_unknown():
    d = derive_health(_input(severities=[SeverityClass.UNKNOWN]))
    assert d.health_class is HealthClass.UNKNOWN


def test_incomplete_problem_evidence_not_healthy():
    d = derive_health(_input(problems_current=False))
    assert d.health_class is HealthClass.UNKNOWN
    assert d.evidence_state is EvidenceState.RECONCILIATION_REQUIRED


def test_source_not_current_degrades_evidence():
    d = derive_health(_input(source_current=False))
    assert d.health_class is not HealthClass.HEALTHY
    assert d.evidence_state is EvidenceState.RECONCILIATION_REQUIRED


def test_removed_resource_not_healthy():
    d = derive_health(_input(present=False))
    assert d.health_class is not HealthClass.HEALTHY


def test_severity_with_noncurrent_evidence():
    d = derive_health(
        _input(evidence=EvidenceState.STALE,
               severities=[SeverityClass.CRITICAL]))
    assert d.health_class is HealthClass.UNHEALTHY
    assert d.evidence_state is EvidenceState.STALE


def test_semantic_change_detection():
    a = HealthDecision(HealthClass.HEALTHY, EvidenceState.CURRENT, ())
    b = HealthDecision(HealthClass.DEGRADED, EvidenceState.CURRENT, ())
    assert semantic_health_change(None, a) is True
    assert semantic_health_change(a, b) is True
    assert semantic_health_change(b, HealthDecision(
        HealthClass.DEGRADED, EvidenceState.STALE, ())) is False


def test_reason_refs_bounded():
    with pytest.raises(ValueError):
        derive_health(_input(reasons=["r"] * (MAX_HEALTH_REASON_REFS + 1)))
    with pytest.raises(ValueError):
        derive_health(_input(reasons=["x" * 513]))
