"""Development authority adapters.

These adapters implement the authority ports defined in
`jlmirror_authority` using in-memory state. They are suitable for
local development and testing only. Production deployments must
replace them with real adapters (Keycloak, PostgreSQL-backed sessions,
fence authority, etc.) per ADR-005.

All adapters are fail-closed: missing or stale evidence denies.
"""

from __future__ import annotations

from dataclasses import dataclass, field, replace
from datetime import datetime, timedelta, timezone
from typing import Dict, Optional

from jlmirror_authority.model import (
    AdmissionDenied,
    AuthenticationStrengthEvidence,
    Principal,
    PrincipalKind,
)
from jlmirror_authority.session import (
    BrowserSessionHandle,
    BrowserSessionRecord,
    SessionAuthorityPort,
    issue_browser_session,
    resolve_browser_session,
    rotate_browser_session,
    retire_browser_session,
)
from jlmirror_authority.fencing import (
    EFFECT_ELIGIBLE_FENCE_AUTHORITY_STATE,
    FenceAuthorityPort,
    FenceRecord,
    FenceToken,
    acquire_next_fence,
    admit_fenced_effect,
)


# ---------------------------------------------------------------------------
# In-memory session store (implements SessionAuthorityPort)
# ---------------------------------------------------------------------------


@dataclass
class DevSessionStore:
    """In-memory browser session store for development."""

    sessions: Dict[str, BrowserSessionRecord] = field(default_factory=dict)

    def create(self, record: BrowserSessionRecord) -> bool:
        if record.handle_digest in self.sessions:
            return False
        self.sessions[record.handle_digest] = record
        return True

    def resolve(self, handle_digest: str) -> Optional[BrowserSessionRecord]:
        return self.sessions.get(handle_digest)

    def rotate(
        self,
        *,
        predecessor_handle_digest: str,
        expected_predecessor_generation: str,
        successor: BrowserSessionRecord,
    ) -> bool:
        current = self.sessions.get(predecessor_handle_digest)
        if current is None or current.retired:
            return False
        if current.session_generation != expected_predecessor_generation:
            return False
        self.sessions.pop(predecessor_handle_digest, None)
        self.sessions[successor.handle_digest] = successor
        return True

    def retire(self, *, handle_digest: str, expected_generation: str) -> bool:
        current = self.sessions.get(handle_digest)
        if current is None or current.retired:
            return False
        if current.session_generation != expected_generation:
            return False
        self.sessions[handle_digest] = replace(current, retired=True)
        return True


# ---------------------------------------------------------------------------
# In-memory fence store (implements FenceAuthorityPort)
# ---------------------------------------------------------------------------


@dataclass
class DevFenceStore:
    """In-memory fence authority for development."""

    fences: Dict[str, FenceRecord] = field(default_factory=dict)

    def current(self, fence_scope_id: str) -> Optional[FenceRecord]:
        return self.fences.get(fence_scope_id)

    def acquire_successor(
        self,
        *,
        fence_scope_id: str,
        expected_predecessor_epoch: int,
        expected_predecessor_generation_id: str,
        successor_generation_id: str,
        successor_state: str,
    ) -> Optional[FenceRecord]:
        current = self.fences.get(fence_scope_id)
        if current is None or current.current_fence_epoch != expected_predecessor_epoch:
            return None
        if current.current_generation_id != expected_predecessor_generation_id:
            return None
        new_record = FenceRecord(
            fence_scope_id=fence_scope_id,
            current_fence_epoch=current.current_fence_epoch + 1,
            current_generation_id=successor_generation_id,
            authority_state=successor_state,
        )
        self.fences[fence_scope_id] = new_record
        return new_record

    def bootstrap(self, fence_scope_id: str, generation_id: str) -> FenceRecord:
        record = FenceRecord(
            fence_scope_id=fence_scope_id,
            current_fence_epoch=1,
            current_generation_id=generation_id,
            authority_state=EFFECT_ELIGIBLE_FENCE_AUTHORITY_STATE,
        )
        self.fences[fence_scope_id] = record
        return record


# ---------------------------------------------------------------------------
# Singleton instances (per-process, development only)
# ---------------------------------------------------------------------------

session_store = DevSessionStore()
fence_store = DevFenceStore()


def make_dev_principal(principal_id: str, credential_generation: str) -> Principal:
    """Create a development human browser session principal."""
    return Principal(
        principal_id=principal_id,
        kind=PrincipalKind.HUMAN_BROWSER_SESSION,
        credential_generation=credential_generation,
        active=True,
    )


def utcnow() -> datetime:
    """Current UTC time as timezone-aware datetime."""
    return datetime.now(timezone.utc)


def default_session_lifetime() -> timedelta:
    return timedelta(hours=8)
