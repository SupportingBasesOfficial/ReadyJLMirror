"""G1 integration tests — full BFF flow against a real PostgreSQL.

Requires a running database with the G1 schema applied
(`docker compose up -d db migrate` or `python -m scripts.migrate`
against a local PostgreSQL). Tests skip gracefully when the DB is
unreachable.

Flow under test:
  dev-login -> session cookie -> /api/session (needs_tenant)
  -> /api/tenant/select (CSRF) -> ready -> cross-tenant denial
  -> logout -> session retired
"""

from __future__ import annotations

import os

import pytest
from fastapi.testclient import TestClient

os.environ.setdefault("APP_ENVIRONMENT", "development")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

from bff.main import app  # noqa: E402
from shared.config import settings  # noqa: E402



@pytest.fixture(scope="module")
def db_available():
    """Skip the whole module if PostgreSQL is unreachable."""
    import psycopg

    try:
        with psycopg.connect(settings.db_dsn, connect_timeout=3) as conn:
            conn.execute("SELECT 1 FROM g1.tenants LIMIT 1")
    except Exception:
        pytest.skip("PostgreSQL with G1 schema is not reachable")
    return True


@pytest.fixture(scope="module")
def client(db_available):
    # The BFF lifespan owns the pool — init/close inside TestClient's loop.
    with TestClient(app) as c:
        yield c


def _csrf(client: TestClient) -> dict:
    token = client.cookies.get("jl_csrf")
    assert token
    return {"X-CSRF-Token": token}


def test_dev_login_sets_session_and_needs_tenant(client):
    r = client.get("/auth/dev-login?subject=test-subject-1",
                   follow_redirects=False)
    assert r.status_code == 302
    assert client.cookies.get("jl_session")
    assert client.cookies.get("jl_csrf")

    s = client.get("/api/session").json()
    assert s["state"] == "needs_tenant"
    assert any(m["tenant_id"] == "tenant:dev" for m in s["memberships"])


def test_tenant_select_requires_csrf(client):
    client.get("/auth/dev-login?subject=test-subject-2")
    r = client.post("/api/tenant/select", json={"tenant_id": "tenant:dev"})
    assert r.status_code == 403


def test_tenant_select_happy_path(client):
    client.get("/auth/dev-login?subject=test-subject-3")
    r = client.post("/api/tenant/select",
                    json={"tenant_id": "tenant:dev"}, headers=_csrf(client))
    assert r.status_code == 200
    assert r.json()["state"] == "ready"

    s = client.get("/api/session").json()
    assert s["state"] == "ready"
    assert s["tenant"]["tenant_id"] == "tenant:dev"


def test_cross_tenant_denied_without_leakage(client):
    client.get("/auth/dev-login?subject=test-subject-4")
    r = client.post("/api/tenant/select",
                    json={"tenant_id": "tenant:other"},
                    headers=_csrf(client))
    assert r.status_code == 403
    # Same denial shape for nonexistent vs non-member — no leakage
    assert r.json() == {"state": "forbidden"}


def test_logout_retires_session(client):
    client.get("/auth/dev-login?subject=test-subject-5")
    client.post("/api/tenant/select",
                json={"tenant_id": "tenant:dev"}, headers=_csrf(client))

    r = client.post("/auth/logout", follow_redirects=False)
    assert r.status_code == 302

    # Cookies cleared server-side too: session must be retired
    s = client.get("/api/session").json()
    assert s["state"] == "unauthenticated"


def test_revoked_session_is_denied(client):
    """A retired session must fail closed even if the cookie remains."""
    client.get("/auth/dev-login?subject=test-subject-6")
    raw_cookie = client.cookies.get("jl_session")

    # Retire server-side (simulating back-channel logout / revocation)
    import asyncio
    from bff.sessions import PgSessionStore, digest_handle
    from shared.db import db_connection

    async def _retire():
        async with db_connection() as conn:
            store = PgSessionStore(conn)
            row = await store.resolve_row(digest_handle(raw_cookie))
            await store.retire(handle_digest=row["handle_digest"],
                               expected_generation=row["session_generation"])
            await conn.commit()

    asyncio.run(_retire())

    # Cookie still present but session is dead
    s = client.get("/api/session").json()
    assert s["state"] == "unauthenticated"


def test_protected_api_requires_signed_context(client):
    """Direct API call without BFF signature must be denied."""
    import api.main
    from fastapi.testclient import TestClient as ApiClient

    api_client = ApiClient(api.main.app)
    r = api_client.get("/api/v1/me")
    assert r.status_code == 401
