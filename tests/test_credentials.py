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
