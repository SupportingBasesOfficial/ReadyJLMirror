"""Unit tests for shared/itsm_adapter.py — no DB, no network."""

from __future__ import annotations

import json
import os
import urllib.error
from io import BytesIO
from unittest.mock import MagicMock, patch

import pytest

from shared import itsm_adapter


def _resp(body: dict, status: int = 200):
    """Fake urlopen context-manager return."""
    m = MagicMock()
    m.__enter__ = lambda s: s
    m.__exit__ = MagicMock(return_value=False)
    m.read.return_value = json.dumps(body).encode()
    return m


def _patch_urlopen(body: dict, status: int = 200):
    return patch("shared.itsm_adapter.urllib.request.urlopen",
                 return_value=_resp(body, status))


# ─── _extract_ref ────────────────────────────────────────────────────────────

class TestExtractRef:
    def test_ref_key(self):
        assert itsm_adapter._extract_ref({"ref": "INC-123"}) == "INC-123"

    def test_ticket_id(self):
        assert itsm_adapter._extract_ref({"ticket_id": "42"}) == "42"

    def test_sys_id(self):
        assert itsm_adapter._extract_ref({"sys_id": "sn-001"}) == "sn-001"

    def test_key(self):
        assert itsm_adapter._extract_ref({"key": "PROJ-7"}) == "PROJ-7"

    def test_id(self):
        assert itsm_adapter._extract_ref({"id": "999"}) == "999"

    def test_nested_result(self):
        assert itsm_adapter._extract_ref({"result": {"sys_id": "sn-nested"}}) == "sn-nested"

    def test_priority_order(self):
        # ref wins over ticket_id
        assert itsm_adapter._extract_ref({"ref": "R", "ticket_id": "T"}) == "R"

    def test_empty_string_skipped(self):
        assert itsm_adapter._extract_ref({"ref": "", "id": "42"}) == "42"

    def test_none_when_no_match(self):
        assert itsm_adapter._extract_ref({"other_key": "val"}) is None

    def test_double_nested_ignored(self):
        # only one level of nesting supported
        assert itsm_adapter._extract_ref({"result": {"nested": {"ref": "x"}}}) is None


# ─── open_ticket ─────────────────────────────────────────────────────────────

class TestOpenTicket:
    def test_returns_none_when_url_unset(self, monkeypatch):
        monkeypatch.delenv("ITSM_WEBHOOK_URL", raising=False)
        result = itsm_adapter.open_ticket("t1", "r1", "e1")
        assert result is None

    def test_returns_none_when_url_empty(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "")
        result = itsm_adapter.open_ticket("t1", "r1", "e1")
        assert result is None

    def test_successful_call_extracts_ref(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "http://itsm.test/webhook")
        monkeypatch.delenv("ITSM_WEBHOOK_TOKEN", raising=False)
        with _patch_urlopen({"ref": "INC-42"}):
            result = itsm_adapter.open_ticket("t1", "r1", "e1")
        assert result == "INC-42"

    def test_bearer_token_added(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "http://itsm.test/webhook")
        monkeypatch.setenv("ITSM_WEBHOOK_TOKEN", "secret-token")
        captured = {}

        def fake_urlopen(req, timeout):
            captured["auth"] = req.get_header("Authorization")
            return _resp({"ref": "INC-1"})

        with patch("shared.itsm_adapter.urllib.request.urlopen", fake_urlopen):
            itsm_adapter.open_ticket("t1", "r1", "e1")

        assert captured["auth"] == "Bearer secret-token"

    def test_payload_structure(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "http://itsm.test/webhook")
        monkeypatch.delenv("ITSM_WEBHOOK_TOKEN", raising=False)
        captured = {}

        def fake_urlopen(req, timeout):
            captured["body"] = json.loads(req.data.decode())
            return _resp({"ref": "X"})

        with patch("shared.itsm_adapter.urllib.request.urlopen", fake_urlopen):
            itsm_adapter.open_ticket("tenant:t", "req-1", "evt-1",
                                     metadata={"severity": "high"})

        b = captured["body"]
        assert b["action"] == "open_ticket"
        assert b["tenant_id"] == "tenant:t"
        assert b["request_id"] == "req-1"
        assert b["event_id"] == "evt-1"
        assert b["metadata"] == {"severity": "high"}

    def test_http_error_raises(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "http://itsm.test/webhook")
        monkeypatch.delenv("ITSM_WEBHOOK_TOKEN", raising=False)
        err = urllib.error.HTTPError("http://x", 500, "Internal Error", {}, None)
        with patch("shared.itsm_adapter.urllib.request.urlopen", side_effect=err):
            with pytest.raises(RuntimeError, match="ITSM webhook HTTP 500"):
                itsm_adapter.open_ticket("t", "r", "e")

    def test_network_error_raises(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "http://itsm.test/webhook")
        monkeypatch.delenv("ITSM_WEBHOOK_TOKEN", raising=False)
        with patch("shared.itsm_adapter.urllib.request.urlopen",
                   side_effect=ConnectionError("timeout")):
            with pytest.raises(RuntimeError, match="ITSM webhook error"):
                itsm_adapter.open_ticket("t", "r", "e")

    def test_returns_none_when_no_ref_in_response(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "http://itsm.test/webhook")
        monkeypatch.delenv("ITSM_WEBHOOK_TOKEN", raising=False)
        with _patch_urlopen({"status": "ok", "message": "created"}):
            result = itsm_adapter.open_ticket("t", "r", "e")
        assert result is None

    def test_servicenow_nested_result(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "http://snow.test/webhook")
        monkeypatch.delenv("ITSM_WEBHOOK_TOKEN", raising=False)
        snow_response = {"result": {"sys_id": "sn-abc123", "number": "INC0001234"}}
        with _patch_urlopen(snow_response):
            result = itsm_adapter.open_ticket("t", "r", "e")
        # sys_id comes before number in _REF_KEYS... wait, actually number comes before sys_id
        # _REF_KEYS = ("ref", "ticket_id", "id", "number", "sys_id", "key", "issue_id")
        # In nested result: number=INC0001234 wins over sys_id=sn-abc123
        assert result == "INC0001234"

    def test_metadata_none_defaults_to_empty_dict(self, monkeypatch):
        monkeypatch.setenv("ITSM_WEBHOOK_URL", "http://itsm.test/webhook")
        monkeypatch.delenv("ITSM_WEBHOOK_TOKEN", raising=False)
        captured = {}

        def fake_urlopen(req, timeout):
            captured["body"] = json.loads(req.data.decode())
            return _resp({"ref": "X"})

        with patch("shared.itsm_adapter.urllib.request.urlopen", fake_urlopen):
            itsm_adapter.open_ticket("t", "r", "e", metadata=None)

        assert captured["body"]["metadata"] == {}
