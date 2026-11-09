"""Bloco 4A — integration tests for previously uncovered routers.

Covers: automation, msp, reports, helpdesk, onboarding (self-managed).

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
# automation  — /api/v1/automation/scripts  +  /schedules  +  /runs
# ===========================================================================

async def test_automation_scripts_list(api_client):
    r = await api_client.get("/api/v1/automation/scripts")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_automation_script_create_webhook(api_client):
    r = await api_client.post(
        "/api/v1/automation/scripts",
        json={
            "name": f"test-webhook-{uuid.uuid4().hex[:6]}",
            "script_type": "webhook",
            "config": {"url": "https://example.com/hook"},
        },
    )
    assert r.status_code == 201
    data = r.json()
    assert "script_id" in data


async def test_automation_script_rejects_ssrf(api_client):
    r = await api_client.post(
        "/api/v1/automation/scripts",
        json={
            "name": "ssrf-test",
            "script_type": "webhook",
            "config": {"url": "https://192.168.1.1/steal"},
        },
    )
    assert r.status_code == 422


async def test_automation_script_rejects_http(api_client):
    r = await api_client.post(
        "/api/v1/automation/scripts",
        json={
            "name": "http-test",
            "script_type": "webhook",
            "config": {"url": "http://example.com/hook"},
        },
    )
    assert r.status_code == 422


async def test_automation_script_list_includes_created(api_client):
    name = f"list-test-{uuid.uuid4().hex[:6]}"
    cr = await api_client.post(
        "/api/v1/automation/scripts",
        json={
            "name": name,
            "script_type": "noop",
            "config": {},
        },
    )
    assert cr.status_code == 201
    script_id = cr.json()["script_id"]

    lr = await api_client.get("/api/v1/automation/scripts")
    assert lr.status_code == 200
    ids = [row["script_id"] for row in lr.json()]
    assert script_id in ids


async def test_automation_runs_list(api_client):
    r = await api_client.get("/api/v1/automation/runs")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_automation_schedules_list(api_client):
    r = await api_client.get("/api/v1/automation/schedules")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ===========================================================================
# msp  — /api/v1/msp
# ===========================================================================

async def test_msp_overview_ok(api_client):
    r = await api_client.get("/api/v1/msp/overview")
    # May return 200 (empty list) or 403 if caller isn't MSP admin
    assert r.status_code in (200, 403)
    if r.status_code == 200:
        assert isinstance(r.json(), list)


async def test_msp_clients_create_requires_msp_admin(api_client):
    """dev-admin is in tenant:dev (not an MSP tenant) → should get 403."""
    r = await api_client.post(
        "/api/v1/msp/clients",
        json={"client_name": "Test Client", "client_slug": "test-client-xyz"},
    )
    # 403 expected because tenant:dev is not org_kind='msp'
    assert r.status_code == 403


async def test_msp_clients_bad_slug(api_client):
    """Slug validation — uppercase / special chars rejected."""
    r = await api_client.post(
        "/api/v1/msp/clients",
        json={"client_name": "Bad Slug", "client_slug": "Bad Slug!"},
    )
    assert r.status_code in (422, 403)


# ===========================================================================
# reports  — /api/v1/reports
# ===========================================================================

async def test_reports_templates_list(api_client):
    r = await api_client.get("/api/v1/reports/templates")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_reports_template_create_and_delete(api_client):
    r = await api_client.post(
        "/api/v1/reports/templates",
        json={
            "name": f"rpt-{uuid.uuid4().hex[:6]}",
            "report_type": "alert_summary",
            "delivery_email": "test@example.com",
        },
    )
    assert r.status_code == 201
    tid = r.json()["template_id"]

    dr = await api_client.delete(f"/api/v1/reports/templates/{tid}")
    assert dr.status_code == 204


async def test_reports_template_invalid_type(api_client):
    r = await api_client.post(
        "/api/v1/reports/templates",
        json={
            "name": "bad",
            "report_type": "nonexistent_type",
            "delivery_email": "x@x.com",
        },
    )
    assert r.status_code == 422


async def test_reports_download_alert_summary_csv(api_client):
    r = await api_client.get("/api/v1/reports/download/alert_summary?fmt=csv")
    assert r.status_code == 200
    assert "text/csv" in r.headers.get("content-type", "")
    assert "attachment" in r.headers.get("content-disposition", "")


async def test_reports_download_json(api_client):
    r = await api_client.get("/api/v1/reports/download/sla_summary?fmt=json")
    assert r.status_code == 200
    assert "json" in r.headers.get("content-type", "")


async def test_reports_download_invalid_type(api_client):
    r = await api_client.get("/api/v1/reports/download/nonexistent")
    assert r.status_code == 422


async def test_reports_schedules_list(api_client):
    r = await api_client.get("/api/v1/reports/schedules")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_reports_deliveries_list(api_client):
    r = await api_client.get("/api/v1/reports/deliveries")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ===========================================================================
# helpdesk  — /api/v1/helpdesk
# ===========================================================================

async def test_helpdesk_categories_list(api_client):
    r = await api_client.get("/api/v1/helpdesk/categories")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_helpdesk_category_create(api_client):
    r = await api_client.post(
        "/api/v1/helpdesk/categories",
        json={
            "name": f"Cat-{uuid.uuid4().hex[:6]}",
            "description": "Test category",
            "response_secs": 3600,
            "resolve_secs": 86400,
        },
    )
    assert r.status_code == 201
    assert "category_id" in r.json()


async def test_helpdesk_ticket_create_and_list(api_client):
    title = f"Test ticket {uuid.uuid4().hex[:6]}"
    cr = await api_client.post(
        "/api/v1/helpdesk/tickets",
        json={"title": title, "description": "Test body", "priority": "high"},
    )
    assert cr.status_code == 201
    ticket_id = cr.json()["ticket_id"]
    assert cr.json()["status"] == "open"

    lr = await api_client.get("/api/v1/helpdesk/tickets")
    assert lr.status_code == 200
    ids = [t["ticket_id"] for t in lr.json()]
    assert ticket_id in ids


async def test_helpdesk_ticket_get(api_client):
    cr = await api_client.post(
        "/api/v1/helpdesk/tickets",
        json={"title": f"Get-{uuid.uuid4().hex[:6]}", "priority": "low"},
    )
    assert cr.status_code == 201
    ticket_id = cr.json()["ticket_id"]

    gr = await api_client.get(f"/api/v1/helpdesk/tickets/{ticket_id}")
    assert gr.status_code == 200
    assert gr.json()["ticket_id"] == ticket_id


async def test_helpdesk_ticket_update_status(api_client):
    cr = await api_client.post(
        "/api/v1/helpdesk/tickets",
        json={"title": f"Upd-{uuid.uuid4().hex[:6]}", "priority": "medium"},
    )
    assert cr.status_code == 201
    ticket_id = cr.json()["ticket_id"]

    ur = await api_client.patch(
        f"/api/v1/helpdesk/tickets/{ticket_id}",
        json={"status": "in_progress"},
    )
    assert ur.status_code == 200
    assert ur.json()["updated"] is True


async def test_helpdesk_ticket_invalid_priority(api_client):
    r = await api_client.post(
        "/api/v1/helpdesk/tickets",
        json={"title": "Bad priority", "priority": "urgent"},
    )
    assert r.status_code == 422


async def test_helpdesk_ticket_filter_by_status(api_client):
    r = await api_client.get("/api/v1/helpdesk/tickets?ticket_status=open")
    assert r.status_code == 200
    for t in r.json():
        assert t["status"] == "open"


async def test_helpdesk_comment_add_and_list(api_client):
    cr = await api_client.post(
        "/api/v1/helpdesk/tickets",
        json={"title": f"Cmt-{uuid.uuid4().hex[:6]}", "priority": "low"},
    )
    assert cr.status_code == 201
    ticket_id = cr.json()["ticket_id"]

    cmr = await api_client.post(
        f"/api/v1/helpdesk/tickets/{ticket_id}/comments",
        json={"body": "Public comment", "is_internal": False},
    )
    assert cmr.status_code == 201
    assert "comment_id" in cmr.json()

    lr = await api_client.get(f"/api/v1/helpdesk/tickets/{ticket_id}/comments")
    assert lr.status_code == 200
    assert len(lr.json()) >= 1
    assert lr.json()[0]["body"] == "Public comment"


async def test_helpdesk_ticket_404(api_client):
    r = await api_client.get("/api/v1/helpdesk/tickets/htkt:nonexistent-id")
    assert r.status_code == 404


# ===========================================================================
# onboarding — /api/v1/onboarding
# ===========================================================================

async def test_onboarding_self_managed_bad_slug(api_client):
    r = await api_client.post(
        "/api/v1/onboarding/self-managed",
        json={
            "organization_name": "Bad Slug Co",
            "organization_slug": "Bad Slug!",
            "tenant_name": "Bad Slug Workspace",
        },
    )
    assert r.status_code == 422


async def test_onboarding_self_managed_missing_name(api_client):
    r = await api_client.post(
        "/api/v1/onboarding/self-managed",
        json={
            "organization_name": "",
            "organization_slug": "valid-slug",
            "tenant_name": "My Workspace",
        },
    )
    assert r.status_code == 422


async def test_onboarding_self_managed_creates_org(api_client):
    slug = f"selfmgd-{uuid.uuid4().hex[:8]}"
    r = await api_client.post(
        "/api/v1/onboarding/self-managed",
        json={
            "organization_name": "Self Managed Corp",
            "organization_slug": slug,
            "tenant_name": "SMC Workspace",
        },
    )
    assert r.status_code == 201
    data = r.json()
    assert data["org_kind"] == "client"
    assert data["role"] == "tenant_admin"
    assert "organization_id" in data
    assert "tenant_id" in data


async def test_onboarding_self_managed_slug_collision(api_client):
    slug = f"collision-{uuid.uuid4().hex[:8]}"
    r1 = await api_client.post(
        "/api/v1/onboarding/self-managed",
        json={
            "organization_name": "First Corp",
            "organization_slug": slug,
            "tenant_name": "First Workspace",
        },
    )
    assert r1.status_code == 201

    r2 = await api_client.post(
        "/api/v1/onboarding/self-managed",
        json={
            "organization_name": "Second Corp",
            "organization_slug": slug,
            "tenant_name": "Second Workspace",
        },
    )
    assert r2.status_code == 409
