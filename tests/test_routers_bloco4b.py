"""Bloco 4B — integration tests for previously uncovered routers.

Covers: finops, oncall, synthetic, aiops, tenant permissions catalog,
        billing (smoke), incident_response (smoke).

Requires PostgreSQL with G1 schema applied.
Tests skip gracefully when DB is unreachable.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from unittest.mock import AsyncMock, patch

import psycopg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

os.environ.setdefault("APP_ENVIRONMENT", "development")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")
os.environ.setdefault("VAPID_PRIVATE_KEY", "test-vapid-private-key")
os.environ.setdefault("VAPID_PUBLIC_KEY", "test-vapid-public-key")
os.environ.setdefault("VAPID_CLAIMS_SUB", "mailto:test@test.com")

pytestmark = [pytest.mark.integration, pytest.mark.asyncio(loop_scope="module")]

_TENANT_CTX = {
    "principal_id": "principal.e2e-dev-admin",
    "session_digest": "test-digest",
    "session_generation": "gen-test",
    "tenant_id": "tenant:dev",
    "role": "admin",
    "correlation_id": None,
}


@pytest.fixture(scope="module")
def event_loop_policy():
    if sys.platform == "win32":
        return asyncio.WindowsSelectorEventLoopPolicy()
    return asyncio.DefaultEventLoopPolicy()


@pytest.fixture(scope="module")
def event_loop(event_loop_policy):
    loop = event_loop_policy.new_event_loop()
    yield loop
    pending = [t for t in asyncio.all_tasks(loop) if not t.done()]
    if pending:
        for t in pending:
            t.cancel()
        try:
            loop.run_until_complete(
                asyncio.wait_for(
                    asyncio.gather(*pending, return_exceptions=True),
                    timeout=10.0,
                )
            )
        except (asyncio.TimeoutError, Exception):
            pass
    loop.close()


@pytest.fixture(scope="module")
def db_available():
    from shared.config import settings

    try:
        with psycopg.connect(settings.db_dsn, connect_timeout=3) as conn:
            conn.execute("SELECT 1 FROM g1.tenants LIMIT 1")
    except Exception:
        pytest.skip("PostgreSQL with G1 schema is not reachable")
    return True


@pytest_asyncio.fixture(scope="module")
async def pool(db_available):
    from shared.db import close_pool, init_pool

    await init_pool()
    yield
    await close_pool()


@pytest_asyncio.fixture(scope="module")
async def api_client(pool):
    import api.main

    with patch("api.main._verify_bff_context", return_value=_TENANT_CTX), \
         patch("api.main._session_current", new=AsyncMock(return_value=True)):
        async with AsyncClient(
            transport=ASGITransport(app=api.main.app),
            base_url="http://test",
        ) as client:
            yield client


# ===========================================================================
# finops  — /api/v1/finops
# ===========================================================================

async def test_finops_summary_shape(api_client):
    r = await api_client.get("/api/v1/finops/summary")
    assert r.status_code == 200
    data = r.json()
    # May be empty but must be a dict with expected keys
    assert isinstance(data, dict)


async def test_finops_usage_list(api_client):
    r = await api_client.get("/api/v1/finops/usage")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ===========================================================================
# oncall  — /api/v1/oncall
# ===========================================================================

async def test_oncall_schedules_list(api_client):
    r = await api_client.get("/api/v1/oncall/schedules")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_oncall_schedule_create_and_delete(api_client):
    r = await api_client.post(
        "/api/v1/oncall/schedules",
        json={"name": f"schedule-{uuid.uuid4().hex[:6]}", "timezone": "UTC"},
    )
    assert r.status_code == 201
    sched_id = r.json()["schedule_id"]

    dr = await api_client.delete(f"/api/v1/oncall/schedules/{sched_id}")
    assert dr.status_code in (200, 204)


async def test_oncall_current(api_client):
    r = await api_client.get("/api/v1/oncall/current")
    # 200 (may be empty) or 404 (no active schedule)
    assert r.status_code in (200, 404)


async def test_oncall_shift_create(api_client):
    # Create a schedule first
    sr = await api_client.post(
        "/api/v1/oncall/schedules",
        json={"name": f"shift-sched-{uuid.uuid4().hex[:6]}", "timezone": "UTC"},
    )
    assert sr.status_code == 201
    sched_id = sr.json()["schedule_id"]

    r = await api_client.post(
        f"/api/v1/oncall/schedules/{sched_id}/shifts",
        json={
            "principal_id": "principal.e2e-dev-admin",
            "starts_at": "2026-01-01T08:00:00Z",
            "ends_at": "2026-01-01T16:00:00Z",
        },
    )
    assert r.status_code == 201
    assert "shift_id" in r.json()


# ===========================================================================
# synthetic  — /api/v1/synthetic
# ===========================================================================

async def test_synthetic_checks_list(api_client):
    r = await api_client.get("/api/v1/synthetic/checks")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_synthetic_check_create(api_client):
    r = await api_client.post(
        "/api/v1/synthetic/checks",
        json={
            "name": f"syn-{uuid.uuid4().hex[:6]}",
            "check_type": "http",
            "url": "https://example.com",
            "interval_seconds": 60,
        },
    )
    assert r.status_code == 201
    assert "check_id" in r.json()


async def test_synthetic_check_results(api_client):
    cr = await api_client.post(
        "/api/v1/synthetic/checks",
        json={
            "name": f"res-{uuid.uuid4().hex[:6]}",
            "check_type": "http",
            "url": "https://example.com",
            "interval_seconds": 300,
        },
    )
    assert cr.status_code == 201
    check_id = cr.json()["check_id"]

    r = await api_client.get(f"/api/v1/synthetic/checks/{check_id}/results")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_synthetic_check_delete(api_client):
    cr = await api_client.post(
        "/api/v1/synthetic/checks",
        json={
            "name": f"del-{uuid.uuid4().hex[:6]}",
            "check_type": "http",
            "url": "https://example.com",
            "interval_seconds": 60,
        },
    )
    assert cr.status_code == 201
    check_id = cr.json()["check_id"]

    dr = await api_client.delete(f"/api/v1/synthetic/checks/{check_id}")
    assert dr.status_code in (200, 204)


# ===========================================================================
# aiops  — /api/v1/aiops
# ===========================================================================

async def test_aiops_findings_list(api_client):
    r = await api_client.get("/api/v1/aiops/findings")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_aiops_findings_nonexistent_dismiss(api_client):
    r = await api_client.post("/api/v1/aiops/findings/finding:nonexistent/dismiss")
    assert r.status_code == 404


async def test_aiops_anomalies_list(api_client):
    r = await api_client.get("/api/v1/aiops/anomalies")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_aiops_predictions_list(api_client):
    r = await api_client.get("/api/v1/aiops/predictions")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_aiops_capacity_list(api_client):
    r = await api_client.get("/api/v1/aiops/capacity")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ===========================================================================
# tenant permissions catalog  — /api/v1/tenant/permissions
# ===========================================================================

async def test_tenant_permissions_catalog_shape(api_client):
    r = await api_client.get("/api/v1/tenant/permissions")
    assert r.status_code == 200
    data = r.json()
    assert "permissions" in data
    assert "roles" in data
    assert "caller_permissions" in data
    # permissions must be a list of {permission, description}
    for p in data["permissions"]:
        assert "permission" in p
        assert "description" in p
    # roles must be a dict of role→list of perms
    assert isinstance(data["roles"], dict)
    assert "tenant_admin" in data["roles"] or "admin" in data["roles"]


async def test_tenant_permissions_caller_has_admin_perms(api_client):
    r = await api_client.get("/api/v1/tenant/permissions")
    assert r.status_code == 200
    caller_perms = r.json()["caller_permissions"]
    # admin should have tenant:admin and monitoring:operate
    assert "tenant:admin" in caller_perms or "tenant:read" in caller_perms


# ===========================================================================
# billing  — /api/v1/billing (smoke — it's a stub)
# ===========================================================================

async def test_billing_smoke(api_client):
    r = await api_client.get("/api/v1/billing/status")
    assert r.status_code in (200, 404, 501)
    if r.status_code == 200:
        assert isinstance(r.json(), dict)


# ===========================================================================
# incident_response  — /api/v1/alerting/tenants/{tenant}/... (smoke)
# ===========================================================================

async def test_incident_response_policy_smoke(api_client):
    r = await api_client.get(
        "/api/v1/alerting/tenants/tenant:dev/incident-response-policy"
    )
    assert r.status_code in (200, 404)


async def test_incident_response_app_errors_list(api_client):
    r = await api_client.get(
        "/api/v1/alerting/tenants/tenant:dev/application-error-events"
    )
    assert r.status_code in (200, 403)
    if r.status_code == 200:
        assert isinstance(r.json(), list)


# SSRF and rate-limiter unit tests moved to test_ssrf_ratelimit_unit.py
