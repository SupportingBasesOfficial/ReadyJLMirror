"""Metric current-state unit tests — reader translation + domain worker.

Covers:
  - ZabbixClient.read_current_values normalization
  - MetricCurrentStateWorker end-to-end against in-memory ports:
    success, canonical value parsing per kind, missing target coverage
"""

from __future__ import annotations

import os
from decimal import Decimal
from unittest.mock import MagicMock, patch

import pytest

from providers.zabbix import ZabbixClient
from jlmirror_monitoring.metric_current_state import (
    CurrentMetricTarget,
    MetricCurrentStateClaim,
    MetricCurrentStateWorker,
    parse_canonical_value,
)
from jlmirror_monitoring.metric_definitions import MetricValueKind
from jlmirror_monitoring.source import (
    SyncOperationState,
    ZabbixProviderConfiguration,
)
from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
    ProviderProtocolError,
    ResolvedZabbixCredential,
)


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


# ---------------------------------------------------------------------------
# parse_canonical_value
# ---------------------------------------------------------------------------


def test_parse_number():
    assert parse_canonical_value(MetricValueKind.NUMBER, "3.14") == Decimal("3.14")
    with pytest.raises(ValueError):
        parse_canonical_value(MetricValueKind.NUMBER, "abc")
    with pytest.raises(ValueError):
        parse_canonical_value(MetricValueKind.NUMBER, "NaN")


def test_parse_integer():
    assert parse_canonical_value(MetricValueKind.INTEGER, "42") == 42
    with pytest.raises(ValueError):
        parse_canonical_value(MetricValueKind.INTEGER, "4.5")
    with pytest.raises(ValueError):
        parse_canonical_value(MetricValueKind.INTEGER, "-1")


def test_parse_boolean_and_strings():
    assert parse_canonical_value(MetricValueKind.BOOLEAN, "1") is True
    assert parse_canonical_value(MetricValueKind.BOOLEAN, "0") is False
    with pytest.raises(ValueError):
        parse_canonical_value(MetricValueKind.BOOLEAN, "yes")
    assert parse_canonical_value(MetricValueKind.STRING, "text") == "text"


# ---------------------------------------------------------------------------
# read_current_values
# ---------------------------------------------------------------------------


def test_read_current_values_translates():
    client = ZabbixClient()
    row = {"itemid": "42424", "lastvalue": "7.5",
           "lastclock": "1700000000", "lastns": "123456789"}
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response([row])
        rows = client.read_current_values(
            _endpoint(), _credential(), ["42424"], max_items=100
        )
    assert len(rows) == 1
    assert rows[0].itemid == "42424"
    assert rows[0].raw_value == "7.5"
    assert rows[0].lastclock == 1700000000
    assert rows[0].lastns == 123456789


def test_read_current_values_zero_clock_rejected():
    client = ZabbixClient()
    row = {"itemid": "1", "lastvalue": "5", "lastclock": "0", "lastns": "0"}
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response([row])
        with pytest.raises(ProviderProtocolError):
            client.read_current_values(
                _endpoint(), _credential(), ["1"], max_items=10
            )


# ---------------------------------------------------------------------------
# Domain worker end-to-end
# ---------------------------------------------------------------------------


class _FakeRepo:
    def __init__(self, claim):
        self.claim = claim
        self.completed = None

    def claim_metric_current_state(self, op_id, *, claim_token):
        from dataclasses import replace
        self.claim = replace(self.claim, claim_token=claim_token)
        return self.claim

    def complete_metric_current_state(self, claim, result):
        self.completed = (claim, result)
        return result


def _claim() -> MetricCurrentStateClaim:
    return MetricCurrentStateClaim(
        claim_token="",
        tenant_id="tenant:test",
        monitoring_sync_operation_id="op-1",
        monitoring_source_id="src-1",
        source_instance_generation="gen-1",
        configuration_revision=1,
        scope_revision=1,
        current_state_poll_epoch=1,
        current_state_poll_generation=1,
        provider_instance_ref="pi-1",
        provider_configuration=ZabbixProviderConfiguration(
            base_url="https://zabbix.example.com"
        ),
        credential_binding_ref="cred-1",
        targets=(
            CurrentMetricTarget(
                metric_definition_id="def-1",
                monitoring_resource_id="res-1",
                provider_external_ref="42424",
                value_kind=MetricValueKind.NUMBER,
            ),
            CurrentMetricTarget(
                metric_definition_id="def-2",
                monitoring_resource_id="res-1",
                provider_external_ref="42425",
                value_kind=MetricValueKind.INTEGER,
            ),
        ),
    )


class _FakeReader:
    def __init__(self, rows):
        self._rows = rows

    def read_current_values(self, endpoint, credential, itemids, *, max_items):
        from jlmirror_monitoring.metric_current_state import (
            ZabbixCurrentValueEvidence,
        )
        return [
            ZabbixCurrentValueEvidence(
                itemid=r["itemid"], raw_value=r["raw_value"],
                lastclock=r["lastclock"], lastns=r["lastns"],
            )
            for r in self._rows
        ]


def _make_worker(repo, reader):
    from providers.credentials import EnvCredentialResolver
    from providers.egress import DevOutboundAdmission

    os.environ["ZABBIX_CRED_CRED_1"] = "tok"
    return MetricCurrentStateWorker(
        repository=repo,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        reader=reader,
    )


def test_current_state_worker_success():
    repo = _FakeRepo(_claim())
    reader = _FakeReader([
        {"itemid": "42424", "raw_value": "12.5", "lastclock": 1700000000, "lastns": 0},
        {"itemid": "42425", "raw_value": "7", "lastclock": 1700000000, "lastns": 0},
    ])
    worker = _make_worker(repo, reader)
    result = worker.run("op-1")
    assert result.succeeded
    assert len(result.accepted_observations) == 2
    obs = {o.provider_external_ref: o.canonical_value
           for o in result.accepted_observations}
    assert obs["42424"] == Decimal("12.5")
    assert obs["42425"] == 7


def test_current_state_worker_value_parse_invalid():
    repo = _FakeRepo(_claim())
    reader = _FakeReader([
        {"itemid": "42424", "raw_value": "not-a-number",
         "lastclock": 1700000000, "lastns": 0},
    ])
    worker = _make_worker(repo, reader)
    result = worker.run("op-1")
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    from jlmirror_monitoring.metric_current_state import (
        CurrentStateFailureClass,
    )
    assert result.failure_class is CurrentStateFailureClass.VALUE_PARSE_INVALID


def test_current_state_worker_unexpected_itemid_rejected():
    repo = _FakeRepo(_claim())
    reader = _FakeReader([
        {"itemid": "99999", "raw_value": "1",
         "lastclock": 1700000000, "lastns": 0},
    ])
    worker = _make_worker(repo, reader)
    result = worker.run("op-1")
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert result.failure_class is not None
