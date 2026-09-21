"""Metric definition unit tests — item.get translation + domain worker.

Covers:
  - ZabbixClient.item_get normalization (value_type/status mapping,
    truncation detection)
  - MetricDefinitionWorker end-to-end against in-memory ports:
    success, missing scope anchor, truncated snapshot
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from providers.zabbix import ZabbixClient
from jlmirror_monitoring.metric_definitions import (
    MetricDefinitionClaim,
    MetricDefinitionFailureClass,
    MetricDefinitionWorker,
    ZabbixItemOperationalState,
    ZabbixItemSnapshot,
    ZabbixNativeValueType,
)
from jlmirror_monitoring.source import (
    ConfiguredProviderScope,
    OperationalEvidenceState,
    SyncOperationState,
    ZabbixProviderConfiguration,
)
from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
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


_ITEM_ROW = {
    "itemid": "42424",
    "hostid": "10101",
    "name": "CPU utilization",
    "key_": "system.cpu.util",
    "units": "%",
    "value_type": "0",
    "state": "0",
    "status": "0",
}


def test_item_get_translates_evidence():
    client = ZabbixClient()
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response([_ITEM_ROW])
        snap = client.item_get(_endpoint(), _credential(), ["11"], max_items=100)

    assert snap.complete is True
    item = snap.items[0]
    assert item.itemid == "42424"
    assert item.hostid == "10101"
    assert item.key == "system.cpu.util"
    assert item.unit == "%"
    assert item.native_value_type is ZabbixNativeValueType.FLOAT
    assert item.operational_state is ZabbixItemOperationalState.ENABLED
    assert item.value_kind.value == "number"


def test_item_get_maps_operational_states():
    client = ZabbixClient()
    disabled = dict(_ITEM_ROW, itemid="1", status="1")
    unsupported = dict(_ITEM_ROW, itemid="2", status="0", state="1")
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response([disabled, unsupported])
        snap = client.item_get(_endpoint(), _credential(), ["11"], max_items=10)

    states = {i.itemid: i.operational_state for i in snap.items}
    assert states["1"] is ZabbixItemOperationalState.DISABLED
    assert states["2"] is ZabbixItemOperationalState.UNSUPPORTED


def test_item_get_truncation_detected():
    client = ZabbixClient()
    rows = [dict(_ITEM_ROW, itemid=str(i)) for i in range(3)]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        snap = client.item_get(_endpoint(), _credential(), ["11"], max_items=2)

    assert snap.complete is False
    assert len(snap.items) == 2


def test_item_get_unknown_value_type_rejected():
    client = ZabbixClient()
    bad = dict(_ITEM_ROW, value_type="9")
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response([bad])
        from jlmirror_monitoring.validation_worker import ProviderProtocolError
        with pytest.raises(ProviderProtocolError):
            client.item_get(_endpoint(), _credential(), ["11"], max_items=10)


# ---------------------------------------------------------------------------
# Domain worker end-to-end
# ---------------------------------------------------------------------------


class _FakeRepo:
    def __init__(self, claim):
        self.claim = claim
        self.completed = None

    def claim_metric_definitions(self, op_id, *, claim_token):
        from dataclasses import replace
        self.claim = replace(self.claim, claim_token=claim_token)
        return self.claim

    def complete_metric_definitions(self, claim, result, *, snapshot_evidence_id):
        self.completed = (claim, result, snapshot_evidence_id)
        return result


def _claim() -> MetricDefinitionClaim:
    return MetricDefinitionClaim(
        claim_token="",
        tenant_id="tenant:test",
        monitoring_sync_operation_id="op-1",
        monitoring_source_id="src-1",
        provider_scope_tenant_binding_id="bind-1",
        source_instance_generation="gen-1",
        configuration_revision=1,
        scope_revision=1,
        item_definition_poll_epoch=1,
        item_definition_poll_generation=1,
        provider_instance_ref="pi-1",
        provider_configuration=ZabbixProviderConfiguration(
            base_url="https://zabbix.example.com"
        ),
        credential_binding_ref="cred-1",
        configured_provider_scope=ConfiguredProviderScope.from_refs(["11"]),
    )


class _FakeReader:
    def __init__(self, groups, snapshot):
        self._groups = groups
        self._snapshot = snapshot

    def hostgroup_get(self, endpoint, credential, refs):
        from jlmirror_monitoring.validation_worker import ZabbixHostGroup
        return [ZabbixHostGroup(groupid=g) for g in self._groups]

    def item_get(self, endpoint, credential, refs, *, max_items):
        return self._snapshot


def _snapshot_with_item() -> ZabbixItemSnapshot:
    return ZabbixItemSnapshot(
        items=(ZabbixClient._map_item(_ITEM_ROW),), complete=True
    )


def _make_worker(repo, reader):
    from providers.credentials import EnvCredentialResolver
    from providers.egress import DevOutboundAdmission

    os.environ["ZABBIX_CRED_CRED_1"] = "tok"
    return MetricDefinitionWorker(
        repository=repo,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        item_reader=reader,
    )


def test_metric_worker_success():
    repo = _FakeRepo(_claim())
    worker = _make_worker(repo, _FakeReader(["11"], _snapshot_with_item()))
    result = worker.run("op-1")
    assert result.succeeded
    assert result.snapshot_complete is True
    assert len(result.items) == 1
    assert repo.completed is not None


def test_metric_worker_missing_anchor_incomplete():
    repo = _FakeRepo(_claim())
    worker = _make_worker(repo, _FakeReader([], _snapshot_with_item()))
    result = worker.run("op-1")
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert result.operational_evidence_state is OperationalEvidenceState.INCOMPLETE
    assert result.failure_class is MetricDefinitionFailureClass.SCOPE_ANCHOR_INACCESSIBLE


def test_metric_worker_truncated_incomplete():
    snap = ZabbixItemSnapshot(items=(), complete=False)
    repo = _FakeRepo(_claim())
    worker = _make_worker(repo, _FakeReader(["11"], snap))
    result = worker.run("op-1")
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert result.operational_evidence_state is OperationalEvidenceState.INCOMPLETE
    assert result.failure_class is MetricDefinitionFailureClass.SNAPSHOT_TRUNCATED
