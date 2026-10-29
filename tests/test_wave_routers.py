"""Integration tests for Wave 1-2-3 routers.

Covers: feature_flags, config_drift, tenant_settings, apm, push,
        account_security (LGPD), executive, client_portal.

Requires PostgreSQL with G1 schema applied.
Tests skip gracefully when DB is unreachable.
"""

from __future__ import annotations

import asyncio
import os
import sys
import uuid
from contextlib import ExitStack
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

os.environ.setdefault("APP_ENVIRONMENT", "development")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")
os.environ.setdefault("VAPID_PRIVATE_KEY", "test-vapid-private-key")
os.environ.setdefault("VAPID_PUBLIC_KEY", "test-vapid-public-key")
os.environ.setdefault("VAPID_CLAIMS_SUB", "mailto:test@test.com")

pytestmark = pytest.mark.integration

_TENANT_CTX = {
    "principal_id": "principal.e2e-dev-admin",
    "session_digest": "test-digest",
    "session_generation": "gen-test",
    "tenant_id": "tenant:dev",
    "role": "admin",
    "correlation_id": None,
}

_PLATFORM_CTX = {
    "principal_id": "dev-platform-admin",
    "session_digest": "test-digest",
    "session_generation": "gen-test",
    "tenant_id": None,
    "role": "platform_admin_principal",
    "is_platform_admin": True,
    "correlation_id": None,
}


# ---------------------------------------------------------------------------
# Module-level skip when DB is unreachable
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def db_available():
    import psycopg
    from shared.config import settings

    try:
        with psycopg.connect(settings.db_dsn, connect_timeout=3) as conn:
            conn.execute("SELECT 1 FROM g1.feature_flag LIMIT 1")
    except Exception:
        pytest.skip("PostgreSQL with G1 schema is not reachable")
    return True


@pytest.fixture(scope="module")
def api_client(db_available):
    import api.main

    with ExitStack() as stack:
        stack.enter_context(
            patch("api.main._verify_bff_context", return_value=_TENANT_CTX)
        )
        stack.enter_context(
            patch(
                "api.main._session_current",
                new=AsyncMock(return_value=True),
            )
        )
        with TestClient(api.main.app) as client:
            yield client


@pytest.fixture(scope="module")
def admin_client(db_available):
    """Platform-admin context for executive endpoints."""
    import api.main

    with ExitStack() as stack:
        stack.enter_context(
            patch("api.main._verify_bff_context", return_value=_PLATFORM_CTX)
        )
        stack.enter_context(
            patch(
                "api.main._session_current",
                new=AsyncMock(return_value=True),
            )
        )
        with TestClient(api.main.app) as client:
            yield client


@pytest.fixture
def db_sync(db_available):
    import psycopg
    from shared.config import settings

    with psycopg.connect(settings.db_dsn) as conn:
        conn.autocommit = False
        yield conn


# ===========================================================================
# feature_flags  — prefix /api/v1/feature-flags
# ===========================================================================


def test_feature_flags_list(api_client):
    """GET /api/v1/feature-flags returns a list of flags."""
    r = api_client.get("/api/v1/feature-flags")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_feature_flags_put_upserts(api_client):
    """PUT /api/v1/feature-flags/{key} creates or updates a flag."""
    flag_key = f"test_flag_{uuid.uuid4().hex[:8]}"
    r = api_client.put(
        f"/api/v1/feature-flags/{flag_key}",
        json={"enabled": False},
    )
    assert r.status_code == 200
    assert r.json()["enabled"] is False
    assert r.json()["flag_key"] == flag_key


def test_feature_flags_check(api_client):
    """GET /api/v1/feature-flags/check/{key} returns enabled status."""
    r = api_client.get("/api/v1/feature-flags/check/module_aiops")
    # 200 if flag exists, 404 if not seeded — both are valid
    assert r.status_code in (200, 404)
    if r.status_code == 200:
        assert "enabled" in r.json()


# ===========================================================================
# config_drift  — prefix /api/v1/drift
# ===========================================================================


@pytest.fixture
def baseline_id(api_client):
    """Create a config baseline via the API, clean up after."""
    r = api_client.post(
        "/api/v1/drift/baselines",
        json={
            "source_id": "src-test-001",
            "resource_ref": "device/test",
            "config_key": "ntp_server",
            "expected_value": "pool.ntp.org",
        },
    )
    assert r.status_code == 201
    bid = r.json()["baseline_id"]
    yield bid
    api_client.delete(f"/api/v1/drift/baselines/{bid}")


