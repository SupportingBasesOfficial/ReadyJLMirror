"""Cross-tenant HTTP isolation tests (Sprint 3).

Pattern for every test:
  1. client_a (tenant:dev) creates a resource via POST.
  2. client_b (tenant:iso-b — a different tenant) attempts to access that
     resource by its ID.
  3. Assert 404: the SQL predicate includes both the resource ID and the
     calling tenant's ID, so the row is invisible to a foreign tenant.

Covers: billing invoices, helpdesk tickets, report templates.
Alerting list-scope isolation is verified without needing injected alert rows.

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

# Tenant A — the seed tenant present in every dev DB.
_CTX_A = {
    "principal_id": "principal.e2e-dev-admin",
    "session_digest": "test-digest-a",
    "session_generation": "gen-test-a",
    "tenant_id": "tenant:dev",
    "role": "admin",
    "correlation_id": None,
}

# Tenant B — a different tenant ID.  It has no rows in g1.tenants but the
# SQL predicates (`WHERE tenant_id=%s AND <resource_id>=%s`) enforce isolation
# at query time, so B simply receives 404 for A's resources.
_CTX_B = {
    "principal_id": "principal.e2e-dev-admin",
    "session_digest": "test-digest-b",
    "session_generation": "gen-test-b",
    "tenant_id": "tenant:iso-crosstest-b",
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
async def client_a(pool):
    import api.main

    with patch("api.main._verify_bff_context", return_value=_CTX_A), \
         patch("api.main._session_current", new=AsyncMock(return_value=True)):
        async with AsyncClient(
            transport=ASGITransport(app=api.main.app),
            base_url="http://test",
        ) as client:
            yield client


@pytest_asyncio.fixture(scope="module")
async def client_b(pool):
    import api.main

    with patch("api.main._verify_bff_context", return_value=_CTX_B), \
         patch("api.main._session_current", new=AsyncMock(return_value=True)):
        async with AsyncClient(
            transport=ASGITransport(app=api.main.app),
            base_url="http://test",
        ) as client:
            yield client


# ===========================================================================
# Billing — invoice IDOR
# ===========================================================================

async def test_billing_invoice_idor_404(client_a, client_b):
    """Tenant B cannot access tenant A's invoice by ID."""
    cr = await client_a.post(
        "/api/v1/billing/invoices",
        json={
            "period_start": "2026-01-01T00:00:00Z",
            "period_end": "2026-01-31T23:59:59Z",
            "amount_cents": 10000,
            "currency": "BRL",
        },
    )
    assert cr.status_code == 201, cr.text
    invoice_id = cr.json()["invoice_id"]

    gr = await client_b.get(f"/api/v1/billing/invoices/{invoice_id}")
    assert gr.status_code == 404, (
        f"Expected 404 — tenant B should not see tenant A's invoice; got {gr.status_code}"
    )


async def test_billing_invoices_list_no_cross_tenant_data(client_a, client_b):
    """Tenant B's invoice list must not contain invoices belonging to tenant A."""
    cr = await client_a.post(
        "/api/v1/billing/invoices",
        json={
            "period_start": "2026-02-01T00:00:00Z",
            "period_end": "2026-02-28T23:59:59Z",
            "amount_cents": 5000,
            "currency": "USD",
        },
    )
    assert cr.status_code == 201, cr.text
    invoice_id = cr.json()["invoice_id"]

    lr = await client_b.get("/api/v1/billing/invoices")
    assert lr.status_code == 200, lr.text
    ids_b = [row["invoice_id"] for row in lr.json()]
    assert invoice_id not in ids_b, (
        "Tenant A's invoice_id leaked into tenant B's invoice list"
    )


# ===========================================================================
# Helpdesk — ticket IDOR
# ===========================================================================

async def test_helpdesk_ticket_idor_404(client_a, client_b):
    """Tenant B cannot GET a ticket that belongs to tenant A."""
    cr = await client_a.post(
        "/api/v1/helpdesk/tickets",
        json={
            "title": f"Cross-tenant ticket {uuid.uuid4().hex[:6]}",
            "priority": "high",
        },
    )
    assert cr.status_code == 201, cr.text
    ticket_id = cr.json()["ticket_id"]

    gr = await client_b.get(f"/api/v1/helpdesk/tickets/{ticket_id}")
    assert gr.status_code == 404, (
        f"Expected 404 — tenant B should not see tenant A's ticket; got {gr.status_code}"
    )


