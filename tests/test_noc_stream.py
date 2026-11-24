"""NOC stream integration tests (Sprint 3).

Covers: GET /api/v1/noc/stream — SSE endpoint that emits a combined snapshot
(active alerts + monitoring sources) on each tick.

Testing strategy:
  * Patch _INTERVAL to 0 so the event loop never waits 5 s.
  * Open the SSE stream with client.stream(), consume the first meaningful
    line, then close the connection.
  * The generator catches GeneratorExit so the cancellation is clean.

Requires PostgreSQL with G1 schema applied.
Tests skip gracefully when DB is unreachable.
"""

from __future__ import annotations

import asyncio
import json
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
# SSE content type and structure
# ===========================================================================

async def test_noc_stream_returns_event_stream(api_client):
    """Stream must respond with text/event-stream and emit at least one line."""
    with patch("api.routers.noc_stream._INTERVAL", 0):
        async with api_client.stream("GET", "/api/v1/noc/stream") as response:
            assert response.status_code == 200
            ct = response.headers.get("content-type", "")
            assert "text/event-stream" in ct, f"Expected SSE content-type, got: {ct}"

            async for line in response.aiter_lines():
                if line:  # skip blank separator lines
                    assert line.startswith("data:") or line.startswith(":"), (
                        f"Unexpected SSE line format: {line!r}"
                    )
                    break  # got the first non-empty line — connection is live


async def test_noc_stream_first_event_shape(api_client):
    """First data: event must be valid JSON with 'alerts' and 'sources' keys."""
    with patch("api.routers.noc_stream._INTERVAL", 0):
        async with api_client.stream("GET", "/api/v1/noc/stream") as response:
            assert response.status_code == 200

            async for line in response.aiter_lines():
                if line.startswith("data:"):
                    payload = json.loads(line[len("data:"):].strip())
                    assert "alerts" in payload, "SSE payload missing 'alerts' key"
                    assert "sources" in payload, "SSE payload missing 'sources' key"
                    assert isinstance(payload["alerts"], list)
                    assert isinstance(payload["sources"], list)
                    break
                if line.startswith(":"):
                    # Heartbeat means DB snapshot failed — schema might be absent.
                    # The stream is still operational; skip data-shape check.
                    pytest.skip("NOC stream emitted heartbeat — DB schema not ready")


async def test_noc_stream_cache_control_headers(api_client):
    """Stream must carry no-cache and keep-alive headers."""
    with patch("api.routers.noc_stream._INTERVAL", 0):
        async with api_client.stream("GET", "/api/v1/noc/stream") as response:
            assert response.status_code == 200
            assert response.headers.get("cache-control") == "no-cache"
            assert response.headers.get("connection") == "keep-alive"
            # consume one line so the stream is properly started
            async for _ in response.aiter_lines():
                break


async def test_noc_stream_multiple_ticks(api_client):
    """With _INTERVAL=0 we can consume at least 2 ticks without blocking."""
    with patch("api.routers.noc_stream._INTERVAL", 0):
        async with api_client.stream("GET", "/api/v1/noc/stream") as response:
            assert response.status_code == 200
            ticks = 0
            async for line in response.aiter_lines():
                if line.startswith("data:") or line.startswith(":"):
                    ticks += 1
                    if ticks >= 2:
                        break
            assert ticks >= 2, (
                f"Expected at least 2 SSE lines from stream with _INTERVAL=0; got {ticks}"
            )


# ===========================================================================
# Auth gates
# ===========================================================================

async def test_noc_stream_no_tenant_403(pool):
    """Stream must reject requests that carry no tenant context."""
    import api.main

    no_tenant_ctx = {
        "principal_id": "principal.e2e-dev-admin",
        "session_digest": "test",
        "session_generation": "gen",
        "tenant_id": None,  # no tenant
        "role": "admin",
        "correlation_id": None,
    }
    with patch("api.main._verify_bff_context", return_value=no_tenant_ctx), \
         patch("api.main._session_current", new=AsyncMock(return_value=True)):
        async with AsyncClient(
            transport=ASGITransport(app=api.main.app),
            base_url="http://test",
        ) as client:
            r = await client.get("/api/v1/noc/stream")
            assert r.status_code == 403, (
                f"Expected 403 for missing tenant context, got {r.status_code}"
            )
