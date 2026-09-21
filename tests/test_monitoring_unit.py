"""Monitoring vertical unit tests — adapters and domain wiring, no DB.

Covers:
  - ZabbixClient hostgroup.get translation (mocked httpx)
  - EnvCredentialResolver dev resolution
  - DevOutboundAdmission https + allowlist enforcement
  - InitialValidationWorker end-to-end against in-memory ports
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from providers.credentials import EnvCredentialResolver
from providers.egress import DevOutboundAdmission
from providers.zabbix import ZabbixClient
from jlmirror_monitoring.source import (
    ConfiguredProviderScope,
    ZabbixProviderConfiguration,
)
from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
    CredentialResolutionError,
    EgressAdmissionError,
    InitialValidationClaim,
    InitialValidationWorker,
    ProviderAuthenticationError,
    ProviderUnavailableError,
    ResolvedZabbixCredential,
    SyncOperationState,
    OperationalEvidenceState,
)


# ---------------------------------------------------------------------------
# EnvCredentialResolver
# ---------------------------------------------------------------------------


def test_env_credential_resolver_happy_path(monkeypatch):
    monkeypatch.setenv("ZABBIX_CRED_CRED_BINDING_1", "token-abc")
    cred = EnvCredentialResolver().resolve_zabbix_api_token("cred-binding-1")
    assert cred.api_token == "token-abc"
    assert cred.credential_generation_ref


def test_env_credential_resolver_missing(monkeypatch):
    monkeypatch.delenv("ZABBIX_CRED_NOPE", raising=False)
    with pytest.raises(CredentialResolutionError):
        EnvCredentialResolver().resolve_zabbix_api_token("nope")


# ---------------------------------------------------------------------------
# DevOutboundAdmission
# ---------------------------------------------------------------------------


def test_egress_admits_allowlisted_https(monkeypatch):
    monkeypatch.setenv("EGRESS_ALLOW_HOSTS", "zabbix.example.com")
    cfg = ZabbixProviderConfiguration(base_url="https://zabbix.example.com")
    ep = DevOutboundAdmission().admit_zabbix_api(cfg)
    assert ep.api_url == "https://zabbix.example.com/api_jsonrpc.php"
    assert ep.egress_decision_ref


def test_egress_denies_without_allowlist(monkeypatch):
    monkeypatch.delenv("EGRESS_ALLOW_HOSTS", raising=False)
    monkeypatch.delenv("EGRESS_ALLOW_ALL_HOSTS", raising=False)
    cfg = ZabbixProviderConfiguration(base_url="https://zabbix.example.com")
    with pytest.raises(EgressAdmissionError, match="EGRESS_ALLOW_HOSTS"):
        DevOutboundAdmission().admit_zabbix_api(cfg)


def test_egress_allowlist_blocks(monkeypatch):
    monkeypatch.setenv("EGRESS_ALLOW_HOSTS", "allowed.example.com")
    cfg = ZabbixProviderConfiguration(base_url="https://blocked.example.com")
    with pytest.raises(EgressAdmissionError):
        DevOutboundAdmission().admit_zabbix_api(cfg)


def test_egress_allowlist_permits(monkeypatch):
    monkeypatch.setenv("EGRESS_ALLOW_HOSTS", "zabbix.example.com, other.local")
    cfg = ZabbixProviderConfiguration(base_url="https://zabbix.example.com")
    ep = DevOutboundAdmission().admit_zabbix_api(cfg)
    assert ep.api_url.endswith("/api_jsonrpc.php")


def test_egress_dns_screen_blocks_loopback(monkeypatch):
    monkeypatch.delenv("EGRESS_ALLOW_PRIVATE_IPS", raising=False)
    monkeypatch.setenv("EGRESS_ALLOW_HOSTS", "localhost")
    cfg = ZabbixProviderConfiguration(base_url="https://localhost")
    with pytest.raises(EgressAdmissionError, match="non-public"):
        DevOutboundAdmission().admit_zabbix_api(cfg)


def test_egress_dns_screen_blocks_unresolvable(monkeypatch):
    monkeypatch.delenv("EGRESS_ALLOW_PRIVATE_IPS", raising=False)
    monkeypatch.setenv("EGRESS_ALLOW_HOSTS", "no-such-host.invalid")
    cfg = ZabbixProviderConfiguration(
        base_url="https://no-such-host.invalid")
    with pytest.raises(EgressAdmissionError, match="does not resolve"):
        DevOutboundAdmission().admit_zabbix_api(cfg)


def test_egress_private_ips_flag_bypasses_screen(monkeypatch):
    monkeypatch.setenv("EGRESS_ALLOW_PRIVATE_IPS", "true")
    monkeypatch.setenv("EGRESS_ALLOW_HOSTS", "localhost")
    cfg = ZabbixProviderConfiguration(base_url="https://localhost")
    ep = DevOutboundAdmission().admit_zabbix_api(cfg)
    assert ep.api_url == "https://localhost/api_jsonrpc.php"


# ---------------------------------------------------------------------------
# ZabbixClient hostgroup_get
# ---------------------------------------------------------------------------


def _endpoint() -> AdmittedProviderEndpoint:
    return AdmittedProviderEndpoint(
        api_url="https://zabbix.example.com/api_jsonrpc.php",
        egress_decision_ref="egress-test",
    )


def _credential() -> ResolvedZabbixCredential:
    return ResolvedZabbixCredential(
        api_token="tok", credential_generation_ref="gen-1"
    )


def _rpc_response(result):
    resp = MagicMock()
    resp.status_code = 200
    resp.json.return_value = {"jsonrpc": "2.0", "result": result, "id": 1}
    return resp


def test_zabbix_hostgroup_get_translates():
    client = ZabbixClient()
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(
            [{"groupid": "12", "name": "Linux servers"}]
        )
        groups = client.hostgroup_get(
            _endpoint(), _credential(), ["Linux servers"]
        )
    assert len(groups) == 1
    assert groups[0].groupid == "12"
    assert groups[0].name == "Linux servers"


def test_zabbix_auth_rejected():
    client = ZabbixClient()
    resp = MagicMock()
    resp.status_code = 401
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = resp
        with pytest.raises(ProviderAuthenticationError):
            client.hostgroup_get(_endpoint(), _credential(), ["g"])


def test_zabbix_unreachable():
    client = ZabbixClient()
    import httpx

    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.side_effect = httpx.ConnectError("refused")
        with pytest.raises(ProviderUnavailableError):
            client.hostgroup_get(_endpoint(), _credential(), ["g"])


# ---------------------------------------------------------------------------
# InitialValidationWorker against in-memory ports
# ---------------------------------------------------------------------------


class _FakeRepo:
    def __init__(self, claim):
        self.claim = claim
        self.completed = None

    def claim_initial_validation(self, op_id, *, claim_token):
        from dataclasses import replace
        self.claim = replace(self.claim, claim_token=claim_token)
        return self.claim

    def complete_initial_validation(self, claim, result, *, validation_evidence_id):
        self.completed = (claim, result, validation_evidence_id)


def _claim() -> InitialValidationClaim:
    return InitialValidationClaim(
        claim_token="",
        tenant_id="tenant:test",
        monitoring_sync_operation_id="op-1",
        monitoring_source_id="src-1",
        provider_scope_tenant_binding_id="bind-1",
        source_instance_generation="gen-1",
        configuration_revision=1,
        scope_revision=1,
        provider_instance_ref="pi-1",
        provider_configuration=ZabbixProviderConfiguration(
            base_url="https://zabbix.example.com"
        ),
        credential_binding_ref="cred-1",
        configured_provider_scope=ConfiguredProviderScope.from_refs(["11", "22"]),
    )


class _FakeReader:
    def __init__(self, groupids):
        self.groupids = groupids

    def hostgroup_get(self, endpoint, credential, refs):
        from jlmirror_monitoring.validation_worker import ZabbixHostGroup
        return [ZabbixHostGroup(groupid=g) for g in self.groupids]


def test_validation_worker_success():
    repo = _FakeRepo(_claim())
    worker = InitialValidationWorker(
        repository=repo,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        host_group_reader=_FakeReader(["11", "22"]),
    )
    os.environ["ZABBIX_CRED_CRED_1"] = "tok"
    result = worker.run("op-1")
    assert result.succeeded
    assert result.operation_state is SyncOperationState.SUCCEEDED
    assert repo.completed is not None
    claim, res, ev = repo.completed
    assert res.operational_evidence_state is OperationalEvidenceState.CURRENT


def test_validation_worker_missing_group_incomplete():
    repo = _FakeRepo(_claim())
    worker = InitialValidationWorker(
        repository=repo,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        host_group_reader=_FakeReader(["11"]),  # "22" missing
    )
    os.environ["ZABBIX_CRED_CRED_1"] = "tok"
    result = worker.run("op-1")
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert result.operational_evidence_state is OperationalEvidenceState.INCOMPLETE
    assert "22" in result.missing_host_group_refs
