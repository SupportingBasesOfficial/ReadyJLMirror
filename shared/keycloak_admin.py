"""Keycloak Admin API client for user provisioning.

Used only by the platform-admin surface to create/disable users.
All calls authenticate with the admin service account; tokens are
short-lived and not cached (dev volumes are small, not high-throughput).
"""

from __future__ import annotations

import secrets
import string

import httpx

from shared.config import settings

_REALM_BASE = (
    f"{settings.keycloak_internal_url}/admin/realms/{settings.keycloak_realm}"
)


async def _admin_token() -> str:
    """Exchange admin credentials for a short-lived admin access token."""
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{settings.keycloak_internal_url}/realms/master/protocol/openid-connect/token",
            data={
                "grant_type": "password",
                "client_id": "admin-cli",
                "username": settings.keycloak_admin_user,
                "password": settings.keycloak_admin_password,
            },
        )
        resp.raise_for_status()
        return resp.json()["access_token"]


def generate_temp_password(length: int = 16) -> str:
    alphabet = string.ascii_letters + string.digits + "!@#$%"
    while True:
        pw = "".join(secrets.choice(alphabet) for _ in range(length))
        if (any(c.isupper() for c in pw)
                and any(c.islower() for c in pw)
                and any(c.isdigit() for c in pw)
                and any(c in "!@#$%" for c in pw)):
            return pw


async def create_user(
    email: str,
    first_name: str,
    last_name: str,
    temp_password: str,
) -> str:
    """Create a Keycloak user and set a temporary password.

    Returns the Keycloak user_id (UUID) which becomes the principal_id.
    Raises httpx.HTTPStatusError on failure.
    """
    token = await _admin_token()
    headers = {"Authorization": f"Bearer {token}"}

    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.post(
            f"{_REALM_BASE}/users",
            headers=headers,
            json={
                "username": email,
                "email": email,
                "firstName": first_name,
                "lastName": last_name,
                "enabled": True,
                "emailVerified": True,
                "requiredActions": ["UPDATE_PASSWORD"],
            },
        )
        if resp.status_code == 409:
            raise ValueError(f"User with email {email!r} already exists in Keycloak")
        resp.raise_for_status()

        # Keycloak returns 201 with Location: .../users/{id}
        location = resp.headers.get("Location", "")
        user_id = location.rstrip("/").split("/")[-1]
        if not user_id:
            raise RuntimeError("Keycloak did not return a user location header")

        # Set the temporary password (user must change on first login)
        pw_resp = await client.put(
            f"{_REALM_BASE}/users/{user_id}/reset-password",
            headers=headers,
            json={"type": "password", "value": temp_password, "temporary": True},
        )
        pw_resp.raise_for_status()

    return user_id


async def set_user_enabled(user_id: str, enabled: bool) -> None:
    """Enable or disable a Keycloak user account."""
    token = await _admin_token()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.put(
            f"{_REALM_BASE}/users/{user_id}",
            headers={"Authorization": f"Bearer {token}"},
            json={"enabled": enabled},
        )
        resp.raise_for_status()


async def reset_password(user_id: str, new_password: str, temporary: bool = True) -> None:
    """Reset a Keycloak user's password."""
    token = await _admin_token()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.put(
            f"{_REALM_BASE}/users/{user_id}/reset-password",
            headers={"Authorization": f"Bearer {token}"},
            json={"type": "password", "value": new_password, "temporary": temporary},
        )
        resp.raise_for_status()


async def search_users(search: str, max_results: int = 20) -> list[dict]:
    """Search Keycloak users by email or name fragment."""
    token = await _admin_token()
    async with httpx.AsyncClient(timeout=10) as client:
        resp = await client.get(
            f"{_REALM_BASE}/users",
            headers={"Authorization": f"Bearer {token}"},
            params={"search": search, "max": max_results},
        )
        resp.raise_for_status()
        return [
            {
                "user_id": u["id"],
                "email": u.get("email", ""),
                "first_name": u.get("firstName", ""),
                "last_name": u.get("lastName", ""),
                "enabled": u.get("enabled", True),
            }
            for u in resp.json()
        ]
