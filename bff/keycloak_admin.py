"""Keycloak Admin REST API client for user management."""
from __future__ import annotations

import asyncio
import time
from typing import Optional

import httpx

from shared.config import settings

_lock = asyncio.Lock()
_cached_token: Optional[str] = None
_token_expiry: float = 0.0
_TIMEOUT = httpx.Timeout(10.0)


async def _admin_token() -> str:
    global _cached_token, _token_expiry
    async with _lock:
        if _cached_token and time.monotonic() < _token_expiry:
            return _cached_token
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            r = await client.post(
                f"{settings.keycloak_internal_url}/realms/master"
                "/protocol/openid-connect/token",
                data={
                    "client_id": "admin-cli",
                    "username": settings.keycloak_admin_user,
                    "password": settings.keycloak_admin_password,
                    "grant_type": "password",
                },
            )
            r.raise_for_status()
            data = r.json()
            _cached_token = data["access_token"]
            _token_expiry = time.monotonic() + data.get("expires_in", 60) - 30
            return _cached_token


def _realm_url(path: str) -> str:
    return (
        f"{settings.keycloak_internal_url}/admin/realms"
        f"/{settings.keycloak_realm}{path}"
    )


async def create_user(
    email: str, first_name: str, last_name: str, temp_password: str
) -> str:
    """Create a Keycloak user. Returns the new user's UUID (sub)."""
    token = await _admin_token()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.post(
            _realm_url("/users"),
            json={
                "username": email,
                "email": email,
                "firstName": first_name,
                "lastName": last_name,
                "enabled": True,
                "emailVerified": True,
                "credentials": [
                    {"type": "password", "value": temp_password, "temporary": True}
                ],
            },
            headers={"Authorization": f"Bearer {token}"},
        )
        if r.status_code == 409:
            raise ValueError("email_exists")
        r.raise_for_status()
        location = r.headers.get("location", "")
        return location.rstrip("/").rsplit("/", 1)[-1]


async def get_users_by_ids(user_ids: list[str]) -> dict[str, dict]:
    """Fetch Keycloak user representations by their IDs. Returns {id: user}.

    Fetches all users in parallel via asyncio.gather.
    """
    if not user_ids:
        return {}
    token = await _admin_token()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        async def _fetch(uid: str) -> tuple[str, dict | None]:
            r = await client.get(
                _realm_url(f"/users/{uid}"),
                headers={"Authorization": f"Bearer {token}"},
            )
            if r.status_code == 200:
                return uid, r.json()
            return uid, None

        pairs = await asyncio.gather(*[_fetch(uid) for uid in user_ids])
    return {uid: data for uid, data in pairs if data is not None}


async def set_user_enabled(user_id: str, enabled: bool) -> None:
    token = await _admin_token()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.put(
            _realm_url(f"/users/{user_id}"),
            json={"enabled": enabled},
            headers={"Authorization": f"Bearer {token}"},
        )
        r.raise_for_status()


async def delete_user(user_id: str) -> None:
    token = await _admin_token()
    async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
        r = await client.delete(
            _realm_url(f"/users/{user_id}"),
            headers={"Authorization": f"Bearer {token}"},
        )
        if r.status_code == 404:
            return
        r.raise_for_status()