def test_drift_create_and_delete_baseline(api_client):
    """Round-trip: create a baseline then delete it."""
    r = api_client.post(
        "/api/v1/drift/baselines",
        json={
            "source_id": "src-tmp",
            "resource_ref": "device/tmp",
            "config_key": "dns",
            "expected_value": "8.8.8.8",
        },
    )
    assert r.status_code == 201
    bid = r.json()["baseline_id"]

    dr = api_client.delete(f"/api/v1/drift/baselines/{bid}")
    assert dr.status_code == 200
    assert dr.json()["deleted"] is True


def test_drift_list_baselines(api_client, baseline_id):
    """GET /api/v1/drift/baselines lists existing baselines."""
    r = api_client.get("/api/v1/drift/baselines")
    assert r.status_code == 200
    ids = [b["baseline_id"] for b in r.json()]
    assert baseline_id in ids


def test_drift_scan_no_crash(api_client, baseline_id):
    """POST /api/v1/drift/scan returns valid response (0 drifts, no 500)."""
    r = api_client.post("/api/v1/drift/scan")
    assert r.status_code == 200
    body = r.json()
    assert "scanned" in body
    assert "drifts_found" in body
    assert body["drifts_found"] == 0


def test_drift_events_list(api_client):
    """GET /api/v1/drift/events returns a list."""
    r = api_client.get("/api/v1/drift/events")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


def test_drift_summary(api_client):
    """GET /api/v1/drift/summary returns total_baselines and open_drifts."""
    r = api_client.get("/api/v1/drift/summary")
    assert r.status_code == 200
    body = r.json()
    assert "total_baselines" in body
    assert "open_drifts" in body


