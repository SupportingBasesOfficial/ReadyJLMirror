"""Platform-admin endpoint integration tests.

Tests three endpoints added/modified in api/routers/platform.py:
  POST /api/v1/platform/relationships/{id}/end
  GET  /api/v1/platform/users (Keycloak-enriched with tenant memberships)
  POST /api/v1/platform/service-provider-transfer

Requires PostgreSQL with G1 schema applied
(docker compose up -d db migrate).
Tests skip gracefully when the DB is unreachable.
"""

from __future__ import annotations

import asyncio
import os
import sys
from contextlib import ExitStack
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

os.environ.setdefault("APP_ENVIRONMENT", "development")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")

pytestmark = pytest.mark.integration

# dev-platform-admin context — same principal seeded in 005_seed_access_dev.sql
_ADMIN_CTX = {
    "principal_id": "dev-platform-admin",
    "session_digest": "test-session-digest",
    "session_generation": "gen-test",
    "tenant_id": None,
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
            conn.execute(
                "SELECT 1 FROM g1.organization_relationships LIMIT 1"
            )
    except Exception:
        pytest.skip("PostgreSQL with G1 schema is not reachable")
    return True


# ---------------------------------------------------------------------------
# API client with BFF auth bypassed at the middleware layer
# ---------------------------------------------------------------------------


@pytest.fixture(scope="module")
def api_client(db_available):
    """TestClient for api.main.app with platform-admin context injected.

    Patches _verify_bff_context (sync, returns fixed context) and
    _session_current (async, always returns True) so the middleware sets
    request.state.jlmirror_context without a real BFF session.
    The DB check inside _require_platform_admin still runs against the
    dev seed principal 'dev-platform-admin'.
    """
    import api.main

    with ExitStack() as stack:
        stack.enter_context(
            patch("api.main._verify_bff_context", return_value=_ADMIN_CTX)
        )
        stack.enter_context(
            patch(
                "api.main._session_current",
                new=AsyncMock(return_value=True),
            )
        )
        with TestClient(api.main.app) as client:
            yield client


# ---------------------------------------------------------------------------
# Synchronous DB connection for fixture setup / teardown
# ---------------------------------------------------------------------------


@pytest.fixture
def db_sync(db_available):
    import psycopg
    from shared.config import settings

    with psycopg.connect(settings.db_dsn) as conn:
        conn.autocommit = False
        yield conn


# ===========================================================================
# POST /api/v1/platform/relationships/{id}/end
# ===========================================================================


@pytest.fixture
def active_test_relationship(db_sync):
    """Create a test relationship (contracts_platform, platform→msp-alpha).

    Uses org:platform → org:msp-alpha with family 'contracts_platform' —
    no such active row exists in the dev seed, so the partial unique index
    (family, source, target) WHERE state='active' is satisfied.
    """
    rel_id = "rel:test-end-active"
    db_sync.execute(
        """
        INSERT INTO g1.organization_relationships
            (relationship_id, family,
             source_organization_id, target_organization_id)
        VALUES (%s, 'contracts_platform', 'org:platform', 'org:msp-alpha')
        ON CONFLICT (relationship_id)
        DO UPDATE SET state = 'active', effective_until = NULL
        """,
        (rel_id,),
    )
    db_sync.commit()
    yield rel_id
    db_sync.execute(
        "DELETE FROM g1.organization_relationships "
        "WHERE relationship_id = %s",
        (rel_id,),
    )
    db_sync.commit()


def test_end_relationship_happy_path(api_client, active_test_relationship):
    """Active relationship → state becomes 'ended'."""
    r = api_client.post(
        f"/api/v1/platform/relationships/{active_test_relationship}/end"
    )
    assert r.status_code == 200
    body = r.json()
    assert body["relationship_id"] == active_test_relationship
    assert body["state"] == "ended"


def test_end_relationship_not_found(api_client):
    """Non-existent relationship_id returns 404."""
    r = api_client.post(
        "/api/v1/platform/relationships/rel:does-not-exist-xxx/end"
    )
    assert r.status_code == 404


def test_end_relationship_already_ended(api_client, active_test_relationship):
    """Second end call on an already-ended relationship returns 404."""
    api_client.post(
        f"/api/v1/platform/relationships/{active_test_relationship}/end"
    )
    r = api_client.post(
        f"/api/v1/platform/relationships/{active_test_relationship}/end"
    )
    assert r.status_code == 404


# ===========================================================================
# GET /api/v1/platform/users (Keycloak-enriched with tenant memberships)
# ===========================================================================


def test_search_users_empty_keycloak(api_client):
    """When Keycloak returns no users the response is an empty list."""
    with patch(
        "shared.keycloak_admin.search_users",
        new=AsyncMock(return_value=[]),
    ):
        r = api_client.get("/api/v1/platform/users?q=nobody")
    assert r.status_code == 200
    assert r.json() == []


def test_search_users_no_db_match_returns_empty_tenants(api_client):
    """KC user with no matching principal in DB gets tenants=[]."""
    kc_user = {
        "user_id": "kc-user-no-db-match",
        "email": "nodbmatch@example.com",
        "first_name": "No",
        "last_name": "Match",
    }
    with patch(
        "shared.keycloak_admin.search_users",
        new=AsyncMock(return_value=[kc_user]),
    ):
        r = api_client.get("/api/v1/platform/users?q=nodbmatch")
    assert r.status_code == 200
    data = r.json()
    assert len(data) == 1
    assert data[0]["tenants"] == []


def test_search_users_with_membership(api_client, db_sync):
    """KC user matched via idp_subject_ref gets tenants populated."""
    idp_ref = "test-idp-ref-search-777"
    principal_id = "p-test-search-777"
    membership_id = "mem-test-search-777"

    db_sync.execute(
        """
        INSERT INTO g1.principals
            (principal_id, kind, credential_generation, idp_subject_ref)
        VALUES (%s, 'human_browser_session', 'cg-test-777', %s)
        ON CONFLICT DO NOTHING
        """,
        (principal_id, idp_ref),
    )
    db_sync.execute(
        """
        INSERT INTO g1.tenant_memberships
            (membership_id, tenant_id, principal_id, role)
        VALUES (%s, 'tenant:msp-alpha', %s, 'operator')
        ON CONFLICT (tenant_id, principal_id)
        DO UPDATE SET state = 'active', role = 'operator'
        """,
        (membership_id, principal_id),
    )
    db_sync.commit()

    kc_user = {
        "user_id": idp_ref,
        "email": "searchtest777@example.com",
        "first_name": "Search",
        "last_name": "Test777",
    }
    try:
        with patch(
            "shared.keycloak_admin.search_users",
            new=AsyncMock(return_value=[kc_user]),
        ):
            r = api_client.get("/api/v1/platform/users?q=search")
        assert r.status_code == 200
        data = r.json()
        assert len(data) == 1
        tenants = data[0]["tenants"]
        assert any(t["tenant_id"] == "tenant:msp-alpha" for t in tenants)
        assert any(t["role"] == "operator" for t in tenants)
    finally:
        db_sync.execute(
            "DELETE FROM g1.tenant_memberships WHERE membership_id = %s",
            (membership_id,),
        )
        db_sync.execute(
            "DELETE FROM g1.principals WHERE principal_id = %s",
            (principal_id,),
        )
        db_sync.commit()


# ===========================================================================
# POST /api/v1/platform/service-provider-transfer
# ===========================================================================


@pytest.fixture
def transfer_scenario(db_sync):
    """Isolated org/tenant/relationship/grant topology for transfer tests.

    org:xfer-client (target)  → tenant:xfer-client-home
    org:xfer-old-msp (from)   → active rel + active grant over client tenant
    org:xfer-new-msp (to)     → successor; no prior relationship
    """
    db_sync.execute(
        """
        INSERT INTO g1.organizations (organization_id, display_name)
        VALUES ('org:xfer-client',  'Xfer Client (test)'),
               ('org:xfer-old-msp', 'Old MSP (test)'),
               ('org:xfer-new-msp', 'New MSP (test)')
        ON CONFLICT DO NOTHING
        """,
    )
    db_sync.execute(
        """
        INSERT INTO g1.tenants
            (tenant_id, display_name, organization_id,
             isolation_class, cell_id)
        VALUES ('tenant:xfer-client-home', 'Xfer Client Tenant',
                'org:xfer-client', 'pooled', 'cell:dev-1')
        ON CONFLICT DO NOTHING
        """,
    )
    db_sync.execute(
        """
        INSERT INTO g1.principals
            (principal_id, kind, credential_generation)
        VALUES ('p-xfer-agent', 'platform_admin_principal', 'cg-xfer')
        ON CONFLICT DO NOTHING
        """,
    )
    db_sync.execute(
        """
        INSERT INTO g1.organization_relationships
            (relationship_id, family,
             source_organization_id, target_organization_id)
        VALUES ('rel:xfer-old-provides',
                'provides_monitoring_service_for',
                'org:xfer-old-msp', 'org:xfer-client')
        ON CONFLICT (relationship_id)
        DO UPDATE SET state = 'active', effective_until = NULL
        """,
    )
    db_sync.execute(
        """
        INSERT INTO g1.delegated_grants
            (grant_id, source_organization_id, target_tenant_id,
             principal_id, permissions, granted_by)
        VALUES ('grant:xfer-old-grant', 'org:xfer-old-msp',
                'tenant:xfer-client-home', 'p-xfer-agent',
                ARRAY['monitoring:read'], 'test-seed')
        ON CONFLICT (grant_id)
        DO UPDATE SET state = 'active', revoked_at = NULL
        """,
    )
    db_sync.commit()
    yield {
        "target": "org:xfer-client",
        "from_org": "org:xfer-old-msp",
        "to_org": "org:xfer-new-msp",
    }
    # Teardown — reverse dependency order (FKs: rels/grants → orgs/tenants)
    db_sync.execute(
        """
        DELETE FROM g1.delegated_grants
         WHERE source_organization_id IN
               ('org:xfer-old-msp', 'org:xfer-new-msp')
        """
    )
    db_sync.execute(
        """
        DELETE FROM g1.organization_relationships
         WHERE source_organization_id IN
               ('org:xfer-old-msp', 'org:xfer-new-msp')
            OR target_organization_id = 'org:xfer-client'
        """
    )
    db_sync.execute(
        "DELETE FROM g1.tenant_memberships "
        "WHERE tenant_id = 'tenant:xfer-client-home'"
    )
    db_sync.execute(
        "DELETE FROM g1.principals WHERE principal_id = 'p-xfer-agent'"
    )
    db_sync.execute(
        "DELETE FROM g1.tenants "
        "WHERE tenant_id = 'tenant:xfer-client-home'"
    )
    db_sync.execute(
        """
        DELETE FROM g1.organizations
         WHERE organization_id IN
               ('org:xfer-client', 'org:xfer-old-msp', 'org:xfer-new-msp')
        """
    )
    db_sync.commit()


def test_service_provider_transfer_happy_path(
    api_client, transfer_scenario, db_sync
):
    """Transfer fences old grants, ends old relationship, creates successor."""
    r = api_client.post(
        "/api/v1/platform/service-provider-transfer",
        json={
            "target_organization_id": transfer_scenario["target"],
            "from_organization_id": transfer_scenario["from_org"],
            "to_organization_id": transfer_scenario["to_org"],
        },
    )
    assert r.status_code == 200
    body = r.json()
    assert body["target_organization_id"] == transfer_scenario["target"]
    assert "grant:xfer-old-grant" in body["fenced_grants"]
    assert "rel:xfer-old-provides" in body["ended_relationships"]
    assert len(body["successor_relationships"]) >= 1

    # Verify DB state via the shared db_sync connection
    cur = db_sync.execute(
        "SELECT state FROM g1.delegated_grants "
        "WHERE grant_id = 'grant:xfer-old-grant'"
    )
    row = cur.fetchone()
    assert row is not None and row[0] == "revoked"

    cur = db_sync.execute(
        "SELECT state FROM g1.organization_relationships "
        "WHERE relationship_id = 'rel:xfer-old-provides'"
    )
    row = cur.fetchone()
    assert row is not None and row[0] == "ended"


def test_service_provider_transfer_target_no_tenants(api_client):
    """Target org with no tenants returns 404."""
    r = api_client.post(
        "/api/v1/platform/service-provider-transfer",
        json={
            "target_organization_id": "org:nonexistent-target-zzz",
            "from_organization_id": "org:xfer-old-msp",
            "to_organization_id": "org:xfer-new-msp",
        },
    )
    assert r.status_code == 404
