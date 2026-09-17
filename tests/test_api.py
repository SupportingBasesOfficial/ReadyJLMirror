"""Integration tests for the ReadyJLMirror API.

These tests use FastAPI's TestClient and do not require a running database.
Domain endpoints use in-memory authorities in development mode.
"""

from __future__ import annotations

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health_liveness():
    """Liveness probe returns 200 without checking the database."""
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "environment" in body


def test_root_metadata():
    """Root endpoint returns service metadata."""
    response = client.get("/")
    assert response.status_code == 200
    body = response.json()
    assert body["service"] == "ReadyJLMirror"
    assert body["version"] == "0.1.0"


def test_openapi_docs_available():
    """Interactive API docs are available."""
    response = client.get("/docs")
    assert response.status_code == 200


def test_openapi_schema_has_all_routers():
    """The OpenAPI schema includes routes from all domain routers."""
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()
    paths = set(schema["paths"].keys())
    # Authority domain
    assert "/api/v1/auth/session/issue" in paths
    assert "/api/v1/auth/session/retire" in paths
    assert "/api/v1/fence/bootstrap" in paths
    assert "/api/v1/fence/acquire" in paths
    assert "/api/v1/fence/current/{fence_scope_id}" in paths
    # Monitoring domain
    assert "/api/v1/monitoring/sources/plan" in paths
    assert "/api/v1/monitoring/health/derive" in paths
    # Async domain
    assert "/api/v1/async/outbox/append" in paths
    assert "/api/v1/async/outbox/claim-next" in paths
    assert "/api/v1/async/outbox/mark-published" in paths
    assert "/api/v1/async/outbox/pending" in paths
    # Observability domain
    assert "/api/v1/observability/profiles" in paths
    assert "/api/v1/observability/profiles/{profile_id}" in paths
    # Release domain
    assert "/api/v1/release/outcome/classify" in paths
    assert "/api/v1/release/outcomes" in paths


def test_fence_bootstrap_and_acquire():
    """Bootstrap a fence and then acquire the next epoch."""
    # Bootstrap
    response = client.post(
        "/api/v1/fence/bootstrap",
        json={"fence_scope_id": "fence:test-fence-1", "generation_id": "gen-1"},
    )
    assert response.status_code == 200
    bootstrapped = response.json()
    assert bootstrapped["current_fence_epoch"] == 1
    assert bootstrapped["current_generation_id"] == "gen-1"

    # Acquire next epoch
    response = client.post(
        "/api/v1/fence/acquire",
        json={
            "fence_scope_id": "fence:test-fence-1",
            "expected_predecessor_epoch": 1,
            "expected_predecessor_generation_id": "gen-1",
            "successor_generation_id": "gen-2",
        },
    )
    assert response.status_code == 200
    acquired = response.json()
    assert acquired["current_fence_epoch"] == 2
    assert acquired["current_generation_id"] == "gen-2"


def test_fence_current():
    """Get current fence state for a scope."""
    # Bootstrap first
    client.post(
        "/api/v1/fence/bootstrap",
        json={"fence_scope_id": "fence:test-fence-current", "generation_id": "gen-a"},
    )
    response = client.get("/api/v1/fence/current/fence:test-fence-current")
    assert response.status_code == 200
    current = response.json()
    assert current["current_generation_id"] == "gen-a"


def test_fence_current_nonexistent():
    """Get current fence state for a non-existent scope returns null."""
    response = client.get("/api/v1/fence/current/fence:nonexistent")
    assert response.status_code == 200
    assert response.json() is None


def test_session_issue_and_retire():
    """Issue a browser session and then retire it."""
    # Issue
    response = client.post(
        "/api/v1/auth/session/issue",
        json={"principal_id": "dev-test-user", "credential_generation": "credential-gen-dev-1"},
    )
    assert response.status_code == 200
    session = response.json()
    assert "session_handle" in session
    assert session["principal_id"] == "dev-test-user"
    handle = session["session_handle"]

    # Retire
    response = client.post(
        "/api/v1/auth/session/retire",
        json={"session_handle": handle},
    )
    assert response.status_code == 204