async def test_helpdesk_ticket_list_no_cross_tenant_data(client_a, client_b):
    """Tenant B's ticket list must not include any ticket created by tenant A."""
    cr = await client_a.post(
        "/api/v1/helpdesk/tickets",
        json={
            "title": f"Sentinel ticket {uuid.uuid4().hex[:6]}",
            "priority": "low",
        },
    )
    assert cr.status_code == 201, cr.text
    ticket_id = cr.json()["ticket_id"]

    lr = await client_b.get("/api/v1/helpdesk/tickets")
    assert lr.status_code == 200, lr.text
    ids_b = [t["ticket_id"] for t in lr.json()]
    assert ticket_id not in ids_b, (
        "Tenant A's ticket leaked into tenant B's ticket list"
    )


async def test_helpdesk_comment_idor_404(client_a, client_b):
    """Tenant B cannot list comments on tenant A's ticket."""
    cr = await client_a.post(
        "/api/v1/helpdesk/tickets",
        json={"title": f"Comment-idor-{uuid.uuid4().hex[:6]}", "priority": "medium"},
    )
    assert cr.status_code == 201, cr.text
    ticket_id = cr.json()["ticket_id"]

    cmr = await client_b.get(f"/api/v1/helpdesk/tickets/{ticket_id}/comments")
    assert cmr.status_code == 404, (
        f"Expected 404 when tenant B lists comments on tenant A's ticket; got {cmr.status_code}"
    )


# ===========================================================================
# Reports — template IDOR
# ===========================================================================

async def test_reports_template_cross_tenant_delete_denied(client_a, client_b):
    """Tenant B cannot delete a report template owned by tenant A.

    _require_operator checks permissions via the DB.  Since tenant:iso-crosstest-b
    has no rows in g1.tenant_memberships, the principal has no permissions there
    and the endpoint returns 403 before reaching the SQL isolation check.
    Either way (403 or 404), the template must remain intact for tenant A.
    """
    cr = await client_a.post(
        "/api/v1/reports/templates",
        json={
            "name": f"idor-rpt-{uuid.uuid4().hex[:6]}",
            "report_type": "alert_summary",
            "delivery_email": "test@example.com",
        },
    )
    assert cr.status_code == 201, cr.text
    template_id = cr.json()["template_id"]

    dr = await client_b.delete(f"/api/v1/reports/templates/{template_id}")
    # 403: no permissions in the foreign tenant (permission check fires first)
    # 404: would happen if the tenant existed but had no matching template
    assert dr.status_code in (403, 404), (
        f"Expected 403 or 404 when tenant B deletes tenant A's template; got {dr.status_code}"
    )

    # Core isolation property: template must still exist for tenant A.
    lr = await client_a.get("/api/v1/reports/templates")
    assert lr.status_code == 200, lr.text
    assert any(t["template_id"] == template_id for t in lr.json()), (
        "Template was silently deleted — isolation breach"
    )


# ===========================================================================
# Alerting — list scope (no cross-tenant data in returned rows)
# ===========================================================================

async def test_alerting_list_scoped_to_calling_tenant(client_a, client_b):
    """GET /alerts for tenant B returns a list that contains no tenant A alerts.

    Since we cannot create alerts via the HTTP API, this test verifies that
    the list endpoint is scoped to the calling tenant's context (returns 200
    with a list, never an error), and that tenant B's list does not include
    any alert IDs from tenant A's list.
    """
    list_a = await client_a.get("/api/v1/alerts?limit=50")
    assert list_a.status_code == 200, list_a.text
    assert isinstance(list_a.json(), list)
    ids_a = {row["alert_id"] for row in list_a.json()}

    list_b = await client_b.get("/api/v1/alerts?limit=50")
    assert list_b.status_code == 200, list_b.text
    assert isinstance(list_b.json(), list)
    ids_b = {row["alert_id"] for row in list_b.json()}

    leaked = ids_a & ids_b
    assert not leaked, (
        f"Alert IDs from tenant A leaked into tenant B's list: {leaked}"
    )


# ===========================================================================
# Alerting — alert detail IDOR
# ===========================================================================

async def test_alert_detail_idor_404(client_a, client_b):
    """Tenant B cannot GET an alert owned by tenant A.

    Uses the first alert already present in tenant:dev (created by the
    alerting worker from monitoring data).  If no alerts exist the test
    is skipped — it cannot inject them because the alerting.alert table
    has FK / check constraints that require a fully consistent policy row.
    """
    list_a = await client_a.get("/api/v1/alerts?limit=1")
    assert list_a.status_code == 200, list_a.text
    alerts_a = list_a.json()
    if not alerts_a:
        pytest.skip(
            "No alerts in tenant:dev — run the alerting worker first to generate test data"
        )
    alert_id = alerts_a[0]["alert_id"]

    gr = await client_b.get(f"/api/v1/alerts/{alert_id}")
    assert gr.status_code == 404, (
        f"Expected 404 — tenant B should not see tenant A's alert; got {gr.status_code}"
    )


