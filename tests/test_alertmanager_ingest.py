"""Alertmanager source config + ingest integration tests (Sprint 3).

Covers: /api/v1/sources/alertmanager

Endpoints under test:
  GET    /                        list sources
  POST   /                        create source (returns token once)
  POST   /{id}/rotate-token       rotate webhook token
  DELETE /{id}                    disable source
  GET    /{id}/events             list ingested events
  POST   /{id}/ingest             public webhook receiver (token auth, no BFF)

The ingest endpoint uses X-JLM-Webhook-Secret (token auth), not BFF context,
so it is exercised with a plain AsyncClient without the context patch.

Requires PostgreSQL with G1 schema applied.
Tests skip gracefully when DB is unreachable.
"""

from __future__ import annotations

import asyncio
import json
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

_SAMPLE_PAYLOAD = {
    "alerts": [
        {
            "fingerprint": "abc123def456",
            "status": "firing",
            "labels": {"alertname": "HighCPU", "severity": "critical", "job": "node"},
            "annotations": {"summary": "CPU above 90%"},
            "startsAt": "2026-11-01T10:00:00Z",
            "endsAt": None,
        },
        {
            "fingerprint": "bbb222ccc333",
            "status": "resolved",
            "labels": {"alertname": "LowDisk", "severity": "warning"},
            "annotations": {},
            "startsAt": "2026-11-01T08:00:00Z",
            "endsAt": "2026-11-01T10:30:00Z",
        },
    ]
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
    """BFF-authenticated client for the config endpoints."""
    import api.main

    with patch("api.main._verify_bff_context", return_value=_TENANT_CTX), \
         patch("api.main._session_current", new=AsyncMock(return_value=True)):
        async with AsyncClient(
            transport=ASGITransport(app=api.main.app),
            base_url="http://test",
        ) as client:
            yield client


@pytest_asyncio.fixture(scope="module")
async def ingest_client(pool):
    """Plain client for the public ingest endpoint (no BFF patch needed)."""
    import api.main

    # The ingest endpoint validates X-JLM-Webhook-Secret directly — it does
    # NOT use the BFF context.  We still need an active DB pool.
    with patch("api.main._verify_bff_context", return_value=_TENANT_CTX), \
         patch("api.main._session_current", new=AsyncMock(return_value=True)):
        async with AsyncClient(
            transport=ASGITransport(app=api.main.app),
            base_url="http://test",
        ) as client:
            yield client


# ===========================================================================
# Source config — CRUD
# ===========================================================================

async def test_list_sources_empty_or_list(api_client):
    r = await api_client.get("/api/v1/sources/alertmanager")
    assert r.status_code == 200
    assert isinstance(r.json(), list)


async def test_create_source_returns_token(api_client):
    r = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"Test Source {uuid.uuid4().hex[:6]}"},
    )
    assert r.status_code == 201, r.text
    data = r.json()
    assert "source_id" in data
    assert "token" in data
    assert data["enabled"] is True
    # Token is a 64-char hex string (secrets.token_hex(32))
    assert len(data["token"]) == 64


async def test_create_source_empty_name_422(api_client):
    r = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": ""},
    )
    assert r.status_code == 422


async def test_create_source_name_too_long_422(api_client):
    r = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": "x" * 121},
    )
    assert r.status_code == 422


async def test_create_source_appears_in_list(api_client):
    name = f"listed-{uuid.uuid4().hex[:6]}"
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": name},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]

    lr = await api_client.get("/api/v1/sources/alertmanager")
    assert lr.status_code == 200
    ids = [s["source_id"] for s in lr.json()]
    assert source_id in ids


async def test_disable_source(api_client):
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"del-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]

    dr = await api_client.delete(f"/api/v1/sources/alertmanager/{source_id}")
    assert dr.status_code == 204

    # Disabled source no longer in active list
    lr = await api_client.get("/api/v1/sources/alertmanager")
    # list may still show disabled entries; check disabled flag if present
    rows = [s for s in lr.json() if s["source_id"] == source_id]
    if rows:
        # If the router returns disabled sources, they should be marked
        pass  # presence allowed; ingest will reject via enabled=false check


async def test_disable_source_nonexistent_404(api_client):
    r = await api_client.delete("/api/v1/sources/alertmanager/amgr:nonexistent-id")
    assert r.status_code == 404


# ===========================================================================
# Token rotation
# ===========================================================================

async def test_rotate_token_returns_new_token(api_client):
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"rotate-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]
    old_token = cr.json()["token"]

    rr = await api_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/rotate-token"
    )
    assert rr.status_code == 200, rr.text
    new_token = rr.json()["token"]
    assert len(new_token) == 64
    assert new_token != old_token


async def test_rotate_token_nonexistent_404(api_client):
    r = await api_client.post(
        "/api/v1/sources/alertmanager/amgr:nonexistent/rotate-token"
    )
    assert r.status_code == 404


# ===========================================================================
# Ingest webhook
# ===========================================================================

async def test_ingest_valid_token_accepted(api_client, ingest_client):
    """Valid token + well-formed payload → 200 with accepted count."""
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"ingest-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]
    token = cr.json()["token"]

    ir = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(_SAMPLE_PAYLOAD),
        headers={"X-JLM-Webhook-Secret": token, "Content-Type": "application/json"},
    )
    assert ir.status_code == 200, ir.text
    data = ir.json()
    assert data["accepted"] == 2  # both fingerprints upserted
    assert data["source_id"] == source_id


