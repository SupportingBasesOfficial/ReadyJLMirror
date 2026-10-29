"""LGPD deletion request processor — anonymizes personal data for pending requests.

Picks up rows from g1.lgpd_deletion_requests with status='pending',
anonymizes the principal in g1.principals, removes tenant memberships,
and marks the request completed.

Keycloak account deactivation is attempted via admin API (best-effort;
logged as warning on failure without blocking DB anonymization).
"""

from __future__ import annotations

import logging
import os
import urllib.parse
import urllib.request
import json

import psycopg

logger = logging.getLogger("workers.lgpd_processor")

_BATCH = 5
_KC_ADMIN_URL = os.environ.get("KEYCLOAK_INTERNAL_URL", "http://keycloak:8080")
_KC_REALM     = os.environ.get("KEYCLOAK_REALM", "jlmirror")
_KC_ADMIN     = os.environ.get("KEYCLOAK_ADMIN", "admin")
_KC_PASS      = os.environ.get("KEYCLOAK_ADMIN_PASSWORD", "")


def _kc_admin_token() -> str | None:
    if not _KC_PASS:
        return None
    try:
        data = urllib.parse.urlencode({
            "grant_type": "password",
            "client_id": "admin-cli",
            "username": _KC_ADMIN,
            "password": _KC_PASS,
        }).encode()
        req = urllib.request.Request(
            f"{_KC_ADMIN_URL}/realms/master/protocol/openid-connect/token",
            data=data,
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read())["access_token"]
    except Exception:
        logger.warning("lgpd: could not get Keycloak admin token")
        return None


def _kc_disable_user(principal_id: str, token: str) -> None:
    try:
        payload = json.dumps({"enabled": False}).encode()
        req = urllib.request.Request(
            f"{_KC_ADMIN_URL}/admin/realms/{_KC_REALM}/users/{principal_id}",
            data=payload,
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json",
            },
            method="PUT",
        )
        with urllib.request.urlopen(req, timeout=10):
            pass
        logger.info("lgpd: KC user %s disabled", principal_id[:12])
    except Exception:
        logger.warning(
            "lgpd: could not disable KC user %s (manual action needed)",
            principal_id[:12])


def _process_request(conn: psycopg.Connection,
                     request_id: str, principal_id: str,
                     kc_token: str | None) -> None:
    # Mark as processing (idempotent guard)
    cur = conn.execute(
        """
        UPDATE g1.lgpd_deletion_requests
           SET status = 'processing'
         WHERE request_id = %s AND status = 'pending'
        """,
        (request_id,),
    )
    if cur.rowcount != 1:
        conn.rollback()
        return
    conn.commit()

    try:
        # 1. Anonymize principal
        conn.execute(
            """
            UPDATE g1.principals
               SET display_name = 'Usuário Removido',
                   email        = 'removed-' || LEFT(principal_id, 8) || '@jlmirror.invalid',
                   active       = false
             WHERE principal_id = %s
            """,
            (principal_id,),
        )

        # 2. Remove all tenant memberships
        conn.execute(
            "DELETE FROM g1.tenant_memberships WHERE principal_id = %s",
            (principal_id,),
        )

        # 3. Mark completed
        conn.execute(
            "UPDATE g1.lgpd_deletion_requests SET status='completed' WHERE request_id=%s",
            (request_id,),
        )
        conn.commit()
        logger.info("lgpd: request %s completed for principal %s",
                    request_id, principal_id[:12])

        # 4. Disable Keycloak account (best-effort, after DB commit)
        if kc_token:
            _kc_disable_user(principal_id, kc_token)
        else:
            logger.warning(
                "lgpd: Keycloak disable skipped for %s — "
                "KEYCLOAK_ADMIN_PASSWORD not set, disable account manually",
                principal_id[:12])

    except Exception:
        conn.rollback()
        conn.execute(
            "UPDATE g1.lgpd_deletion_requests SET status='rejected' WHERE request_id=%s",
            (request_id,),
        )
        conn.commit()
        logger.exception("lgpd: failed to process request %s", request_id)


def _process_pending(conn: psycopg.Connection) -> int:
    cur = conn.execute(
        """
        SELECT request_id, principal_id
          FROM g1.lgpd_deletion_requests
         WHERE status = 'pending'
         LIMIT %s
        """,
        (_BATCH,),
    )
    rows = cur.fetchall()
    conn.rollback()

    if not rows:
        return 0

    kc_token = _kc_admin_token()
    for (request_id, principal_id) in rows:
        _process_request(conn, request_id, principal_id, kc_token)

    return len(rows)
