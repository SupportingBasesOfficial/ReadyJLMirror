"""Host inventory unit tests — host.get translation + domain worker.

Covers:
  - ZabbixClient.host_get response normalization (interfaces, groups,
    templates, tags, inventory, truncation detection)
  - HostInventoryWorker end-to-end against in-memory ports:
    success, missing scope anchor, truncated snapshot
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch


from providers.zabbix import ZabbixClient
from jlmirror_monitoring.host_inventory import (
    HostInventoryClaim,
    HostInventoryWorker,
    InventoryFailureClass,
    ZabbixHostSnapshot,
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


_HOST_ROW = {
    "hostid": "10101",
    "host": "web-01",
    "name": "Web Server 01",
    "interfaces": [
        {
            "interfaceid": "501",
            "type": "1",
            "main": "1",
            "useip": "1",
            "ip": "10.0.0.5",
            "dns": "",
            "port": "10050",
        }
    ],
    "groups": [{"groupid": "11", "name": "Linux servers"}],
    "parentTemplates": [{"templateid": "10001", "name": "Linux by agent"}],
    "tags": [{"tag": "env", "value": "prod"}],
    "inventory": {
        "type": "server",
        "os": "Linux",
        "vendor": "Dell",
        "model": "R640",
        "serialno_a": "SN123",
        "location": "DC1",
    },
}


def test_host_get_translates_evidence():
    client = ZabbixClient()
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response([_HOST_ROW])
        snap = client.host_get(_endpoint(), _credential(), ["11"], max_hosts=100)

    assert snap.complete is True
    assert len(snap.hosts) == 1
    h = snap.hosts[0]
    assert h.hostid == "10101"
    assert h.technical_name == "web-01"
    assert h.display_name == "Web Server 01"
    assert h.inventory.os == "Linux"
    assert h.inventory.serial_primary == "SN123"
    assert h.interfaces[0].interface_type == "agent"
    assert h.interfaces[0].use_ip is True
    assert h.groups[0].ref == "11"
    assert h.templates[0].ref == "10001"
    assert h.tags[0].tag == "env"


def test_host_get_truncation_detected():
    client = ZabbixClient()
    rows = [dict(_HOST_ROW, hostid=str(i)) for i in range(3)]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        snap = client.host_get(_endpoint(), _credential(), ["11"], max_hosts=2)

    assert snap.complete is False
    assert len(snap.hosts) == 2  # bounded to max_hosts


# ---------------------------------------------------------------------------
# Domain worker end-to-end with in-memory ports
# ---------------------------------------------------------------------------


class _FakeRepo:
    def __init__(self, claim):
        self.claim = claim
        self.completed = None

    def claim_host_inventory(self, op_id, *, claim_token):
        from dataclasses import replace
        self.claim = replace(self.claim, claim_token=claim_token)
        return self.claim

    def complete_host_inventory(self, claim, result, *, snapshot_evidence_id):
        self.completed = (claim, result, snapshot_evidence_id)
        return result


def _claim() -> HostInventoryClaim:
    return HostInventoryClaim(
        claim_token="",
        tenant_id="tenant:dev",
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
        configured_provider_scope=ConfiguredProviderScope.from_refs(["11"]),
    )


class _FakeReader:
    def __init__(self, groups, snapshot):
        self._groups = groups
        self._snapshot = snapshot

    def hostgroup_get(self, endpoint, credential, refs):
        from jlmirror_monitoring.validation_worker import ZabbixHostGroup
        return [ZabbixHostGroup(groupid=g) for g in self._groups]

    def host_get(self, endpoint, credential, refs, *, max_hosts):
        return self._snapshot


def _snapshot_with_host(hostid="10101") -> ZabbixHostSnapshot:
    client = ZabbixClient()
    host = client._map_host(_HOST_ROW) if hostid == "10101" else client._map_host(
        dict(_HOST_ROW, hostid=hostid)
    )
    return ZabbixHostSnapshot(hosts=(host,), complete=True)


def _make_worker(repo, reader):
    from providers.credentials import EnvCredentialResolver
    from providers.egress import DevOutboundAdmission

    os.environ["ZABBIX_CRED_CRED_1"] = "tok"
    return HostInventoryWorker(
        repository=repo,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        host_reader=reader,
    )


def test_inventory_worker_success():
    repo = _FakeRepo(_claim())
    worker = _make_worker(repo, _FakeReader(["11"], _snapshot_with_host()))
    result = worker.run("op-1")
    assert result.succeeded
    assert result.snapshot_complete is True
    assert len(result.hosts) == 1
    assert repo.completed is not None


def test_inventory_worker_missing_anchor_incomplete():
    repo = _FakeRepo(_claim())
    worker = _make_worker(repo, _FakeReader([], _snapshot_with_host()))
    result = worker.run("op-1")
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert result.operational_evidence_state is OperationalEvidenceState.INCOMPLETE
    assert result.failure_class is InventoryFailureClass.SCOPE_ANCHOR_INACCESSIBLE


def test_inventory_worker_truncated_snapshot_incomplete():
    snap = ZabbixHostSnapshot(hosts=(), complete=False)
    repo = _FakeRepo(_claim())
    worker = _make_worker(repo, _FakeReader(["11"], snap))
    result = worker.run("op-1")
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert result.operational_evidence_state is OperationalEvidenceState.INCOMPLETE
    assert result.failure_class is InventoryFailureClass.SNAPSHOT_TRUNCATED


def test_inventory_worker_out_of_scope_host_rejected():
    # Host in snapshot whose groups don't intersect configured scope
    client = ZabbixClient()
    bad_host = client._map_host(
        dict(_HOST_ROW, groups=[{"groupid": "99", "name": "other"}])
    )
    snap = ZabbixHostSnapshot(hosts=(bad_host,), complete=True)
    repo = _FakeRepo(_claim())
    worker = _make_worker(repo, _FakeReader(["11"], snap))
    result = worker.run("op-1")
    assert result.operational_evidence_state is OperationalEvidenceState.INCOMPLETE
    assert result.failure_class is InventoryFailureClass.SCOPE_EVIDENCE_INVALID
