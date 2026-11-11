"""Bloco 5 — integration tests for remaining uncovered routers.

Covers: billing (invoice CRUD), automation credentials, sla, kb, layout,
        infra (certs/assets), branding, bugreport, api_keys, status_page,
        changes (RFC), escalation (policies/steps), client_companies,
        maintenance (windows).

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
    from shared.db import close_pool, db_connection, init_pool

    await init_pool()
    async with db_connection() as conn:
        await conn.execute(
            """
            INSERT INTO g1.principals
                (principal_id, kind, credential_generation)
            VALUES ('principal.e2e-dev-admin', 'human_browser_session', 'gen-e2e-bloco5')
            ON CONFLICT (principal_id) DO NOTHING
            """
        )
        await conn.execute(
            """
            INSERT INTO g1.tenant_memberships
                (membership_id, tenant_id, principal_id, role, state)
            VALUES ('mem-e2e-bloco5-admin', 'tenant:dev', 'principal.e2e-dev-admin', 'admin', 'active')
            ON CONFLICT (tenant_id, principal_id) DO NOTHING
            """
        )
        await conn.commit()
    yield
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


# ── Billing — invoice CRUD ─────────────────────────────────────────────────────

async def test_billing_invoices_list_empty_ok(api_client):
    r = await api_client.get("/api/v1/billing/invoices")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_billing_invoice_create_and_get(api_client):
    payload = {
        "period_start": "2026-01-01T00:00:00Z",
        "period_end": "2026-01-31T23:59:59Z",
        "amount_cents": 15000,
        "currency": "BRL",
        "line_items": [{"desc": "Monitoring", "cents": 15000}],
    }
    r = await api_client.post("/api/v1/billing/invoices", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert "invoice_id" in data
    assert data["status"] == "draft"
    invoice_id = data["invoice_id"]

    r2 = await api_client.get(f"/api/v1/billing/invoices/{invoice_id}")
    assert r2.status_code == 200
    inv = r2.json()
    assert inv["amount_cents"] == 15000
    assert inv["currency"] == "BRL"
    assert isinstance(inv["line_items"], list)


async def test_billing_invoice_period_end_before_start_rejected(api_client):
    r = await api_client.post("/api/v1/billing/invoices", json={
        "period_start": "2026-02-28T00:00:00Z",
        "period_end": "2026-01-01T00:00:00Z",
        "amount_cents": 0,
    })
    assert r.status_code == 422


async def test_billing_invoice_invalid_currency_rejected(api_client):
    r = await api_client.post("/api/v1/billing/invoices", json={
        "period_start": "2026-01-01T00:00:00Z",
        "period_end": "2026-01-31T00:00:00Z",
        "amount_cents": 100,
        "currency": "XYZ",
    })
    assert r.status_code == 422


async def test_billing_invoice_void(api_client):
    r = await api_client.post("/api/v1/billing/invoices", json={
        "period_start": "2026-03-01T00:00:00Z",
        "period_end": "2026-03-31T00:00:00Z",
        "amount_cents": 500,
    })
    assert r.status_code == 201
    invoice_id = r.json()["invoice_id"]

    r2 = await api_client.post(f"/api/v1/billing/invoices/{invoice_id}/void")
    assert r2.status_code == 200
    assert r2.json()["status"] == "void"

    # Voiding twice should 409
    r3 = await api_client.post(f"/api/v1/billing/invoices/{invoice_id}/void")
    assert r3.status_code == 409


async def test_billing_invoice_mark_paid(api_client):
    r = await api_client.post("/api/v1/billing/invoices", json={
        "period_start": "2026-04-01T00:00:00Z",
        "period_end": "2026-04-30T00:00:00Z",
        "amount_cents": 9900,
    })
    assert r.status_code == 201
    invoice_id = r.json()["invoice_id"]

    r2 = await api_client.post(f"/api/v1/billing/invoices/{invoice_id}/mark-paid")
    assert r2.status_code == 200
    assert r2.json()["status"] == "paid"

    # Cannot void a paid invoice
    r3 = await api_client.post(f"/api/v1/billing/invoices/{invoice_id}/void")
    assert r3.status_code == 409


async def test_billing_invoice_404(api_client):
    r = await api_client.get("/api/v1/billing/invoices/inv:nonexistent-404")
    assert r.status_code == 404


async def test_billing_summary_shape(api_client):
    r = await api_client.get("/api/v1/billing/summary")
    assert r.status_code == 200
    data = r.json()
    assert "adapter" in data
    assert "open_invoices" in data
    assert "current_month_usage" in data


async def test_billing_invoices_filter_by_status(api_client):
    r = await api_client.get("/api/v1/billing/invoices?inv_status=draft")
    assert r.status_code == 200
    for inv in r.json():
        assert inv["status"] == "draft"


# ── Automation — SSH credentials ───────────────────────────────────────────────

async def test_automation_credentials_list(api_client):
    r = await api_client.get("/api/v1/automation/credentials")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_automation_credential_create_and_delete(api_client):
    pem = "-----BEGIN RSA PRIVATE KEY-----\nfakekey\n-----END RSA PRIVATE KEY-----"
    r = await api_client.post("/api/v1/automation/credentials", json={
        "label": f"test-cred-{uuid.uuid4().hex[:8]}",
        "username": "deploy",
        "key_pem": pem,
    })
    assert r.status_code == 201
    data = r.json()
    assert "credential_id" in data
    credential_id = data["credential_id"]

    r2 = await api_client.delete(f"/api/v1/automation/credentials/{credential_id}")
    assert r2.status_code == 204


async def test_automation_credential_requires_pem(api_client):
    r = await api_client.post("/api/v1/automation/credentials", json={
        "label": "bad-key",
        "username": "user",
        "key_pem": "not a pem",
    })
    assert r.status_code == 422


async def test_automation_credential_delete_404(api_client):
    r = await api_client.delete("/api/v1/automation/credentials/cred:nonexistent")
    assert r.status_code == 404


async def test_automation_ssh_script_create_validates_host(api_client):
    r = await api_client.post("/api/v1/automation/scripts", json={
        "name": f"ssh-test-{uuid.uuid4().hex[:6]}",
        "script_type": "ssh_command",
        "config": {
            "host": "10.0.0.1",
            "credential_id": "cred:fake",
            "command": "uptime",
        },
    })
    assert r.status_code == 422  # SSRF guard blocks private IPs


async def test_automation_ssh_script_missing_command(api_client):
    r = await api_client.post("/api/v1/automation/scripts", json={
        "name": f"ssh-nocmd-{uuid.uuid4().hex[:6]}",
        "script_type": "ssh_command",
        "config": {
            "host": "example.com",
            "credential_id": "cred:fake",
            "command": "",
        },
    })
    assert r.status_code == 422


# ── SLA policies ───────────────────────────────────────────────────────────────

async def test_sla_policies_list(api_client):
    r = await api_client.get("/api/v1/sla/policies")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_sla_policy_create_and_delete(api_client):
    r = await api_client.post("/api/v1/sla/policies", json={
        "name": f"SLA-{uuid.uuid4().hex[:8]}",
        "severity_match": "HIGH",
        "response_secs": 300,
        "resolve_secs": 3600,
    })
    assert r.status_code == 201
    data = r.json()
    assert "sla_id" in data
    sla_id = data["sla_id"]

    r2 = await api_client.delete(f"/api/v1/sla/policies/{sla_id}")
    assert r2.status_code == 204


async def test_sla_policy_invalid_times(api_client):
    r = await api_client.post("/api/v1/sla/policies", json={
        "name": "bad-sla",
        "response_secs": -1,
        "resolve_secs": 3600,
    })
    assert r.status_code == 422


async def test_sla_trackers_list(api_client):
    r = await api_client.get("/api/v1/sla/trackers")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_sla_breaches_list(api_client):
    r = await api_client.get("/api/v1/sla/breaches")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ── Knowledge Base ─────────────────────────────────────────────────────────────

async def test_kb_categories_list(api_client):
    r = await api_client.get("/api/v1/kb/categories")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_kb_category_create_and_delete(api_client):
    r = await api_client.post("/api/v1/kb/categories", json={
        "name": f"Cat {uuid.uuid4().hex[:8]}"
    })
    assert r.status_code == 201
    data = r.json()
    assert "category_id" in data
    category_id = data["category_id"]

    r2 = await api_client.delete(f"/api/v1/kb/categories/{category_id}")
    assert r2.status_code == 204


async def test_kb_articles_list(api_client):
    r = await api_client.get("/api/v1/kb/articles")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_kb_article_create_and_get(api_client):
    r = await api_client.post("/api/v1/kb/articles", json={
        "title": f"Test Article {uuid.uuid4().hex[:8]}",
        "body": "This is the article body.",
        "status": "draft",
    })
    assert r.status_code == 201
    data = r.json()
    assert "article_id" in data
    article_id = data["article_id"]

    r2 = await api_client.get(f"/api/v1/kb/articles/{article_id}")
    assert r2.status_code == 200
    assert r2.json()["title"] == data["title"]
    assert isinstance(r2.json()["incidents"], list)


async def test_kb_article_invalid_status(api_client):
    r = await api_client.post("/api/v1/kb/articles", json={
        "title": "Bad Status",
        "status": "unknown_status",
    })
    assert r.status_code == 422


async def test_kb_article_search(api_client):
    unique = uuid.uuid4().hex
    await api_client.post("/api/v1/kb/articles", json={
        "title": f"Searchable {unique}",
        "body": "content to search",
        "status": "published",
    })
    r = await api_client.get(f"/api/v1/kb/articles?q={unique}")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_kb_article_404(api_client):
    r = await api_client.get("/api/v1/kb/articles/kba:nonexistent-404")
    assert r.status_code == 404


# ── Layout persistence ─────────────────────────────────────────────────────────

async def test_layout_get_returns_empty_for_new_view(api_client):
    r = await api_client.get("/api/v1/layout?view_type=dashboard")
    assert r.status_code == 200
    data = r.json()
    assert "layout" in data
    assert "view_type" in data


async def test_layout_put_and_get(api_client):
    layout_data = {"widgets": [{"id": "w1", "type": "alerts"}]}
    r = await api_client.put(
        "/api/v1/layout?view_type=tv_mode",
        json={"layout": layout_data},
    )
    assert r.status_code == 200
    assert r.json()["saved"] is True

    r2 = await api_client.get("/api/v1/layout?view_type=tv_mode")
    assert r2.status_code == 200
    assert r2.json()["layout"] == layout_data


async def test_layout_invalid_view_type(api_client):
    r = await api_client.get("/api/v1/layout?view_type=nonexistent")
    assert r.status_code == 422


# ── Infrastructure — certs and assets ─────────────────────────────────────────

async def test_infra_certs_list(api_client):
    r = await api_client.get("/api/v1/infra/certs")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_infra_cert_create(api_client):
    r = await api_client.post("/api/v1/infra/certs", json={
        "domain": f"test-{uuid.uuid4().hex[:8]}.example.com",
        "port": 443,
        "alert_days": 30,
    })
    assert r.status_code == 201
    data = r.json()
    assert "cert_id" in data


async def test_infra_cert_invalid_port(api_client):
    r = await api_client.post("/api/v1/infra/certs", json={
        "domain": "example.com",
        "port": 99999,
        "alert_days": 30,
    })
    assert r.status_code == 422


async def test_infra_assets_list(api_client):
    r = await api_client.get("/api/v1/infra/assets")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_infra_asset_create(api_client):
    r = await api_client.post("/api/v1/infra/assets", json={
        "name": f"asset-{uuid.uuid4().hex[:8]}",
        "asset_type": "server",
        "hostname": "srv01.example.com",
    })
    assert r.status_code == 201
    data = r.json()
    assert "asset_id" in data


async def test_infra_asset_invalid_type(api_client):
    r = await api_client.post("/api/v1/infra/assets", json={
        "name": "bad-type",
        "asset_type": "spaceship",
    })
    assert r.status_code == 422


# ── Branding ───────────────────────────────────────────────────────────────────

async def test_branding_get(api_client):
    r = await api_client.get("/api/v1/platform/branding")
    assert r.status_code == 200
    data = r.json()
    assert "configured" in data


async def test_branding_put_and_verify(api_client):
    r = await api_client.put("/api/v1/platform/branding", json={
        "brand_name": "Test Brand",
        "brand_color": "#1a2b3c",
    })
    assert r.status_code in (200, 201)


async def test_branding_invalid_color(api_client):
    r = await api_client.put("/api/v1/platform/branding", json={
        "brand_color": "not-a-hex",
    })
    assert r.status_code == 422


# ── Bug reports ────────────────────────────────────────────────────────────────

async def test_bugreport_list(api_client):
    r = await api_client.get("/api/v1/bugs")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_bugreport_create(api_client):
    r = await api_client.post("/api/v1/bugs", json={
        "screen_id": "AlertsPage",
        "screen_url": "/alerts",
        "title": "Test bug report",
        "description": "Something went wrong",
    })
    assert r.status_code == 201
    data = r.json()
    assert "bug_id" in data or "report_id" in data


async def test_bugreport_missing_screen_id(api_client):
    # screen_id is required (not Optional in the model)
    r = await api_client.post("/api/v1/bugs", json={
        "title": "No screen id",
    })
    assert r.status_code == 422


# ── API Keys ───────────────────────────────────────────────────────────────────

async def test_api_keys_list(api_client):
    r = await api_client.get("/api/v1/api-keys")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_api_key_create_returns_raw_key(api_client):
    r = await api_client.post("/api/v1/api-keys", json={
        "label": f"test-key-{uuid.uuid4().hex[:8]}",
        "scopes": ["read"],
    })
    assert r.status_code == 201
    data = r.json()
    assert "key_id" in data
    assert "raw_key" in data
    assert len(data["raw_key"]) > 20  # actual key, not a hash


async def test_api_key_revoke(api_client):
    r = await api_client.post("/api/v1/api-keys", json={
        "label": f"revoke-me-{uuid.uuid4().hex[:8]}",
        "scopes": ["read"],
    })
    assert r.status_code == 201
    key_id = r.json()["key_id"]

    r2 = await api_client.delete(f"/api/v1/api-keys/{key_id}")
    assert r2.status_code == 200  # revoke returns 200 with {"state": "revoked"}
    assert r2.json()["state"] == "revoked"


async def test_api_key_invalid_scope(api_client):
    r = await api_client.post("/api/v1/api-keys", json={
        "label": "bad-scope-key",
        "scopes": ["root_access"],
    })
    assert r.status_code == 422


# ── Maintenance windows ────────────────────────────────────────────────────────

async def test_maintenance_windows_list(api_client):
    r = await api_client.get("/api/v1/maintenance/windows")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_maintenance_window_create_and_cancel(api_client):
    r = await api_client.post("/api/v1/maintenance/windows", json={
        "label": f"MW-{uuid.uuid4().hex[:8]}",
        "tenant_id": "tenant:dev",
        "starts_at": "2026-12-01T02:00:00Z",
        "ends_at": "2026-12-01T04:00:00Z",
    })
    assert r.status_code in (201, 200)
    data = r.json()
    mw_id = data.get("window_id") or data.get("maintenance_window_id")
    if mw_id:
        r2 = await api_client.delete(f"/api/v1/maintenance/windows/{mw_id}")
        assert r2.status_code in (204, 200)


# ── Status page (admin config) ─────────────────────────────────────────────────

async def test_status_page_config_get(api_client):
    r = await api_client.get("/api/v1/platform/status-page")
    assert r.status_code == 200
    data = r.json()
    assert "configured" in data


async def test_status_page_config_update(api_client):
    r = await api_client.put("/api/v1/platform/status-page", json={
        "public_name": "Test Status Page",
        "status_slug": f"test-{uuid.uuid4().hex[:8]}",
        "enabled": False,
    })
    assert r.status_code in (200, 201, 204)


# ── Changes / RFC ──────────────────────────────────────────────────────────────

async def test_changes_list(api_client):
    r = await api_client.get("/api/v1/itsm/changes")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_changes_create(api_client):
    r = await api_client.post("/api/v1/itsm/changes", json={
        "title": f"RFC-{uuid.uuid4().hex[:8]}",
        "description": "Planned maintenance on DB",
        "category": "normal",
        "risk": "low",
    })
    assert r.status_code == 201
    data = r.json()
    assert "rfc_id" in data


async def test_changes_invalid_category(api_client):
    r = await api_client.post("/api/v1/itsm/changes", json={
        "title": "Bad RFC",
        "category": "alien_invasion",
    })
    assert r.status_code == 422


# ── Escalation policies ────────────────────────────────────────────────────────

async def test_escalation_policies_list(api_client):
    r = await api_client.get("/api/v1/alerting/escalation-policies")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_escalation_policy_create_and_delete(api_client):
    r = await api_client.post("/api/v1/alerting/escalation-policies", json={
        "name": f"Esc-{uuid.uuid4().hex[:8]}",
        "description": "Test escalation",
    })
    assert r.status_code == 201
    data = r.json()
    assert "policy_id" in data
    policy_id = data["policy_id"]

    r2 = await api_client.delete(
        f"/api/v1/alerting/escalation-policies/{policy_id}"
    )
    assert r2.status_code in (204, 200)