def test_drift_delete_nonexistent(api_client):
    """DELETE on a non-existent baseline returns 404."""
    r = api_client.delete("/api/v1/drift/baselines/00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


# ===========================================================================
# tenant_settings  — prefix /api/v1/tenant-settings
# ===========================================================================


def test_tenant_settings_get(api_client):
    """GET /api/v1/tenant-settings returns current settings."""
    r = api_client.get("/api/v1/tenant-settings")
    assert r.status_code == 200


def test_tenant_settings_put(api_client):
    """PUT /api/v1/tenant-settings persists fields."""
    r = api_client.put(
        "/api/v1/tenant-settings",
        json={"timezone": "America/Sao_Paulo"},
    )
    assert r.status_code == 200
    assert r.json().get("timezone") == "America/Sao_Paulo"


def test_tenant_settings_smtp_test_no_host(api_client):
    """POST /api/v1/tenant-settings/smtp/test with no SMTP configured
    returns an error response (not a 5xx crash)."""
    r = api_client.post(
        "/api/v1/tenant-settings/smtp/test",
        json={"to": "nobody@example.com"},
    )
    # 400 = no SMTP configured, 422 = validation, 503 = service unavailable
    assert r.status_code in (400, 422, 503)


# ===========================================================================
# apm  — prefix /api/v1/apm
# ===========================================================================


def test_apm_overview(api_client):
    """GET /api/v1/apm/overview returns APM statistics."""
    r = api_client.get("/api/v1/apm/overview")
    assert r.status_code == 200
    body = r.json()
    # Response has summary stats
    assert any(k in body for k in ("p50_ms", "total_requests", "endpoints", "summary"))


# ===========================================================================
# push  — prefix /api/v1/push
# ===========================================================================


def test_push_vapid_key(api_client):
    """GET /api/v1/push/vapid-public-key returns the public key."""
    r = api_client.get("/api/v1/push/vapid-public-key")
    assert r.status_code == 200
    assert "public_key" in r.json()


def test_push_subscribe_and_list(api_client, db_sync):
    """POST /subscribe stores a subscription; GET /subscriptions lists it."""
    endpoint = f"https://fcm.test/endpoint/{uuid.uuid4().hex}"
    r = api_client.post(
        "/api/v1/push/subscribe",
        json={
            "endpoint": endpoint,
            "keys": {"p256dh": "test-p256dh-key", "auth": "test-auth-key"},
        },
    )
    assert r.status_code == 201
    assert r.json()["ok"] is True

    lr = api_client.get("/api/v1/push/subscriptions")
    assert lr.status_code == 200
    subs = lr.json().get("subscriptions", [])
    assert isinstance(subs, list)
    assert len(subs) >= 1

    # Cleanup
    db_sync.execute(
        "DELETE FROM g1.push_subscription WHERE endpoint = %s",
        (endpoint,),
    )
    db_sync.commit()


# ===========================================================================
# account_security — LGPD  — prefix /api/v1/account
# ===========================================================================


def test_lgpd_export(api_client):
    """POST /api/v1/account/lgpd/export returns principal data."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {
        "username": "dev-admin",
        "email": "dev-admin@example.com",
        "enabled": True,
    }
    with patch("api.routers.account_security._admin_token", new=AsyncMock(return_value="test-token")), \
         patch("httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        mock_client.get = AsyncMock(return_value=mock_response)

        r = api_client.post("/api/v1/account/lgpd/export")

    assert r.status_code == 200
    body = r.json()
    assert "data" in body
    assert "principal_id" in body["data"]


def test_lgpd_deletion_request_no_confirm(api_client):
    """POST lgpd/deletion-request without confirm=true returns 400."""
    r = api_client.post(
        "/api/v1/account/lgpd/deletion-request",
        json={"confirm": False},
    )
    assert r.status_code == 400


def test_lgpd_deletion_request_confirmed(api_client, db_sync):
    """POST lgpd/deletion-request with confirm=true creates a pending row."""
    _pid = "principal.e2e-dev-admin"
    # Ensure no existing pending request from a prior test run
    db_sync.execute(
        "DELETE FROM g1.lgpd_deletion_requests WHERE principal_id = %s",
        (_pid,),
    )
    db_sync.commit()

    r = api_client.post(
        "/api/v1/account/lgpd/deletion-request",
        json={"confirm": True},
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert body["status"] in ("pending", "processing")

    # Cleanup
    db_sync.execute(
        "DELETE FROM g1.lgpd_deletion_requests WHERE principal_id = %s",
        (_pid,),
    )
    db_sync.commit()


def test_lgpd_deletion_request_idempotent(api_client, db_sync):
    """Second deletion request returns already_exists=True."""
    _pid = "principal.e2e-dev-admin"
    db_sync.execute(
        "INSERT INTO g1.lgpd_deletion_requests (principal_id, status) "
        "VALUES (%s, 'pending')",
        (_pid,),
    )
    db_sync.commit()

    r = api_client.post(
        "/api/v1/account/lgpd/deletion-request",
        json={"confirm": True},
    )
    assert r.status_code == 200
    assert r.json()["already_exists"] is True

    db_sync.execute(
        "DELETE FROM g1.lgpd_deletion_requests WHERE principal_id = %s",
        (_pid,),
    )
    db_sync.commit()


# ===========================================================================
# account_security — MFA  — prefix /api/v1/account
# ===========================================================================


def test_mfa_status(api_client):
    """GET /api/v1/account/mfa/status returns totp_enabled bool."""
    mock_response = MagicMock()
    mock_response.status_code = 200
    mock_response.json.return_value = {"credentials": []}

    with patch("api.routers.account_security._admin_token", new=AsyncMock(return_value="test-token")), \
         patch("httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_cls.return_value.__aenter__ = AsyncMock(return_value=mock_client)
        mock_cls.return_value.__aexit__ = AsyncMock(return_value=False)
        mock_client.get = AsyncMock(return_value=mock_response)

        r = api_client.get("/api/v1/account/mfa/status")

    assert r.status_code == 200
    assert "totp_enabled" in r.json()


# ===========================================================================
# executive  — prefix /api/v1/executive
# ===========================================================================


def test_executive_overview(admin_client):
    """GET /api/v1/executive/overview returns platform KPIs (or 403 if seed not present)."""
    r = admin_client.get("/api/v1/executive/overview")
    assert r.status_code in (200, 403)
    if r.status_code == 200:
        body = r.json()
        assert any(k in body for k in ("total_tenants", "alerts", "incidents", "tenants"))


# ===========================================================================
# client_portal  — prefix /api/v1/portal
# ===========================================================================


def test_client_portal_overview(api_client):
    """GET /api/v1/portal/overview returns 200, 403, or 404."""
    r = api_client.get("/api/v1/portal/overview")
    assert r.status_code in (200, 403, 404)
    if r.status_code == 200:
        assert isinstance(r.json(), dict)


def test_client_portal_alerts(api_client):
    """GET /api/v1/portal/alerts returns a list or 403."""
    r = api_client.get("/api/v1/portal/alerts")
    assert r.status_code in (200, 403, 404)
    if r.status_code == 200:
        assert isinstance(r.json(), list)
