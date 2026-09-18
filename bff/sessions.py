"""PostgreSQL-backed browser session store.

Implements `SessionAuthorityPort` from `jlmirror_authority.session`
against `g1.browser_sessions`. Only handle digests are persisted —
the raw opaque handle exists only in the browser cookie.

Fail-closed: any DB error during resolve/rotate/retire denies.
"""

from __future__ import annotations

import hashlib
import logging
from datetime import datetime
from typing import Optional

from psycopg import AsyncConnection

from jlmirror_authority.model import Principal, PrincipalKind
from jlmirror_authority.session import BrowserSessionRecord

logger = logging.getLogger(__name__)


def digest_handle(raw_handle: str) -> str:
    """SHA-256 hex digest of an opaque session handle."""
    return hashlib.sha256(raw_handle.encode("utf-8")).hexdigest()


def digest_token(raw_token: str) -> str:
    """SHA-256 hex digest for CSRF tokens and OIDC state params."""
    return hashlib.sha256(raw_token.encode("utf-8")).hexdigest()


def _row_to_record(row: tuple) -> BrowserSessionRecord:
    (handle_digest, principal_id, kind, credential_generation,
     session_generation, authenticated_at, created_at, expires_at,
     retired) = row
    principal = Principal(
        principal_id=principal_id,
        kind=PrincipalKind(kind),
        credential_generation=credential_generation,
        active=True,
    )
    return BrowserSessionRecord(
        handle_digest=handle_digest,
        principal=principal,
        session_generation=session_generation,
        created_at=created_at,
        expires_at=expires_at,
        retired=retired,
    )


class PgSessionStore:
    """Durable session authority backed by g1.browser_sessions."""

    def __init__(self, conn: AsyncConnection) -> None:
        self._conn = conn

    async def create(self, record: BrowserSessionRecord, *,
                     idp_session_ref: Optional[str] = None,
                     csrf_digest: str,
                     authenticated_at: datetime) -> bool:
        await self._conn.execute(
            """
            INSERT INTO g1.browser_sessions
                (handle_digest, principal_id, session_generation,
                 credential_generation, idp_session_ref, csrf_digest,
                 authenticated_at, created_at, expires_at, retired)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (handle_digest) DO NOTHING
            """,
            (
                record.handle_digest,
                record.principal.principal_id,
                record.session_generation,
                record.principal.credential_generation,
                idp_session_ref,
                csrf_digest,
                authenticated_at,
                record.created_at,
                record.expires_at,
                record.retired,
            ),
        )
        return True

    async def resolve(self, handle_digest: str) -> Optional[BrowserSessionRecord]:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT s.handle_digest, s.principal_id, p.kind,
                       s.credential_generation, s.session_generation,
                       s.authenticated_at, s.created_at, s.expires_at, s.retired
                  FROM g1.browser_sessions s
                  JOIN g1.principals p USING (principal_id)
                 WHERE s.handle_digest = %s
                """,
                (handle_digest,),
            )
            row = await cur.fetchone()
        return _row_to_record(row) if row else None

    async def resolve_row(self, handle_digest: str) -> Optional[dict]:
        """Full session row including BFF-internal fields."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                SELECT handle_digest, principal_id, session_generation,
                       credential_generation, idp_session_ref, csrf_digest,
                       bound_tenant_id, authenticated_at, created_at,
                       expires_at, retired
                  FROM g1.browser_sessions
                 WHERE handle_digest = %s
                """,
                (handle_digest,),
            )
            row = await cur.fetchone()
        if row is None:
            return None
        keys = ("handle_digest", "principal_id", "session_generation",
                "credential_generation", "idp_session_ref", "csrf_digest",
                "bound_tenant_id", "authenticated_at", "created_at",
                "expires_at", "retired")
        return dict(zip(keys, row))

    async def rotate(
        self,
        *,
        predecessor_handle_digest: str,
        expected_predecessor_generation: str,
        successor: BrowserSessionRecord,
    ) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE g1.browser_sessions
                   SET retired = TRUE
                 WHERE handle_digest = %s
                   AND session_generation = %s
                   AND retired = FALSE
                """,
                (predecessor_handle_digest, expected_predecessor_generation),
            )
            if cur.rowcount != 1:
                return False
        return await self.create(
            successor, idp_session_ref=None, csrf_digest="", authenticated_at=successor.created_at
        )

    async def retire(self, *, handle_digest: str, expected_generation: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE g1.browser_sessions
                   SET retired = TRUE
                 WHERE handle_digest = %s
                   AND session_generation = %s
                   AND retired = FALSE
                """,
                (handle_digest, expected_generation),
            )
            return cur.rowcount == 1

    async def retire_by_idp_session(self, idp_session_ref: str) -> int:
        """Retire all sessions bound to an IdP session (back-channel logout)."""
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE g1.browser_sessions
                   SET retired = TRUE
                 WHERE idp_session_ref = %s AND retired = FALSE
                """,
                (idp_session_ref,),
            )
            return cur.rowcount

    async def bind_tenant(self, handle_digest: str, tenant_id: str,
                          session_generation: str) -> bool:
        async with self._conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE g1.browser_sessions
                   SET bound_tenant_id = %s
                 WHERE handle_digest = %s
                   AND session_generation = %s
                   AND retired = FALSE
                """,
                (tenant_id, handle_digest, session_generation),
            )
            return cur.rowcount == 1
