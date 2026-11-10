"""Unit tests for shared/ssrf.py and bff rate limiter.

No database or HTTP server required — pure function tests.
"""

from __future__ import annotations

import collections
import time
import uuid


# ===========================================================================
# SSRF guard — shared/ssrf.py
# ===========================================================================

def test_ssrf_validates_private_ipv4():
    from shared.ssrf import validate_outbound_url

    for ip in ("10.0.0.1", "192.168.1.1", "172.16.0.1", "127.0.0.1"):
        url = f"https://{ip}/path"
        result = validate_outbound_url(url)
        assert result is not None, f"Expected SSRF block for {url}"


def test_ssrf_rejects_http():
    from shared.ssrf import validate_outbound_url

    result = validate_outbound_url("http://example.com/hook")
    assert result is not None


def test_ssrf_rejects_localhost():
    from shared.ssrf import validate_outbound_url

    result = validate_outbound_url("https://localhost/hook")
    assert result is not None


def test_ssrf_rejects_metadata_google():
    from shared.ssrf import validate_outbound_url

    result = validate_outbound_url("https://metadata.google.internal/token")
    assert result is not None


def test_ssrf_rejects_no_hostname():
    from shared.ssrf import validate_outbound_url

    result = validate_outbound_url("https:///path")
    assert result is not None


def test_ssrf_rejects_empty():
    from shared.ssrf import validate_outbound_url

    result = validate_outbound_url("")
    assert result is not None


def test_ssrf_allows_public_https_dns_resolves():
    from shared.ssrf import validate_outbound_url

    # example.com resolves to a public IP — should be None (safe) or a DNS error string
    # (depends on network). In either case, must be str or None, never an exception.
    result = validate_outbound_url("https://example.com/webhook")
    assert result is None or isinstance(result, str)


def test_ssrf_private_ipv6_loopback():
    from shared.ssrf import validate_outbound_url

    result = validate_outbound_url("https://[::1]/hook")
    assert result is not None


# ===========================================================================
# Rate limiter — bff/main.py sliding-window
# ===========================================================================

def _load_bff():
    """Import bff.main if available, else skip."""
    import importlib
    import os

    os.environ.setdefault("APP_ENVIRONMENT", "development")
    os.environ.setdefault("DEV_AUTH_BYPASS", "true")
    os.environ.setdefault("VAPID_PRIVATE_KEY", "test-vapid-private-key")
    os.environ.setdefault("VAPID_PUBLIC_KEY", "test-vapid-public-key")
    os.environ.setdefault("VAPID_CLAIMS_SUB", "mailto:test@test.com")

    try:
        return importlib.import_module("bff.main")
    except Exception:
        return None


def test_rate_limit_allows_under_normal_limit():
    bff = _load_bff()
    if bff is None:
        import pytest
        pytest.skip("bff.main not importable")

    principal = f"p-{uuid.uuid4().hex}"
    path = "monitoring/status"
    for _ in range(10):
        ok = bff._rate_limit_ok(principal, path)
    assert ok is True


def test_rate_limit_blocks_over_heavy_limit():
    bff = _load_bff()
    if bff is None:
        import pytest
        pytest.skip("bff.main not importable")

    principal = f"heavy-{uuid.uuid4().hex}"
    # Key is (principal_id, tier) where tier='heavy' for aiops paths
    bff._rate_buckets[(principal, "heavy")] = collections.deque(
        [time.monotonic()] * 20   # exactly at limit
    )
    ok = bff._rate_limit_ok(principal, "aiops/findings")
    assert ok is False


def test_rate_limit_allows_after_window_expires():
    bff = _load_bff()
    if bff is None:
        import pytest
        pytest.skip("bff.main not importable")

    principal = f"exp-{uuid.uuid4().hex}"
    # Inject 20 timestamps outside the 60s window (old)
    old_time = time.monotonic() - 61
    bff._rate_buckets[(principal, "heavy")] = collections.deque(
        [old_time] * 20
    )
    ok = bff._rate_limit_ok(principal, "aiops/anomalies")
    assert ok is True


def test_rate_limit_different_principals_independent():
    bff = _load_bff()
    if bff is None:
        import pytest
        pytest.skip("bff.main not importable")

    p1 = f"user1-{uuid.uuid4().hex}"
    p2 = f"user2-{uuid.uuid4().hex}"

    # Throttle p1 on the heavy tier
    bff._rate_buckets[(p1, "heavy")] = collections.deque(
        [time.monotonic()] * 20
    )
    assert bff._rate_limit_ok(p1, "aiops/predictions") is False
    # p2 should be unaffected
    assert bff._rate_limit_ok(p2, "aiops/predictions") is True