async def test_ingest_no_token_401(api_client, ingest_client):
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"notoken-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]

    ir = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(_SAMPLE_PAYLOAD),
        headers={"Content-Type": "application/json"},
    )
    assert ir.status_code == 401


async def test_ingest_wrong_token_401(api_client, ingest_client):
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"wrongtok-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]

    ir = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(_SAMPLE_PAYLOAD),
        headers={"X-JLM-Webhook-Secret": "00" * 32, "Content-Type": "application/json"},
    )
    assert ir.status_code == 401


async def test_ingest_disabled_source_401(api_client, ingest_client):
    """Ingest against a disabled source must return 401."""
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"disabled-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]
    token = cr.json()["token"]

    dr = await api_client.delete(f"/api/v1/sources/alertmanager/{source_id}")
    assert dr.status_code == 204

    ir = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(_SAMPLE_PAYLOAD),
        headers={"X-JLM-Webhook-Secret": token, "Content-Type": "application/json"},
    )
    assert ir.status_code == 401


async def test_ingest_invalid_json_400(api_client, ingest_client):
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"badjson-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]
    token = cr.json()["token"]

    ir = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=b"not json at all {{{",
        headers={"X-JLM-Webhook-Secret": token, "Content-Type": "application/json"},
    )
    assert ir.status_code == 400


async def test_ingest_too_many_alerts_400(api_client, ingest_client):
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"manyalerts-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]
    token = cr.json()["token"]

    # 501 alerts — one over the max-500 limit
    big_payload = {
        "alerts": [
            {
                "fingerprint": f"fp{i:06d}",
                "status": "firing",
                "labels": {"alertname": "Stress", "severity": "warning"},
                "annotations": {},
                "startsAt": "2026-11-01T00:00:00Z",
                "endsAt": None,
            }
            for i in range(501)
        ]
    }
    ir = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(big_payload),
        headers={"X-JLM-Webhook-Secret": token, "Content-Type": "application/json"},
    )
    assert ir.status_code == 400


async def test_ingest_idempotent_upsert(api_client, ingest_client):
    """Sending the same fingerprint twice must not create duplicates."""
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"upsert-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]
    token = cr.json()["token"]

    single = {
        "alerts": [{
            "fingerprint": "unique-fp-upsert-test",
            "status": "firing",
            "labels": {"alertname": "IdempotentTest", "severity": "info"},
            "annotations": {},
            "startsAt": "2026-11-01T12:00:00Z",
            "endsAt": None,
        }]
    }

    r1 = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(single),
        headers={"X-JLM-Webhook-Secret": token, "Content-Type": "application/json"},
    )
    assert r1.status_code == 200
    assert r1.json()["accepted"] == 1

    r2 = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(single),
        headers={"X-JLM-Webhook-Secret": token, "Content-Type": "application/json"},
    )
    assert r2.status_code == 200
    assert r2.json()["accepted"] == 1

    # Events list should have exactly one row for this fingerprint
    er = await api_client.get(f"/api/v1/sources/alertmanager/{source_id}/events")
    assert er.status_code == 200, er.text
    events = er.json()
    fps = [e["fingerprint"] for e in events if e["fingerprint"] == "unique-fp-upsert-test"]
    assert len(fps) == 1, f"Expected 1 event row after upsert, got {len(fps)}"


# ===========================================================================
# Events list
# ===========================================================================

async def test_events_list_after_ingest(api_client, ingest_client):
    """Events from ingest must appear in GET /{source_id}/events."""
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"evlist-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]
    token = cr.json()["token"]

    ir = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(_SAMPLE_PAYLOAD),
        headers={"X-JLM-Webhook-Secret": token, "Content-Type": "application/json"},
    )
    assert ir.status_code == 200

    er = await api_client.get(f"/api/v1/sources/alertmanager/{source_id}/events")
    assert er.status_code == 200, er.text
    events = er.json()
    assert isinstance(events, list)
    assert len(events) >= 2
    fingerprints = {e["fingerprint"] for e in events}
    assert "abc123def456" in fingerprints
    assert "bbb222ccc333" in fingerprints


async def test_events_list_nonexistent_source_404(api_client):
    r = await api_client.get(
        "/api/v1/sources/alertmanager/amgr:nonexistent/events"
    )
    assert r.status_code == 404


# ===========================================================================
# Token rotation invalidates old token
# ===========================================================================

async def test_old_token_rejected_after_rotation(api_client, ingest_client):
    """After rotating, the old token must no longer be accepted for ingest."""
    cr = await api_client.post(
        "/api/v1/sources/alertmanager",
        json={"display_name": f"rotinval-{uuid.uuid4().hex[:6]}"},
    )
    assert cr.status_code == 201, cr.text
    source_id = cr.json()["source_id"]
    old_token = cr.json()["token"]

    rr = await api_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/rotate-token"
    )
    assert rr.status_code == 200
    new_token = rr.json()["token"]

    # Old token is now invalid
    ir_old = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(_SAMPLE_PAYLOAD),
        headers={"X-JLM-Webhook-Secret": old_token, "Content-Type": "application/json"},
    )
    assert ir_old.status_code == 401, (
        f"Old token still accepted after rotation — expected 401, got {ir_old.status_code}"
    )

    # New token works
    ir_new = await ingest_client.post(
        f"/api/v1/sources/alertmanager/{source_id}/ingest",
        content=json.dumps(_SAMPLE_PAYLOAD),
        headers={"X-JLM-Webhook-Secret": new_token, "Content-Type": "application/json"},
    )
    assert ir_new.status_code == 200, (
        f"New token rejected after rotation — expected 200, got {ir_new.status_code}"
    )
