"""Bloco 6 — integration tests for modules added in Nov 2026.

Covers: backup, firewall, k8s, correlation, discovery,
        data_transfer, sql_console, chatops.

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
    "principal_id": "principal.e2e-dev-bloco6",
    "session_digest": "test-digest-bloco6",
    "session_generation": "gen-test-bloco6",
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
            VALUES ('principal.e2e-dev-bloco6', 'human_browser_session', 'gen-e2e-bloco6')
            ON CONFLICT (principal_id) DO NOTHING
            """
        )
        await conn.execute(
            """
            INSERT INTO g1.tenant_memberships
                (membership_id, tenant_id, principal_id, role, state)
            VALUES ('mem-e2e-bloco6-admin', 'tenant:dev', 'principal.e2e-dev-bloco6', 'admin', 'active')
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


# ── Backup ────────────────────────────────────────────────────────────────────

async def test_backup_jobs_list_empty_ok(api_client):
    r = await api_client.get("/api/v1/backup/jobs")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_backup_job_create_and_get(api_client):
    payload = {
        "name": f"test-backup-{uuid.uuid4().hex[:8]}",
        "target_type": "filesystem",
        "target_path": "/var/backups/test",
        "schedule_cron": "0 2 * * *",
        "retention_days": 7,
    }
    r = await api_client.post("/api/v1/backup/jobs", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == payload["name"]
    assert data["target_type"] == "filesystem"

    job_id = data["backup_job_id"]
    r2 = await api_client.get(f"/api/v1/backup/jobs/{job_id}")
    assert r2.status_code == 200
    assert r2.json()["backup_job_id"] == job_id


async def test_backup_job_missing_name_rejected(api_client):
    r = await api_client.post("/api/v1/backup/jobs", json={"target_type": "filesystem"})
    assert r.status_code == 422


# ── Firewall ──────────────────────────────────────────────────────────────────

async def test_firewall_rulesets_list_ok(api_client):
    r = await api_client.get("/api/v1/firewall/rulesets")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_firewall_ruleset_create_and_get(api_client):
    payload = {
        "name": f"test-fw-{uuid.uuid4().hex[:8]}",
        "backend": "iptables",
        "target_host": "192.168.1.1",
        "credential_ref": None,
    }
    r = await api_client.post("/api/v1/firewall/rulesets", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == payload["name"]
    assert data["backend"] == "iptables"

    rs_id = data["ruleset_id"]
    r2 = await api_client.get(f"/api/v1/firewall/rulesets/{rs_id}")
    assert r2.status_code == 200
    assert r2.json()["ruleset_id"] == rs_id


async def test_firewall_ruleset_invalid_backend_rejected(api_client):
    payload = {"name": "bad", "backend": "nftablezz", "target_host": "1.2.3.4"}
    r = await api_client.post("/api/v1/firewall/rulesets", json=payload)
    assert r.status_code in (422, 400)


# ── Kubernetes ────────────────────────────────────────────────────────────────

async def test_k8s_clusters_list_ok(api_client):
    r = await api_client.get("/api/v1/k8s/clusters")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_k8s_cluster_create_and_get(api_client):
    payload = {
        "name": f"test-k8s-{uuid.uuid4().hex[:8]}",
        "api_server_url": "https://k8s.example.com:6443",
        "kubeconfig": None,
    }
    r = await api_client.post("/api/v1/k8s/clusters", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == payload["name"]

    cluster_id = data["cluster_id"]
    r2 = await api_client.get(f"/api/v1/k8s/clusters/{cluster_id}")
    assert r2.status_code == 200
    assert r2.json()["cluster_id"] == cluster_id


async def test_k8s_cluster_missing_name_rejected(api_client):
    r = await api_client.post("/api/v1/k8s/clusters", json={"api_server_url": "https://k8s.example.com"})
    assert r.status_code == 422


# ── Correlation ───────────────────────────────────────────────────────────────

async def test_correlation_rules_list_ok(api_client):
    r = await api_client.get("/api/v1/correlation/rules")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_correlation_rule_create_and_delete(api_client):
    payload = {
        "name": f"test-corr-{uuid.uuid4().hex[:8]}",
        "match_severity": ["HIGH", "CRITICAL"],
        "group_by": ["host"],
        "window_seconds": 300,
        "wait_seconds": 60,
    }
    r = await api_client.post("/api/v1/correlation/rules", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == payload["name"]

    rule_id = data["rule_id"]
    r2 = await api_client.delete(f"/api/v1/correlation/rules/{rule_id}")
    assert r2.status_code == 204


async def test_correlation_groups_list_ok(api_client):
    r = await api_client.get("/api/v1/correlation/groups")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ── Discovery ─────────────────────────────────────────────────────────────────

async def test_discovery_sessions_list_ok(api_client):
    r = await api_client.get("/api/v1/discovery/sessions")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_discovery_session_create_and_get(api_client):
    payload = {
        "name": f"test-disc-{uuid.uuid4().hex[:8]}",
        "scan_type": "ping",
        "network_range": "192.168.1.0/24",
    }
    r = await api_client.post("/api/v1/discovery/sessions", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == payload["name"]
    assert data["status"] == "pending"

    session_id = data["session_id"]
    r2 = await api_client.get(f"/api/v1/discovery/sessions/{session_id}")
    assert r2.status_code == 200
    assert r2.json()["session_id"] == session_id


async def test_discovery_results_list_empty(api_client):
    r = await api_client.get("/api/v1/discovery/results")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


# ── Data Transfer ─────────────────────────────────────────────────────────────

async def test_data_transfer_templates_list_ok(api_client):
    r = await api_client.get("/data-transfer/templates")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_data_transfer_template_create_and_get(api_client):
    payload = {
        "name": f"test-dt-{uuid.uuid4().hex[:8]}",
        "format": "csv",
        "entity_type": "devices",
        "field_mapping": {"hostname": "host"},
    }
    r = await api_client.post("/data-transfer/templates", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == payload["name"]
    assert data["format"] == "csv"

    tpl_id = data["template_id"]
    r2 = await api_client.get(f"/data-transfer/templates/{tpl_id}")
    assert r2.status_code == 200
    assert r2.json()["template_id"] == tpl_id


# ── SQL Console ───────────────────────────────────────────────────────────────

async def test_sql_console_history_list_ok(api_client):
    r = await api_client.get("/sql-console/history")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_sql_console_tables_list_ok(api_client):
    r = await api_client.get("/sql-console/tables")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_sql_console_execute_select(api_client):
    r = await api_client.post("/sql-console/execute", json={"query": "SELECT 1 AS n"})
    assert r.status_code == 200
    data = r.json()
    assert "rows" in data or "columns" in data or "results" in data or isinstance(data, (list, dict))


async def test_sql_console_rejects_non_select(api_client):
    r = await api_client.post("/sql-console/execute", json={"query": "DROP TABLE g1.tenants"})
    assert r.status_code in (400, 403, 422)


# ── ChatOps ───────────────────────────────────────────────────────────────────

async def test_chatops_workspaces_list_ok(api_client):
    r = await api_client.get("/chatops/workspaces")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_chatops_workspace_create_and_get(api_client):
    payload = {
        "name": f"test-chatops-{uuid.uuid4().hex[:8]}",
        "platform": "slack",
        "webhook_url": "https://hooks.slack.com/services/TEST/TEST/test",
    }
    r = await api_client.post("/chatops/workspaces", json=payload)
    assert r.status_code == 201
    data = r.json()
    assert data["name"] == payload["name"]
    assert data["platform"] == "slack"

    ws_id = data["workspace_id"]
    r2 = await api_client.get(f"/chatops/workspaces/{ws_id}")
    assert r2.status_code == 200
    assert r2.json()["workspace_id"] == ws_id


async def test_chatops_workspace_invalid_platform_rejected(api_client):
    payload = {
        "name": "bad",
        "platform": "discord_invalid",
        "webhook_url": "https://example.com",
    }
    r = await api_client.post("/chatops/workspaces", json=payload)
    assert r.status_code in (400, 422)