def test_monitoring_health_derive_healthy():
    """Derive a health decision from monitoring evidence (healthy case)."""
    response = client.post(
        "/api/v1/monitoring/health/derive",
        json={
            "tenant_id": "tenant:dev",
            "monitoring_source_id": "mon-src-1",
            "source_instance_generation": "gen-1",
            "monitoring_resource_id": "res-1",
            "source_is_current": True,
            "resource_present": True,
            "scope_is_current_and_in_scope": True,
            "problem_completeness_is_current": True,
            "evidence_state": "current",
            "active_problem_severities": [],
            "reason_refs": [],
        },
    )
    assert response.status_code == 200
    decision = response.json()
    assert decision["health_class"] == "healthy"
    assert decision["evidence_state"] == "current"


def test_monitoring_source_plan():
    """Plan a monitoring source creation."""
    response = client.post(
        "/api/v1/monitoring/sources/plan",
        json={
            "tenant_id": "tenant:dev",
            "display_name": "Test Zabbix Source",
            "provider_instance_ref": "provider:zabbix-dev-1",
            "base_url": "https://zabbix.example.com",
            "host_group_refs": ["group-1", "group-2"],
            "credential_binding_ref": "cred-binding-1",
        },
    )
    assert response.status_code == 200
    plan = response.json()
    assert plan["monitoring_source_id"].startswith("mon-src")
    assert "sync_operation_id" in plan
    assert "audit_evidence_id" in plan


def test_outbox_append_and_pending():
    """Append a message to the outbox and list pending."""
    # Append
    response = client.post(
        "/api/v1/async/outbox/append",
        json={
            "tenant_id": "tenant:dev",
            "principal_id": "dev-test-user",
            "credential_generation": "credential-gen-dev-1",
            "message_class": "domain_event",
            "contract_name": "monitoring.source.created",
            "contract_version": "1",
            "producer": "monitoring-service",
            "correlation_id": "corr-1",
            "data_classification": "internal",
            "serialization_profile_id": "json@1",
            "encoded_payload": "e30=",  # "{}" base64
        },
    )
    assert response.status_code == 200
    result = response.json()
    assert "record_id" in result
    assert "message_id" in result

    # Pending
    response = client.get("/api/v1/async/outbox/pending")
    assert response.status_code == 200
    pending = response.json()
    assert isinstance(pending["pending"], list)


def test_observability_profiles_list():
    """List reliability profile IDs."""
    response = client.get("/api/v1/observability/profiles")
    assert response.status_code == 200
    profiles = response.json()
    assert isinstance(profiles, list)
    # All profile IDs should start with "rel."
    assert all(p.startswith("rel.") for p in profiles)


def test_release_outcomes_list():
    """List outcome classes."""
    response = client.get("/api/v1/release/outcomes")
    assert response.status_code == 200
    outcomes = response.json()
    assert isinstance(outcomes, list)
    assert "rollback_eligible" in outcomes
    assert "forward_recovery_required" in outcomes


def test_release_outcome_classify_rollback_eligible():
    """Classify a change outcome as rollback_eligible."""
    response = client.post(
        "/api/v1/release/outcome/classify",
        json={
            "evidence_reference": "evidence:dev-test-1",
            "authority_profile_and_version": "release-policy@1",
            "scope_binding": "release:test-scope",
            "current": True,
            "effect_outcome_ambiguous": False,
            "irreversible_without_governed_migration": False,
            "previous_runtime_can_interpret_current_state": True,
            "rollback_configuration_evidence_current": True,
            "cell_compatibility_allows_previous": True,
            "release_policy_and_verifier_current": True,
            "release_target_state_allows_rollback": True,
            "security_governance_reliability_current": True,
            "required_evidence_preserved": True,
        },
    )
    assert response.status_code == 200
    result = response.json()
    assert result["outcome"] == "rollback_eligible"


def test_release_outcome_classify_forward_recovery():
    """Classify a change outcome as forward_recovery_required."""
    response = client.post(
        "/api/v1/release/outcome/classify",
        json={
            "evidence_reference": "evidence:dev-test-2",
            "authority_profile_and_version": "release-policy@1",
            "scope_binding": "release:test-scope",
            "current": True,
            "effect_outcome_ambiguous": False,
            "irreversible_without_governed_migration": False,
            "previous_runtime_can_interpret_current_state": True,
            "rollback_configuration_evidence_current": False,
            "cell_compatibility_allows_previous": True,
            "release_policy_and_verifier_current": True,
            "release_target_state_allows_rollback": True,
            "security_governance_reliability_current": True,
            "required_evidence_preserved": True,
        },
    )
    assert response.status_code == 200
    result = response.json()
    assert result["outcome"] == "forward_recovery_required"
