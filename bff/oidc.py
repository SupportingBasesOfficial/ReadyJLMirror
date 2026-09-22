"""OIDC client — Authorization Code + PKCE S256 against Keycloak.

Implements the accepted IR-D-001 protocol shape:
  - Authorization Code Flow + PKCE S256
  - Confidential client (BFF) — code exchange happens server-side only
  - Browser never receives refresh/access tokens — only the opaque
    server-side session handle
  - ID token validated against realm JWKS (iss, aud, exp, nonce)

The `sub`/`sid` claims are stored as *external references*
(`idp_subject_ref`, `idp_session_ref`) — never as platform identities.
"""

from __future__ import annotations

import base64
import hashlib
import logging
import secrets
import time
from dataclasses import dataclass
from typing import Optional

import httpx
import jwt
from jwt import PyJWKClient

from shared.config import settings

logger = logging.getLogger(__name__)

_jwks_client: Optional[PyJWKClient] = None
_discovery: Optional[dict] = None


def _pkce_challenge(verifier: str) -> str:
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def new_pkce_pair() -> tuple[str, str]:
    """Return (code_verifier, code_challenge) for PKCE S256."""
    verifier = secrets.token_urlsafe(64)
    return verifier, _pkce_challenge(verifier)


def new_state() -> str:
    return secrets.token_urlsafe(32)


def new_nonce() -> str:
    return secrets.token_urlsafe(32)


async def discover() -> dict:
    """Fetch and cache the OIDC discovery document."""
    global _discovery
    if _discovery is not None:
        return _discovery
    url = (
        f"{settings.keycloak_internal_url}/realms/{settings.keycloak_realm}"
        "/.well-known/openid-configuration"
    )
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.get(url)
        resp.raise_for_status()
        _discovery = resp.json()
    return _discovery


def reset_discovery() -> None:
    """Drop cached discovery/JWKS (for tests and key rotation)."""
    global _discovery, _jwks_client
    _discovery = None
    _jwks_client = None


def authorization_endpoint() -> str:
    """Browser-facing authorization endpoint (public Keycloak URL)."""
    return (
        f"{settings.keycloak_public_url}/realms/{settings.keycloak_realm}"
        "/protocol/openid-connect/auth"
    )


def end_session_endpoint() -> str:
    """Browser-facing RP-initiated logout endpoint."""
    return (
        f"{settings.keycloak_public_url}/realms/{settings.keycloak_realm}"
        "/protocol/openid-connect/logout"
    )


def token_endpoint() -> str:
    """Server-side token endpoint (internal Keycloak URL).

    Built from the internal URL, never from the discovery document:
    Keycloak announces browser-facing endpoints that may be
    unreachable (or resolve elsewhere) inside the container network.
    """
    return (
        f"{settings.keycloak_internal_url}/realms/{settings.keycloak_realm}"
        "/protocol/openid-connect/token"
    )


def expected_issuer() -> str:
    """Issuer stamped on tokens — the realm's public (frontend) URL.

    Keycloak always uses the configured frontend URL for `iss`,
    regardless of which channel issued the token; the discovery
    document's `issuer` field is resolved per-request and cannot be
    trusted when fetched via the internal address.
    """
    return (
        f"{settings.keycloak_public_url}/realms/{settings.keycloak_realm}"
    )


def build_authorize_url(*, state: str, nonce: str, code_challenge: str) -> str:
    redirect_uri = f"{settings.bff_public_url}/auth/callback"
    params = {
        "client_id": settings.keycloak_client_id,
        "response_type": "code",
        "scope": "openid profile",
        "redirect_uri": redirect_uri,
        "state": state,
        "nonce": nonce,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    from urllib.parse import urlencode
    return f"{authorization_endpoint()}?{urlencode(params)}"


async def exchange_code(*, code: str, code_verifier: str) -> dict:
    """Exchange an authorization code for tokens (server-side only)."""
    redirect_uri = f"{settings.bff_public_url}/auth/callback"
    async with httpx.AsyncClient(timeout=10.0) as client:
        resp = await client.post(
            token_endpoint(),
            data={
                "grant_type": "authorization_code",
                "client_id": settings.keycloak_client_id,
                "client_secret": settings.keycloak_client_secret,
                "code": code,
                "redirect_uri": redirect_uri,
                "code_verifier": code_verifier,
            },
        )
    if resp.status_code != 200:
        raise ValueError(f"token exchange failed: {resp.status_code}")
    return resp.json()


def _jwks() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(
            f"{settings.keycloak_internal_url}/realms/{settings.keycloak_realm}"
            "/protocol/openid-connect/certs"
        )
    return _jwks_client


@dataclass(frozen=True)
class ValidatedIdentity:
    """Validated OIDC identity — external references only."""

    subject_ref: str          # external IdP `sub`
    issuer: str
    idp_session_ref: Optional[str]  # external `sid`
    authenticated_at_epoch: int     # `auth_time`


def validate_id_token(
    id_token: str, *, expected_nonce: str, expected_issuer: str
) -> ValidatedIdentity:
    """Validate an ID token: signature (JWKS), iss, aud, exp, nonce."""
    signing_key = _jwks().get_signing_key_from_jwt(id_token).key
    claims = jwt.decode(
        id_token,
        signing_key,
        algorithms=["RS256"],
        audience=settings.keycloak_client_id,
        issuer=expected_issuer,
        options={"require": ["exp", "iat", "iss", "aud", "sub", "nonce"]},
    )
    if claims.get("nonce") != expected_nonce:
        raise ValueError("ID token nonce mismatch")
    auth_time = claims.get("auth_time")
    if not isinstance(auth_time, int):
        auth_time = int(time.time())
    return ValidatedIdentity(
        subject_ref=claims["sub"],
        issuer=claims["iss"],
        idp_session_ref=claims.get("sid"),
        authenticated_at_epoch=auth_time,
    )
