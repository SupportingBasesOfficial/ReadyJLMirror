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


# --- onboarding discovery endpoint (token -> real group list) ---


def test_discover_groups_endpoint(monkeypatch):
    """Discovery returns the provider's real groups; token stays transient."""
    from fastapi.testclient import TestClient
    from api.main import app
    from jlmirror_monitoring.validation_worker import (
        AdmittedProviderEndpoint, ZabbixHostGroup)
    from providers import zabbix as zbx
    from providers import egress

    seen = {}

    class _Admission:
        def admit_zabbix_api(self, cfg):
            seen["base_url"] = cfg.base_url
            return AdmittedProviderEndpoint(
                api_url=cfg.base_url.rstrip("/") + "/api_jsonrpc.php",
                egress_decision_ref="egress-test")

    class _Client:
        def list_host_groups(self, endpoint, credential):
            seen["token"] = credential.api_token
            return [
                ZabbixHostGroup(groupid="5", name="Cliente A"),
                ZabbixHostGroup(groupid="9", name="Network devices"),
            ]

    monkeypatch.setattr(egress, "DevOutboundAdmission", _Admission)
    monkeypatch.setattr(zbx, "ZabbixClient", _Client)
    # Endpoint imports resolve at call time — patch the module attrs
    import api.routers.monitoring as mon
    monkeypatch.setattr(mon, "DevOutboundAdmission", _Admission,
                        raising=False)
    monkeypatch.setattr(mon, "ZabbixClient", _Client, raising=False)

    r = TestClient(app).post(
        "/api/v1/monitoring/sources/discover-groups",
        json={"provider_base_url": "https://zbx.example.com",
              "api_token": "transient-token"})
    assert r.status_code == 200, r.text
    assert r.json() == [
        {"groupid": "5", "name": "Cliente A"},
        {"groupid": "9", "name": "Network devices"},
    ]
    assert seen["token"] == "transient-token"
    assert seen["base_url"] == "https://zbx.example.com"


def test_discover_groups_requires_token():
    from fastapi.testclient import TestClient
    from api.main import app
    r = TestClient(app).post(
        "/api/v1/monitoring/sources/discover-groups",
        json={"provider_base_url": "https://zbx.example.com",
              "api_token": "   "})
    assert r.status_code == 400

# --- OpenBao runtime resolver -------------------------------------------------

def _bao(document, monkeypatch=None):
    """Resolver backed by a canned KV document."""
    from providers.credentials import BaoCredentialResolver

    class FakeClock:
        t = 0.0
        def monotonic(self):
            return self.t

    r = BaoCredentialResolver(
        addr="http://bao.test", token="tok", cache_seconds=30)
    r._time = FakeClock()
    calls = {"n": 0}

    def fake_fetch():
        calls["n"] += 1
        return document

    r._fetch_document = fake_fetch
    return r, calls


def test_bao_resolver_reads_kv_document():
    from providers.credentials import BaoCredentialResolver  # noqa
    r, calls = _bao({"cred-a": "bao-token-1"})
    cred = r.resolve_zabbix_api_token("cred-a")
    assert cred.api_token == "bao-token-1"
    assert cred.credential_generation_ref == "cred-gen-bao:cred-a"
    assert calls["n"] == 1


def test_bao_resolver_caches_within_ttl():
    r, calls = _bao({"cred-a": "tok"})
    r.resolve_zabbix_api_token("cred-a")
    r.resolve_zabbix_api_token("cred-a")
    assert calls["n"] == 1
    r._time.t += 31  # past TTL
    r.resolve_zabbix_api_token("cred-a")
    assert calls["n"] == 2


def test_bao_resolver_missing_ref():
    r, _ = _bao({"other": "tok"})
    with pytest.raises(CredentialResolutionError):
        r.resolve_zabbix_api_token("cred-missing")


def test_bao_resolver_unconfigured():
    from providers.credentials import BaoCredentialResolver
    r = BaoCredentialResolver(addr="", token="")
    assert not r.available
    with pytest.raises(CredentialResolutionError):
        r.resolve_zabbix_api_token("cred-a")


def test_chain_prefers_bao_when_configured(monkeypatch, tmp_path):
    """BAO_ADDR+token present -> bao wins over files and env."""
    from providers.credentials import (
        BaoCredentialResolver, ChainedCredentialResolver)
    monkeypatch.setenv("BAO_ADDR", "http://bao.test")
    monkeypatch.setenv("BAO_TOKEN", "tok")
    monkeypatch.setenv("ZABBIX_CRED_CRED_A", "env-token")
    (tmp_path / "cred-a.token").write_text("file-token")
    monkeypatch.setenv("CREDENTIALS_DIR", str(tmp_path))
    chain = ChainedCredentialResolver()
    bao = chain._resolvers[0]
    assert isinstance(bao, BaoCredentialResolver)
    bao._fetch_document = lambda: {"cred-a": "bao-token"}
    cred = chain.resolve_zabbix_api_token("cred-a")
    assert cred.api_token == "bao-token"


def test_chain_skips_bao_when_unconfigured(monkeypatch, tmp_path):
    monkeypatch.delenv("BAO_ADDR", raising=False)
    monkeypatch.delenv("BAO_TOKEN", raising=False)
    monkeypatch.setenv("SECRETS_DIR", str(tmp_path))
    monkeypatch.setenv("ZABBIX_CRED_CRED_A", "env-token")
    from providers.credentials import (
        ChainedCredentialResolver, FileSecretsResolver,
        EnvCredentialResolver)
    chain = ChainedCredentialResolver()
    kinds = [type(r).__name__ for r in chain._resolvers]
    assert kinds == ["FileSecretsResolver", "EnvCredentialResolver"]
    cred = chain.resolve_zabbix_api_token("cred-a")
    assert cred.api_token == "env-token"
