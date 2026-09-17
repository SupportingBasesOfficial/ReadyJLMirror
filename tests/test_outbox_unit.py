"""Durable outbox dispatcher unit tests — claim/publish/quarantine.

Covers the dispatch state machine on a fake psycopg connection:
  - pending -> claimed -> published (dev-log receipt without webhook)
  - publish failure -> released for retry
  - exhausted attempts -> quarantined
"""

from __future__ import annotations

import os
from datetime import datetime, timezone

import workers.outbox_dispatcher as disp


class _FakeCursor:
    def __init__(self, rows=()):
        self._rows = list(rows)
        self.rowcount = 1

    def fetchall(self):
        return self._rows

    def fetchone(self):
        return self._rows[0] if self._rows else None


class _FakeConn:
    """Minimal psycopg.Connection stand-in recording UPDATEs and serving
    the pending-claim SELECT."""

    def __init__(self, pending_rows):
        self._pending = list(pending_rows)
        self.updates: list[tuple[str, tuple]] = []
        self.commits = 0

    def execute(self, sql, params=()):
        if "SELECT" in sql and "FROM monitoring.monitoring_outbox" in sql:
            return _FakeCursor(self._pending)
        if "UPDATE monitoring.monitoring_outbox" in sql:
            self.updates.append((sql, params))
            return _FakeCursor()
        return _FakeCursor()

    def commit(self):
        self.commits += 1


def _row(record_id=1, attempts=0):
    return (
        record_id, "tenant:dev", f"msg-{record_id}",
        "monitoring.problem.state-change", "1",
        "monitoring_problem", "prob-1", b"{}", attempts,
    )


def _final_state(conn, record_id=1):
    """Extract the terminal dispatch_state written for a record."""
    for sql, params in conn.updates:
        if "SET dispatch_state" in sql and "published_receipt_id" in sql:
            return "published"
        if "'quarantined'" in sql:
            return "quarantined"
        if "'pending'" in sql and "claim_owner = NULL" in sql:
            return "pending"
    return None


def test_pending_published_dev_log(monkeypatch):
    monkeypatch.delenv("ALERTING_WEBHOOK_URL", raising=False)
    conn = _FakeConn([_row()])
    n = disp._publish_durable(conn)
    assert n == 1
    assert _final_state(conn) == "published"
    # receipt id recorded
    assert any("dev-log:msg-1" in str(p) for _s, p in conn.updates)


def test_publish_failure_releases_for_retry(monkeypatch):
    monkeypatch.setenv("ALERTING_WEBHOOK_URL", "https://alerts.example.com/hook")
    monkeypatch.setattr(
        disp.httpx, "post",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    conn = _FakeConn([_row(attempts=0)])
    n = disp._publish_durable(conn)
    assert n == 0
    assert _final_state(conn) == "pending"
    assert any("'publication_failed'" in s for s, _p in conn.updates)


def test_exhausted_attempts_quarantined(monkeypatch):
    monkeypatch.setenv("ALERTING_WEBHOOK_URL", "https://alerts.example.com/hook")
    monkeypatch.setattr(
        disp.httpx, "post",
        lambda *a, **k: (_ for _ in ()).throw(RuntimeError("boom")),
    )
    conn = _FakeConn([_row(attempts=4)])  # 5th attempt -> quarantine
    n = disp._publish_durable(conn)
    assert n == 0
    assert _final_state(conn) == "quarantined"
    assert any("'publication_exhausted'" in s for s, _p in conn.updates)


def test_empty_outbox_noop(monkeypatch):
    monkeypatch.delenv("ALERTING_WEBHOOK_URL", raising=False)
    conn = _FakeConn([])
    assert disp._publish_durable(conn) == 0
    assert conn.updates == []
