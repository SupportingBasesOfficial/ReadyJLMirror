"""Problem state unit tests — reader translation + canonical collect.

Covers:
  - ZabbixClient.read_active_problems normalization + truncation flag
  - ZabbixClient.read_recovery_events (r_eventid/r_clock binding)
  - ZabbixClient.read_trigger_associations
  - collect_problem_state against in-memory ports: success, association
    reconciliation, duplicate eventid, truncation, credential failure,
    severity normalization
"""

from __future__ import annotations

import os
from unittest.mock import MagicMock, patch

import pytest

from providers.zabbix import ZabbixClient
from jlmirror_monitoring.problem_state import (
    MAX_PROBLEMS_PER_POLL,
    ProblemAssociationTarget,
    ProblemStateClaim,
    ProblemStateFailureClass,
    ProviderTag,
    ZabbixProblemEvidence,
    collect_problem_state,
    normalize_zabbix_severity,
    ProblemSeverityClass,
    CanonicalProblemState,
)
from jlmirror_monitoring.source import (
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


# ---------------------------------------------------------------------------
# read_active_problems
# ---------------------------------------------------------------------------


def test_read_active_problems_translates():
    client = ZabbixClient()
    rows = [
        {"eventid": "100", "objectid": "42", "clock": "1700000000",
         "name": "CPU high", "severity": "4", "acknowledged": "1",
         "r_eventid": "0",
         "tags": [{"tag": "dc", "value": "east"}]},
        {"eventid": "101", "objectid": "43", "clock": "1700000001",
         "name": "Resolved one", "severity": "2", "acknowledged": "0",
         "r_eventid": "555", "tags": []},
    ]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        result, complete = client.read_active_problems(
            _endpoint(), _credential(), max_rows=10)
    assert complete is True
    assert len(result) == 1  # r_eventid != '0' filtered out
    assert result[0].eventid == "100"
    assert result[0].objectid == "42"
    assert result[0].severity == 4
    assert result[0].acknowledged is True
    assert result[0].tags == (ProviderTag(key="dc", value="east"),)


def test_read_active_problems_truncation_flag():
    client = ZabbixClient()
    rows = [
        {"eventid": str(i), "objectid": "42", "clock": "1700000000",
         "name": f"p{i}", "severity": "3", "acknowledged": "0",
         "r_eventid": "0", "tags": []}
        for i in range(6)  # max_rows=5 -> 6 rows means truncated
    ]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        result, complete = client.read_active_problems(
            _endpoint(), _credential(), max_rows=5)
    assert complete is False
    assert len(result) == 5


def test_read_recovery_events_binds_r_eventid():
    client = ZabbixClient()
    rows = [
        {"eventid": "100", "r_eventid": "555", "r_clock": "1700003600"},
        {"eventid": "101", "r_eventid": "0", "r_clock": "0"},
    ]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        result = client.read_recovery_events(
            _endpoint(), _credential(), ["100", "101"], max_rows=100)
    assert len(result) == 1
    assert result[0].problem_eventid == "100"
    assert result[0].recovery_eventid == "555"
    assert result[0].clock == 1700003600


def test_read_trigger_associations_first_host():
    client = ZabbixClient()
    rows = [
        {"triggerid": "42", "hosts": [{"hostid": "10084"}]},
        {"triggerid": "43", "hosts": []},
        {"triggerid": "44",
         "hosts": [{"hostid": "10085"}, {"hostid": "10086"}]},
    ]
    with patch("providers.zabbix.httpx.Client") as mock_client_cls:
        mock_client = mock_client_cls.return_value.__enter__.return_value
        mock_client.post.return_value = _rpc_response(rows)
        pairs = client.read_trigger_associations(
            _endpoint(), _credential(), max_rows=100)
    assert pairs == [("42", "10084"), ("44", "10085")]


# ---------------------------------------------------------------------------
# collect_problem_state
# ---------------------------------------------------------------------------


def _claim(associations) -> ProblemStateClaim:
    return ProblemStateClaim(
        claim_token="ct",
        tenant_id="tenant:dev",
        monitoring_sync_operation_id="op-p1",
        monitoring_source_id="src-1",
        source_instance_generation="gen-1",
        configuration_revision=1,
        scope_revision=1,
        problem_poll_epoch=1,
        problem_poll_generation=1,
        provider_instance_ref="pi-1",
        provider_configuration=ZabbixProviderConfiguration(
            base_url="https://zabbix.example.com"
        ),
        credential_binding_ref="cred-1",
        associations=tuple(associations),
    )


class _FakeProblemReader:
    def __init__(self, rows, complete=True):
        self._rows = rows
        self._complete = complete

    def read_active_problems(self, endpoint, credential, *, max_rows):
        return list(self._rows), self._complete

    def read_recovery_events(self, endpoint, credential, problem_eventids,
                             *, max_rows):
        return []


def _collect(claim, reader):
    from providers.credentials import EnvCredentialResolver
    from providers.egress import DevOutboundAdmission

    os.environ["ZABBIX_CRED_CRED_1"] = "tok"
    return collect_problem_state(
        claim,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        reader=reader,
    )


def _evidence(eventid, trigger, clock=1700000000, severity=3):
    return ZabbixProblemEvidence(
        eventid=eventid, objectid=trigger, clock=clock,
        name=f"problem {eventid}", severity=severity,
        acknowledged=False, tags=(),
    )


def test_problem_collect_success():
    claim = _claim([
        ProblemAssociationTarget(provider_trigger_ref="42",
                                 monitoring_resource_id="res-1"),
        ProblemAssociationTarget(provider_trigger_ref="43",
                                 monitoring_resource_id="res-2"),
    ])
    reader = _FakeProblemReader([
        _evidence("e1", "42", severity=4),
        _evidence("e2", "43", severity=1),
    ])
    result = _collect(claim, reader)
    assert result.operation_state is SyncOperationState.SUCCEEDED
    assert result.operational_evidence_state is OperationalEvidenceState.CURRENT
    assert result.complete_snapshot is True
    probs = {p.provider_eventid: p for p in result.problems}
    assert probs["e1"].monitoring_resource_id == "res-1"
    assert probs["e1"].severity_class is ProblemSeverityClass.CRITICAL
    assert probs["e2"].severity_class is ProblemSeverityClass.INFORMATIONAL
    assert probs["e2"].state is CanonicalProblemState.ACTIVE


def test_problem_unassociated_trigger_reconciles():
    claim = _claim([])  # no trigger associations
    reader = _FakeProblemReader([_evidence("e1", "999")])
    result = _collect(claim, reader)
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (result.failure_class
            is ProblemStateFailureClass.ASSOCIATION_RECONCILIATION_REQUIRED)


def test_problem_duplicate_eventid_rejected():
    claim = _claim([
        ProblemAssociationTarget(provider_trigger_ref="42",
                                 monitoring_resource_id="res-1"),
    ])
    reader = _FakeProblemReader([
        _evidence("e1", "42"), _evidence("e1", "42"),
    ])
    result = _collect(claim, reader)
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (result.failure_class
            is ProblemStateFailureClass.PROVIDER_PROTOCOL_INVALID)


def test_problem_truncated_result():
    claim = _claim([
        ProblemAssociationTarget(provider_trigger_ref="42",
                                 monitoring_resource_id="res-1"),
    ])
    rows = [_evidence(str(i), "42") for i in range(MAX_PROBLEMS_PER_POLL)]
    result = _collect(claim, _FakeProblemReader(rows))
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (result.failure_class
            is ProblemStateFailureClass.PROVIDER_RESULT_TRUNCATED)


def test_problem_incomplete_snapshot_evidence():
    claim = _claim([
        ProblemAssociationTarget(provider_trigger_ref="42",
                                 monitoring_resource_id="res-1"),
    ])
    result = _collect(claim, _FakeProblemReader([_evidence("e1", "42")],
                                                complete=False))
    assert result.operation_state is SyncOperationState.SUCCEEDED
    assert (result.operational_evidence_state
            is OperationalEvidenceState.RECONCILIATION_REQUIRED)
    assert result.complete_snapshot is False


def test_problem_credential_unavailable():
    os.environ.pop("ZABBIX_CRED_CRED_1", None)
    claim = _claim([
        ProblemAssociationTarget(provider_trigger_ref="42",
                                 monitoring_resource_id="res-1"),
    ])
    from providers.credentials import EnvCredentialResolver
    from providers.egress import DevOutboundAdmission

    result = collect_problem_state(
        claim,
        credential_resolver=EnvCredentialResolver(),
        outbound_admission=DevOutboundAdmission(),
        reader=_FakeProblemReader([]),
    )
    assert result.operation_state is SyncOperationState.RECONCILIATION_REQUIRED
    assert (result.operational_evidence_state
            is OperationalEvidenceState.UNAVAILABLE)
    assert (result.failure_class
            is ProblemStateFailureClass.CREDENTIAL_UNAVAILABLE)


def test_severity_normalization():
    assert normalize_zabbix_severity(0) is ProblemSeverityClass.UNKNOWN
    assert normalize_zabbix_severity(3) is ProblemSeverityClass.DEGRADED
    assert normalize_zabbix_severity(5) is ProblemSeverityClass.CRITICAL
    with pytest.raises(ValueError):
        normalize_zabbix_severity(9)
