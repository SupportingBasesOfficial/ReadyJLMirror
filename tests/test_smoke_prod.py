"""Smoke tests for a deployed ReadyJLMirror instance — G14 Production Release Gate.

All tests are skipped unless JLMIRROR_SMOKE_URL is set.
An optional JLMIRROR_SMOKE_TOKEN (Bearer token for API key auth) enables
the authenticated endpoint test.

Run:
    JLMIRROR_SMOKE_URL=https://prod.example.com pytest tests/test_smoke_prod.py -v
    JLMIRROR_SMOKE_URL=https://prod.example.com \\
        JLMIRROR_SMOKE_TOKEN=jlm_... pytest tests/test_smoke_prod.py -v
"""
from __future__ import annotations

import os

import httpx
import pytest

_SMOKE_URL: str = os.environ.get("JLMIRROR_SMOKE_URL", "").rstrip("/")
_SMOKE_TOKEN: str = os.environ.get("JLMIRROR_SMOKE_TOKEN", "")

# All tests in this module skip when the env var is absent.
pytestmark = pytest.mark.skipif(
    not _SMOKE_URL,
    reason="JLMIRROR_SMOKE_URL not set — smoke tests disabled",
)


def _client(*, token: str = "") -> httpx.Client:
    """Sync httpx client pointing at the smoke target."""
    headers: dict[str, str] = {}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return httpx.Client(
        base_url=_SMOKE_URL,
        headers=headers,
        timeout=15.0,
        # Allow self-signed certs in staging/prod behind internal CAs.
        verify=False,
        follow_redirects=False,
    )


# ---------------------------------------------------------------------------
# 1. Liveness
# ---------------------------------------------------------------------------

def test_health_returns_200() -> None:
    """GET /health must return 200 with no authentication required."""
    with _client() as c:
        r = c.get("/health")
    assert r.status_code == 200, f"Expected 200, got {r.status_code}: {r.text[:200]}"


# ---------------------------------------------------------------------------
# 2. Authentication enforcement
# ---------------------------------------------------------------------------

def test_api_requires_auth() -> None:
    """GET /api/v1/alerting/alerts without credentials must be rejected."""
    with _client() as c:
        r = c.get("/api/v1/alerting/alerts")
    assert r.status_code in (401, 403), (
        f"Expected 401 or 403 without auth, got {r.status_code}: {r.text[:200]}"
    )


@pytest.mark.skipif(not _SMOKE_TOKEN, reason="JLMIRROR_SMOKE_TOKEN not set")
def test_api_with_token_returns_200() -> None:
    """GET /api/v1/alerting/alerts with a valid Bearer token must return 200."""
    with _client(token=_SMOKE_TOKEN) as c:
        r = c.get("/api/v1/alerting/alerts")
    assert r.status_code == 200, (
        f"Expected 200 with token, got {r.status_code}: {r.text[:200]}"
    )


# ---------------------------------------------------------------------------
# 3. Security headers — CSP
# ---------------------------------------------------------------------------

def test_csp_header_present() -> None:
    """GET / (BFF SPA shell) must carry Content-Security-Policy with a nonce."""
    with _client() as c:
        r = c.get("/")
    # If the shell redirects to /auth/login, follow one hop.
    if r.status_code in (301, 302, 303, 307, 308):
        location = r.headers.get("location", "")
        if location:
            target = location if location.startswith("http") else _SMOKE_URL + "/" + location.lstrip("/")
            with _client() as c2:
                r = c2.get(target)
    csp = r.headers.get("content-security-policy", "")
    assert "nonce-" in csp, (
        f"Content-Security-Policy header missing or contains no nonce.\n"
        f"CSP: {csp!r}\n"
        f"Response headers: {dict(r.headers)}"
    )


# ---------------------------------------------------------------------------
# 4. Security headers — HSTS (HTTPS only)
# ---------------------------------------------------------------------------

def test_hsts_present() -> None:
    """HTTPS deployments must advertise Strict-Transport-Security."""
    if not _SMOKE_URL.startswith("https://"):
        pytest.skip("HSTS is only enforced over HTTPS; smoke URL is not https://")
    with _client() as c:
        r = c.get("/health")
    hsts = r.headers.get("strict-transport-security", "")
    assert hsts, (
        "Strict-Transport-Security header is absent on an HTTPS deployment.\n"
        f"Response headers: {dict(r.headers)}"
    )


# ---------------------------------------------------------------------------
# 5. CORS — preflight from untrusted origin must be blocked
# ---------------------------------------------------------------------------

def test_preflight_options_blocked() -> None:
    """CORS preflight from an attacker origin must not be reflected back."""
    bad_origin = "https://evil.attacker.example.com"
    preflight_headers = {
        "Origin": bad_origin,
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization",
    }
    with httpx.Client(base_url=_SMOKE_URL, timeout=10.0, verify=False) as c:
        r = c.options("/api/v1/alerting/alerts", headers=preflight_headers)
    acao = r.headers.get("access-control-allow-origin", "")
    assert acao != bad_origin, (
        f"Bad origin was reflected in Access-Control-Allow-Origin: {acao!r}\n"
        f"CORS wildcard or echo of arbitrary origins is forbidden."
    )


# ---------------------------------------------------------------------------
# 6. Worker heartbeat (via BFF /health/ready)
#    The BFF /health/ready endpoint checks its API backend dependency.
#    There is no dedicated /api/v1/worker-health endpoint; this is the
#    closest available signal accessible through the public BFF surface.
# ---------------------------------------------------------------------------

def test_worker_heartbeat_fresh() -> None:
    """BFF /health/ready must report the API backend as reachable."""
    with _client() as c:
        r = c.get("/health/ready")
    if r.status_code == 404:
        pytest.skip("/health/ready endpoint not found on this deployment")
    # 200 = ready or degraded; 503 = not_ready (hard DB failure).
    assert r.status_code == 200, (
        f"/health/ready returned {r.status_code} (503 = database down): {r.text[:200]}"
    )
    try:
        body = r.json()
    except Exception:
        pytest.skip("/health/ready did not return JSON; cannot inspect worker state")
    api_dep = body.get("dependencies", {}).get("api", {})
    assert api_dep.get("state") == "ok", (
        f"API dependency reported unhealthy in /health/ready: {api_dep}\n"
        f"Full body: {body}"
    )
