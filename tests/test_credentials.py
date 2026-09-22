"""Credential resolver tests — mounted secrets + env fallback chain."""

from __future__ import annotations

import pytest

from jlmirror_monitoring.validation_worker import CredentialResolutionError
from providers.credentials import (
    ChainedCredentialResolver,
    EnvCredentialResolver,
    FileSecretsResolver,
)


def test_file_resolver_reads_token(tmp_path):
    (tmp_path / "cred-binding-1.token").write_text("  sekrit-token\n")
    cred = FileSecretsResolver(tmp_path).resolve_zabbix_api_token(
        "cred-binding-1")
    assert cred.api_token == "sekrit-token"
    assert cred.credential_generation_ref == "cred-gen-file:cred-binding-1.token"


def test_file_resolver_rejects_traversal(tmp_path):
    with pytest.raises(CredentialResolutionError):
        FileSecretsResolver(tmp_path).resolve_zabbix_api_token(
            "../etc/passwd")


def test_file_resolver_missing_file(tmp_path):
    with pytest.raises(CredentialResolutionError):
        FileSecretsResolver(tmp_path).resolve_zabbix_api_token("nope")


def test_env_resolver_fallback(monkeypatch):
    monkeypatch.setenv("ZABBIX_CRED_CRED_BINDING_1", "env-token")
    cred = EnvCredentialResolver().resolve_zabbix_api_token(
        "cred-binding-1")
    assert cred.api_token == "env-token"


def test_chain_prefers_file_over_env(tmp_path, monkeypatch):
    (tmp_path / "b.token").write_text("file-token")
    monkeypatch.setenv("ZABBIX_CRED_B", "env-token")
    cred = ChainedCredentialResolver(
        FileSecretsResolver(tmp_path), EnvCredentialResolver()
    ).resolve_zabbix_api_token("b")
    assert cred.api_token == "file-token"


def test_chain_falls_through_to_env(tmp_path, monkeypatch):
    monkeypatch.setenv("ZABBIX_CRED_B", "env-token")
    cred = ChainedCredentialResolver(
        FileSecretsResolver(tmp_path), EnvCredentialResolver()
    ).resolve_zabbix_api_token("b")
    assert cred.api_token == "env-token"


def test_chain_raises_last_error(tmp_path):
    with pytest.raises(CredentialResolutionError):
        ChainedCredentialResolver(
            FileSecretsResolver(tmp_path), EnvCredentialResolver()
        ).resolve_zabbix_api_token("missing-everywhere")


# --- provider token write path (UI-supplied credential at onboarding) ---


def test_write_binding_token_roundtrip(tmp_path):
    from providers.credentials import write_binding_token
    write_binding_token("my-ref", "  secret-token-123 ", tmp_path)
    f = tmp_path / "my-ref.token"
    assert f.read_text().strip() == "secret-token-123"
    cred = FileSecretsResolver(tmp_path).resolve_zabbix_api_token(
        "my-ref")
    assert cred.api_token == "secret-token-123"


def test_write_binding_token_rejects_traversal(tmp_path):
    from providers.credentials import write_binding_token
    with pytest.raises(CredentialResolutionError):
        write_binding_token("../escape", "x", tmp_path)
    with pytest.raises(CredentialResolutionError):
        write_binding_token("a/b", "x", tmp_path)
    assert not (tmp_path / "escape.token").exists()


def test_write_binding_token_rejects_empty(tmp_path):
    from providers.credentials import write_binding_token
    with pytest.raises(CredentialResolutionError):
        write_binding_token("ok-ref", "   ", tmp_path)
