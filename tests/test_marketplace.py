"""Integration tests for the marketplace router (G13-adjacent).

Covers: catalog listing, single-integration detail, per-tenant install/uninstall,
        toggle state, stats endpoint, and 409 on duplicate install.

Requires PostgreSQL with G1 schema applied (migration 074).
Tests skip gracefully when DB is unreachable.
"""

from __future__ import annotations

import asyncio
import os
import sys
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
    "principal_id": "principal.e2e-marketplace",
    "session_digest": "test-digest-marketplace",
    "session_generation": "gen-test-marketplace",
    "tenant_id": "tenant:dev",
    "role": "admin",
    "correlation_id": None,
}

_TEST_INTEGRATION_ID = "int:test-slack-mkt"


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
            conn.execute("SELECT 1 FROM g1.marketplace_integration LIMIT 1")
    except Exception:
        pytest.skip("PostgreSQL with G1 schema (migration 074) is not reachable")
    return True


@pytest_asyncio.fixture(scope="module")
async def pool(db_available):
    from shared.db import close_pool, db_connection, init_pool

    await init_pool()
    async with db_connection() as conn:
        await conn.execute(
            """
            INSERT INTO g1.principals
                (principal_id, kind, credential_generation)
            VALUES ('principal.e2e-marketplace', 'human_browser_session', 'gen-e2e-mkt')
            ON CONFLICT (principal_id) DO NOTHING
            """
        )
        await conn.execute(
            """
            INSERT INTO g1.tenant_memberships
                (membership_id, tenant_id, principal_id, role, state)
            VALUES ('mem-e2e-mkt-admin', 'tenant:dev', 'principal.e2e-marketplace', 'admin', 'active')
            ON CONFLICT (tenant_id, principal_id) DO NOTHING
            """
        )
        # Ensure test integration exists in catalog
        await conn.execute(
            """
            INSERT INTO g1.marketplace_integration
                (integration_id, name, description, category, icon_emoji, vendor)
            VALUES (%s, 'Test Slack MKT', 'Test integration for marketplace suite', 'chatops', '💬', 'Test')
            ON CONFLICT DO NOTHING
            """,
            (_TEST_INTEGRATION_ID,),
        )
        # Clean up any leftover installation from a previous run
        await conn.execute(
            "DELETE FROM g1.tenant_integration WHERE tenant_id = 'tenant:dev' AND integration_id = %s",
            (_TEST_INTEGRATION_ID,),
        )
        await conn.commit()
    yield
    # Teardown
    async with db_connection() as conn:
        await conn.execute(
            "DELETE FROM g1.tenant_integration WHERE tenant_id = 'tenant:dev' AND integration_id = %s",
            (_TEST_INTEGRATION_ID,),
        )
        await conn.execute(
            "DELETE FROM g1.marketplace_integration WHERE integration_id = %s",
            (_TEST_INTEGRATION_ID,),
        )
        await conn.commit()
    await close_pool()


@pytest_asyncio.fixture(scope="module")
async def api_client(pool):
    import api.main

    with patch("api.main._verify_bff_context", return_value=_TENANT_CTX), \
         patch("api.main._session_current", new=AsyncMock(return_value=True)):
        async with AsyncClient(
            transport=ASGITransport(app=api.main.app), base_url="http://test"
        ) as client:
            yield client


# ── Catalog ──────────────────────────────────────────────────────────────────

class TestCatalog:
    async def test_list_catalog(self, api_client: AsyncClient):
        r = await api_client.get("/api/v1/marketplace")
        assert r.status_code == 200
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 1
        # Seed integrations must be present
        ids = {i["integration_id"] for i in data}
        assert "int:slack" in ids

    async def test_list_catalog_has_expected_fields(self, api_client: AsyncClient):
        r = await api_client.get("/api/v1/marketplace")
        assert r.status_code == 200
        item = r.json()[0]
        for field in ("integration_id", "name", "description", "category",
                      "icon_emoji", "vendor", "is_enabled", "created_at"):
            assert field in item, f"missing field: {field}"

    async def test_get_catalog_entry(self, api_client: AsyncClient):
        r = await api_client.get(f"/api/v1/marketplace/catalog/{_TEST_INTEGRATION_ID}")
        assert r.status_code == 200
        data = r.json()
        assert data["integration_id"] == _TEST_INTEGRATION_ID
        assert data["name"] == "Test Slack MKT"
        assert "config_schema" in data

    async def test_get_catalog_entry_not_found(self, api_client: AsyncClient):
        r = await api_client.get("/api/v1/marketplace/catalog/int:does-not-exist-xyz")
        assert r.status_code == 404

    async def test_create_catalog_entry(self, api_client: AsyncClient):
        new_id = "int:test-new-mkt-entry"
        try:
            r = await api_client.post("/api/v1/marketplace/catalog", json={
                "integration_id": new_id,
                "name": "Test New Entry",
                "description": "A test catalog entry",
                "category": "automation",
                "icon_emoji": "⚙️",
                "vendor": "Test Vendor",
            })
            assert r.status_code == 201
            data = r.json()
            assert data["integration_id"] == new_id
        finally:
            # cleanup
            from shared.db import db_connection
            async with db_connection() as conn:
                await conn.execute(
                    "DELETE FROM g1.marketplace_integration WHERE integration_id = %s",
                    (new_id,),
                )
                await conn.commit()


