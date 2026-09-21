"""Metric history unit tests — reader translation + canonical collect.

Covers:
  - ZabbixClient.read_history normalization (history.get)
  - read_metric_history_window against in-memory ports:
    success, window bounds, duplicate stream identity, unexpected itemid,
    truncation detection, credential/egress failure mapping
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from providers.zabbix import ZabbixClient
from jlmirror_monitoring.metric_definitions import MetricValueKind
from jlmirror_monitoring.metric_history import (
    HistoryCoverageState,
    HistoryMetricTarget,
    MAX_HISTORY_ITEMS_PER_REQUEST,
    MAX_HISTORY_ROWS_PER_REQUEST,
    MetricHistoryClaim,
    MetricHistoryFailureClass,
    MetricHistoryWindow,
    ZabbixHistoryEvidence,
    read_metric_history_window,
)
from jlmirror_monitoring.source import (
    OperationalEvidenceState,
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
# read_history (history.get)
# ---------------------------------------------------------------------------


def test_read_history_translates():
    client = ZabbixClient()
    rows = [
        {"itemid": "42424", "clock": "1700000000", "ns": "5",
         "value": "1.25"},
        {"itemid": "42424", "clock": "1700000060", "ns": "0",
         "value": "1.5"},
    ]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        result = client.read_history(
            _endpoint(), _credential(),
            history_value_type=0, itemids=["42424"],
            time_from=1700000000, time_till=1700003600,
            max_rows=MAX_HISTORY_ROWS_PER_REQUEST,
        )
    assert len(result) == 2
    assert result[0].itemid == "42424"
    assert result[0].clock == 1700000000
    assert result[0].ns == 5
    assert result[0].raw_value == "1.25"


def test_read_history_zero_clock_rejected():
    client = ZabbixClient()
    rows = [{"itemid": "1", "clock": "0", "ns": "0", "value": "5"}]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        with pytest.raises(ProviderProtocolError):
            client.read_history(
                _endpoint(), _credential(),
                history_value_type=0, itemids=["1"],
                time_from=1, time_till=10, max_rows=100,
            )


def test_read_history_bad_ns_rejected():
    client = ZabbixClient()
    rows = [{"itemid": "1", "clock": "1700000000", "ns": "1000000000",
             "value": "5"}]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        with pytest.raises(ProviderProtocolError):
            client.read_history(
                _endpoint(), _credential(),
                history_value_type=0, itemids=["1"],
                time_from=1, time_till=10, max_rows=100,
            )


# ---------------------------------------------------------------------------
# Window bounds
# ---------------------------------------------------------------------------


def test_window_bounded_and_ordered():
    with pytest.raises(ValueError):
        MetricHistoryWindow(0, 10)  # non-positive from
    with pytest.raises(ValueError):
        MetricHistoryWindow(10, 5)  # unordered
    with pytest.raises(ValueError):
        MetricHistoryWindow(1, 1 + 86_401)  # over the 24h ceiling


def test_target_history_value_type_bounded():
    t = HistoryMetricTarget(
        metric_definition_id="def-1", monitoring_resource_id="res-1",
        provider_external_ref="42", value_kind=MetricValueKind.NUMBER,
        history_value_type=0,
    )
    assert t.history_value_type == 0
    with pytest.raises(ValueError):
        HistoryMetricTarget("d", "r", "42", MetricValueKind.NUMBER, 6)


# ---------------------------------------------------------------------------
# read_metric_history_window
# ---------------------------------------------------------------------------


def _claim(targets, window=(1000, 2000)) -> MetricHistoryClaim:
    return MetricHistoryClaim(
        claim_token="ct",
        tenant_id="tenant:test",
        monitoring_sync_operation_id="op-h1",
        monitoring_source_id="src-1",
        source_instance_generation="gen-1",
        configuration_revision=1,
        scope_revision=1,
        provider_instance_ref="pi-1",
        provider_configuration=ZabbixProviderConfiguration(
            base_url="https://zabbix.example.com"
        ),
        credential_binding_ref="cred-1",
        targets=tuple(targets),
        window=MetricHistoryWindow(*window),
    )


def _target(itemid="42424", value_type=0,
            kind=MetricValueKind.NUMBER, def_id="def-1"):
    return HistoryMetricTarget(
        metric_definition_id=def_id, monitoring_resource_id="res-1",
        provider_external_ref=itemid, value_kind=kind,
        history_value_type=value_type,
    )


class _FakeHistoryReader:
    def __init__(self, rows_by_type):
        self._rows_by_type = rows_by_type
        self.calls = []

    def read_history(self, endpoint, credential, *, history_value_type,
                     itemids, time_from, time_till, max_rows):
        self.calls.append((history_value_type, tuple(itemids)))
        return list(self._rows_by_type.get(history_value_type, []))


def _collect(claim, reader):
    from providers.credentials import EnvCredentialResolver
    from providers.egress import DevOutboundAdmission

    os.environ["ZABBIX_CRED_CRED_1"] = "tok"
    return read_metric_history_window(
        claim,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        reader=reader,
    )


def test_history_window_success_groups_by_value_type():
    claim = _claim([
        _target("42424", 0),
        _target("42425", 3, MetricValueKind.INTEGER, "def-2"),
    ])
    reader = _FakeHistoryReader({
        0: [ZabbixHistoryEvidence("42424", 1500, 0, "1.5")],
        3: [ZabbixHistoryEvidence("42425", 1500, 0, "7")],
    })
    result = _collect(claim, reader)
    assert result.operation_state is SyncOperationState.SUCCEEDED
    assert result.operational_evidence_state is OperationalEvidenceState.CURRENT
    assert result.coverage_state is HistoryCoverageState.OPEN
    # Two history.get calls — one per value type
    assert sorted(reader.calls) == [(0, ("42424",)), (3, ("42425",))]


def test_history_window_empty_targets_invalid():
    claim = _claim([])
    result = _collect(claim, _FakeHistoryReader({}))
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (
        result.failure_class
        is MetricHistoryFailureClass.PROVIDER_PROTOCOL_INVALID
    )


def test_history_window_too_many_targets_invalid():
    targets = [
        _target(str(i), 0, MetricValueKind.NUMBER, f"def-{i}")
        for i in range(MAX_HISTORY_ITEMS_PER_REQUEST + 1)
    ]
    result = _collect(_claim(targets), _FakeHistoryReader({}))
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED


def test_history_duplicate_stream_identity_invalid():
    # Same (itemid, value_type) pair twice — provider-identity collision
    claim = _claim([_target("42", 0), _target("42", 0, def_id="def-x")])
    result = _collect(claim, _FakeHistoryReader({}))
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (
        result.failure_class
        is MetricHistoryFailureClass.PROVIDER_PROTOCOL_INVALID
    )


def test_history_unexpected_itemid_rejected():
    claim = _claim([_target("42", 0)])
    reader = _FakeHistoryReader({
        0: [ZabbixHistoryEvidence("99999", 1500, 0, "1")],
    })
    result = _collect(claim, reader)
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (
        result.failure_class
        is MetricHistoryFailureClass.PROVIDER_PROTOCOL_INVALID
    )


def test_history_truncated_page_detected():
    claim = _claim([_target("42", 0)])
    full_page = [
        ZabbixHistoryEvidence("42", 1000 + i, 0, "1")
        for i in range(MAX_HISTORY_ROWS_PER_REQUEST)
    ]
    reader = _FakeHistoryReader({0: full_page})
    result = _collect(claim, reader)
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (
        result.failure_class is MetricHistoryFailureClass.PAGE_TRUNCATED
    )


def test_history_credential_unavailable():
    claim = _claim([_target("42", 0)])
    # No ZABBIX_CRED_CRED_1 in env for a fresh resolver — clear it
    os.environ.pop("ZABBIX_CRED_CRED_1", None)
    from providers.credentials import EnvCredentialResolver
    from providers.egress import DevOutboundAdmission

    result = read_metric_history_window(
        claim,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        reader=_FakeHistoryReader({}),
    )
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (
        result.operational_evidence_state
        is OperationalEvidenceState.UNAVAILABLE
    )
    assert (
        result.failure_class
        is MetricHistoryFailureClass.CREDENTIAL_UNAVAILABLE
    )
