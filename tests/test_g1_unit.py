"""G1 unit tests — pure logic, no database required.

Covers the security-relevant primitives: handle/token digests,
PKCE S256 challenge correctness, and the BFF->API HMAC context
signature verification.
"""

from __future__ import annotations

import hashlib
import hmac
import time

from bff.oidc import new_pkce_pair, new_state, new_nonce, _pkce_challenge
from bff.sessions import digest_handle, digest_token


def test_digest_handle_is_sha256_hex():
    raw = "test-handle-abc123"
    d = digest_handle(raw)
    assert d == hashlib.sha256(raw.encode()).hexdigest()
    assert len(d) == 64


def test_digest_token_differs_for_different_inputs():
    assert digest_token("a") != digest_token("b")


def test_pkce_challenge_is_s256():
    # RFC 7636 test vector
    verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    assert _pkce_challenge(verifier) == expected


def test_pkce_pair_verifier_challenge_consistent():
    verifier, challenge = new_pkce_pair()
    assert _pkce_challenge(verifier) == challenge
    assert len(verifier) >= 43  # RFC 7636 minimum


def test_state_and_nonce_are_unique():
    assert new_state() != new_state()
    assert new_nonce() != new_nonce()


def test_internal_context_signature_roundtrip():
    from shared.config import settings

    principal_id = "principal.abc"
    tenant_id = "tenant:dev"
    session_digest = "deadbeef" * 8
    ts = int(time.time())

    correlation_id = "corr_test123"
    payload = (f"{principal_id}|{tenant_id}|{session_digest}"
               f"|{ts}|{correlation_id}")
    expected = hmac.new(
        settings.bff_internal_secret.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()

    # Reproduce api.main._expected_signature logic
    from api.main import _expected_signature

    assert _expected_signature(
        principal_id, tenant_id, session_digest, str(ts),
        correlation_id) == expected


def test_internal_context_signature_rejects_tampering():
    from api.main import _expected_signature

    sig = _expected_signature("p1", "t1", "d1", "123")
    tampered = _expected_signature("p1", "t2", "d1", "123")
    assert sig != tampered