# ── Stats ─────────────────────────────────────────────────────────────────────

class TestStats:
    async def test_stats_shape(self, api_client: AsyncClient):
        r = await api_client.get("/api/v1/marketplace/stats")
        assert r.status_code == 200
        data = r.json()
        for field in ("catalog_total", "installed", "active", "inactive", "error"):
            assert field in data
        assert data["catalog_total"] >= 1


# ── Per-tenant installations ───────────────────────────────────────────────────

class TestInstallations:
    async def test_installed_list_empty_initially(self, api_client: AsyncClient):
        r = await api_client.get("/api/v1/marketplace/installed")
        assert r.status_code == 200
        ids = [i["integration_id"] for i in r.json()]
        assert _TEST_INTEGRATION_ID not in ids

    async def test_install(self, api_client: AsyncClient):
        r = await api_client.post(
            f"/api/v1/marketplace/{_TEST_INTEGRATION_ID}/install",
            json={"config": {"channel": "#alerts"}},
        )
        assert r.status_code == 201
        data = r.json()
        assert data["integration_id"] == _TEST_INTEGRATION_ID
        assert data["state"] == "active"

    async def test_installed_list_contains_after_install(self, api_client: AsyncClient):
        r = await api_client.get("/api/v1/marketplace/installed")
        assert r.status_code == 200
        ids = [i["integration_id"] for i in r.json()]
        assert _TEST_INTEGRATION_ID in ids

    async def test_install_duplicate_returns_409(self, api_client: AsyncClient):
        r = await api_client.post(
            f"/api/v1/marketplace/{_TEST_INTEGRATION_ID}/install",
            json={},
        )
        assert r.status_code == 409

    async def test_install_nonexistent_returns_404(self, api_client: AsyncClient):
        r = await api_client.post(
            "/api/v1/marketplace/int:does-not-exist-xyz/install",
            json={},
        )
        assert r.status_code == 404

    async def test_toggle_inactive(self, api_client: AsyncClient):
        r = await api_client.patch(
            f"/api/v1/marketplace/{_TEST_INTEGRATION_ID}/install",
            json={"state": "inactive"},
        )
        assert r.status_code == 200
        assert r.json()["updated"] is True

    async def test_toggle_back_active(self, api_client: AsyncClient):
        r = await api_client.patch(
            f"/api/v1/marketplace/{_TEST_INTEGRATION_ID}/install",
            json={"state": "active"},
        )
        assert r.status_code == 200

    async def test_update_config(self, api_client: AsyncClient):
        r = await api_client.patch(
            f"/api/v1/marketplace/{_TEST_INTEGRATION_ID}/install",
            json={"config": {"channel": "#critical"}},
        )
        assert r.status_code == 200

    async def test_patch_nonexistent_returns_404(self, api_client: AsyncClient):
        r = await api_client.patch(
            "/api/v1/marketplace/int:does-not-exist-xyz/install",
            json={"state": "inactive"},
        )
        assert r.status_code == 404

    async def test_uninstall(self, api_client: AsyncClient):
        r = await api_client.delete(
            f"/api/v1/marketplace/{_TEST_INTEGRATION_ID}/install"
        )
        assert r.status_code == 204

    async def test_uninstall_already_gone_returns_404(self, api_client: AsyncClient):
        r = await api_client.delete(
            f"/api/v1/marketplace/{_TEST_INTEGRATION_ID}/install"
        )
        assert r.status_code == 404

    async def test_installed_list_empty_after_uninstall(self, api_client: AsyncClient):
        r = await api_client.get("/api/v1/marketplace/installed")
        assert r.status_code == 200
        ids = [i["integration_id"] for i in r.json()]
        assert _TEST_INTEGRATION_ID not in ids

    async def test_stats_after_uninstall(self, api_client: AsyncClient):
        r = await api_client.get("/api/v1/marketplace/stats")
        assert r.status_code == 200
        data = r.json()
        # installed should be 0 (we cleaned up)
        assert data["installed"] == 0