# ===========================================================================
# Alerting — policy list isolation
# ===========================================================================

async def test_alert_policy_list_no_cross_tenant_data(client_a, client_b):
    """GET /policies for tenant B must not include policies created by tenant A."""
    policy_id = f"policy:iso-test-{uuid.uuid4().hex[:8]}"
    cr = await client_a.post(
        "/api/v1/policies",
        json={
            "policy_id": policy_id,
            "source_kind": "monitoring_problem",
            "problem_min_severity": "warning",
            "health_classes": [],
            "make_effective": False,
        },
    )
    assert cr.status_code == 201, cr.text

    list_b = await client_b.get("/api/v1/policies")
    assert list_b.status_code == 200, list_b.text
    ids_b = {row["policy_id"] for row in list_b.json()}
    assert policy_id not in ids_b, (
        "Tenant A's policy_id leaked into tenant B's policy list"
    )


# ===========================================================================
# Notifications — notification_intent detail IDOR
# ===========================================================================

async def test_notification_intent_idor_404(client_a, client_b):
    """Tenant B cannot GET a notification intent owned by tenant A.

    notification_intent rows require a live alert FK so they can't be
    created via API; we verify that the endpoint filters by tenant_id by
    confirming that a valid-looking intent ID from tenant A's list (or a
    synthetic UUID) returns 404 for tenant B.
    """
    list_a = await client_a.get("/api/v1/notifications?limit=1")
    assert list_a.status_code == 200, list_a.text
    intents_a = list_a.json()

    if intents_a:
        intent_id = intents_a[0]["notification_intent_id"]
    else:
        # No real intents — use a synthetic UUID to verify the endpoint
        # returns 404 (not 500 or 200) for a foreign-tenant request.
        intent_id = f"notif:{uuid.uuid4()}"

    gr = await client_b.get(f"/api/v1/notifications/{intent_id}")
    assert gr.status_code == 404, (
        f"Expected 404 — tenant B should not see tenant A's intent; got {gr.status_code}"
    )


# ===========================================================================
# Notifications — notification channel delete IDOR
# ===========================================================================

async def test_notification_channel_delete_idor_404(client_a, client_b):
    """Tenant B cannot delete a notification channel owned by tenant A."""
    cr = await client_a.post(
        "/api/v1/notification-channels",
        json={
            "channel_class": "email_smtp@1",
            "destination_ref": f"idor-test-{uuid.uuid4().hex[:6]}@example.com",
            "label": f"IDOR test channel {uuid.uuid4().hex[:6]}",
        },
    )
    assert cr.status_code == 201, cr.text
    dest_id = cr.json()["destination_config_id"]

    dr = await client_b.delete(f"/api/v1/notification-channels/{dest_id}")
    assert dr.status_code == 404, (
        f"Expected 404 — tenant B should not delete tenant A's channel; got {dr.status_code}"
    )

    # Verify channel still exists for tenant A.
    list_a = await client_a.get("/api/v1/notification-channels")
    assert list_a.status_code == 200, list_a.text
    dest_ids_a = [row["destination_config_id"] for row in list_a.json()]
    assert dest_id in dest_ids_a, (
        "Notification channel was silently deleted — isolation breach"
    )


# ===========================================================================
# Automation — credential delete IDOR
# ===========================================================================

async def test_automation_credential_delete_idor_404(client_a, client_b):
    """Tenant B cannot delete an automation credential owned by tenant A."""
    fake_pem = (
        "-----BEGIN RSA PRIVATE KEY-----\n"
        "MIIEowIBAAKCAQEA0Z3VS5JJcds3xHn/ygWep4s/AAAAtest==\n"
        "-----END RSA PRIVATE KEY-----"
    )
    cr = await client_a.post(
        "/api/v1/automation/credentials",
        json={
            "label": f"idor-cred-{uuid.uuid4().hex[:6]}",
            "username": "testuser",
            "key_pem": fake_pem,
        },
    )
    assert cr.status_code == 201, cr.text
    credential_id = cr.json()["credential_id"]

    dr = await client_b.delete(f"/api/v1/automation/credentials/{credential_id}")
    assert dr.status_code == 404, (
        f"Expected 404 — tenant B should not delete tenant A's credential; got {dr.status_code}"
    )

    # Verify credential still exists for tenant A.
    list_a = await client_a.get("/api/v1/automation/credentials")
    assert list_a.status_code == 200, list_a.text
    cred_ids_a = [row["credential_id"] for row in list_a.json()]
    assert credential_id in cred_ids_a, (
        "Automation credential was silently deleted — isolation breach"
    )
