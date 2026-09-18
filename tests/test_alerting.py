"""Alerting core-model integration tests (wave4.alerting-core-model@1).

Exercises the transition machinery against real PostgreSQL: lifecycle
law, idempotent replay, identity-conflict detection, terminal state,
source-kind integrity and immutable transition history.

Skips gracefully when PostgreSQL is unreachable.
"""

from __future__ import annotations

import asyncio
import os
import secrets
import sys

import pytest
import pytest_asyncio
from psycopg import AsyncConnection

if sys.platform == "win32":
    asyncio.set_event_loop_policy(
        asyncio.WindowsSelectorEventLoopPolicy())

pytestmark = pytest.mark.integration

_TENANT = "tenant:dev"
_DSN = (
    f"postgresql://{os.environ.get('DB_USER', 'jlmirror_owner')}"
    f":{os.environ.get('DB_PASSWORD', 'jlmirror_dev')}"
    f"@{os.environ.get('DB_HOST', 'localhost')}"
    f":{os.environ.get('DB_PORT', '5434')}"
    f"/{os.environ.get('DB_NAME', 'jlmirror')}")


@pytest_asyncio.fixture
async def conn():
    try:
        c = await AsyncConnection.connect(_DSN, connect_timeout=3)
    except Exception:
        pytest.skip("PostgreSQL is not reachable")
    await c.execute(
        "SELECT set_config('jlmirror.tenant_id', %s, false)", (_TENANT,))
    yield c
    await c.close()


def _rid(prefix: str) -> str:
    return f"{prefix}_{secrets.token_urlsafe(10)}"


async def _seed_problem_source(conn) -> dict:
    """Create the minimum Monitoring rows a problem-sourced alert
    needs — source, generation, resource, problem (revision 1)."""
    from shared.alerting_repo import commit_alert_transition  # noqa
    sid, gen, rid, pid = _rid("mon-src"), _rid("mon-gen"), \
        _rid("mon-res"), _rid("mon-prob")
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_source
            (tenant_id, monitoring_source_id,
             provider_scope_tenant_binding_id, provider_profile,
             active_source_instance_generation, configuration_revision,
             scope_revision, display_name, credential_binding_ref,
             configured_provider_scope, operational_evidence_state,
             last_sync_operation_id)
        VALUES (%s, %s, 'binding-t', 'zabbix', %s, 1, 1, 'alert-test',
                'cred-binding-1', '{"host_group_refs": ["5"]}',
                'unavailable', 'op-seed')
        """,
        (_TENANT, sid, gen))
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_resource
            (tenant_id, monitoring_resource_id, monitoring_source_id,
             source_instance_generation, resource_kind,
             provider_object_kind, provider_external_ref, display_name,
             scope_state, scope_projection_revision, scope_evidence_state,
             presence_state, presence_evidence_state,
             last_observed_at, last_confirmed_present_at)
        VALUES (%s, %s, %s, %s, 'host', 'zabbix_host', 'h-alert',
                'host-alert',
                'in_scope', 1, 'current',
                'present', 'current', now(), now())
        """,
        (_TENANT, rid, sid, gen))
    await conn.execute(
        """
        INSERT INTO monitoring.monitoring_problem
            (tenant_id, problem_id, monitoring_source_id,
             source_instance_generation, monitoring_resource_id,
             problem_state, severity_class, summary,
             opened_at, last_confirmed_at, evidence_state,
             projection_revision, problem_poll_epoch,
             problem_poll_generation)
        VALUES (%s, %s, %s, %s, %s, 'active', 'warning', 'test',
                now(), now(), 'current', 1, 1, 1)
        """,
        (_TENANT, pid, sid, gen, rid))
    return {"source_id": sid, "generation": gen,
            "resource_id": rid, "problem_id": pid}


async def test_create_resolve_lifecycle(conn):
    from shared.alerting_repo import commit_alert_transition
    src = await _seed_problem_source(conn)
    aid, tid1, tid2 = _rid("alt"), _rid("alt-tr"), _rid("alt-tr")

    alert = await commit_alert_transition(
        conn, _TENANT,
        alert_transition_id=tid1, alert_id=aid, to_state="active",
        transition_reason="test_create", source_kind="monitoring_problem",
        monitoring_source_id=src["source_id"],
        source_instance_generation=src["generation"],
        monitoring_resource_id=src["resource_id"],
        problem_id=src["problem_id"], source_transition_id="pt_1",
        source_projection_revision=1,
        policy_id="pol_t", policy_version=1,
        correlation_id="corr_t")
    assert alert["lifecycle_state"] == "active"
    assert alert["projection_revision"] == 1
    assert alert["resolved_at"] is None

    alert = await commit_alert_transition(
        conn, _TENANT,
        alert_transition_id=tid2, alert_id=aid, to_state="resolved",
        transition_reason="test_resolve", source_kind="monitoring_problem",
        monitoring_source_id=src["source_id"],
        source_instance_generation=src["generation"],
        monitoring_resource_id=src["resource_id"],
        problem_id=src["problem_id"], source_transition_id="pt_2",
        source_projection_revision=1,
        policy_id="pol_t", policy_version=1,
        correlation_id="corr_t2")
    assert alert["lifecycle_state"] == "resolved"
    assert alert["resolved_at"] is not None
    assert alert["projection_revision"] == 2


async def test_idempotent_replay(conn):
    from shared.alerting_repo import commit_alert_transition
    src = await _seed_problem_source(conn)
    aid, tid = _rid("alt"), _rid("alt-tr")
    kw = dict(
        alert_transition_id=tid, alert_id=aid, to_state="active",
        transition_reason="t", source_kind="monitoring_problem",
        monitoring_source_id=src["source_id"],
        source_instance_generation=src["generation"],
        monitoring_resource_id=src["resource_id"],
        problem_id=src["problem_id"], source_transition_id="pt_1",
        source_projection_revision=1,
        policy_id="pol_t", policy_version=1, correlation_id="c")
    await commit_alert_transition(conn, _TENANT, **kw)
    again = await commit_alert_transition(conn, _TENANT, **kw)
    assert again["projection_revision"] == 1  # no second transition


async def test_identity_conflict_is_integrity_failure(conn):
    from shared.alerting_repo import (
        IntegrityFailure, commit_alert_transition)
    src = await _seed_problem_source(conn)
    aid, tid = _rid("alt"), _rid("alt-tr")
    base = dict(
        alert_transition_id=tid, alert_id=aid,
        transition_reason="t", source_kind="monitoring_problem",
        monitoring_source_id=src["source_id"],
        source_instance_generation=src["generation"],
        monitoring_resource_id=src["resource_id"],
        problem_id=src["problem_id"], source_transition_id="pt_1",
        source_projection_revision=1,
        policy_id="pol_t", policy_version=1, correlation_id="c")
    await commit_alert_transition(conn, _TENANT, to_state="active", **base)
    with pytest.raises(IntegrityFailure):
        await commit_alert_transition(conn, _TENANT, to_state="resolved", **base)


async def test_resolved_is_terminal(conn):
    from shared.alerting_repo import AlertingError, commit_alert_transition
    src = await _seed_problem_source(conn)
    aid = _rid("alt")
    base = dict(
        alert_id=aid, transition_reason="t",
        source_kind="monitoring_problem",
        monitoring_source_id=src["source_id"],
        source_instance_generation=src["generation"],
        monitoring_resource_id=src["resource_id"],
        problem_id=src["problem_id"],
        source_projection_revision=1,
        policy_id="pol_t", policy_version=1, correlation_id="c")
    await commit_alert_transition(conn, _TENANT, to_state="active",
                                  alert_transition_id=_rid("alt-tr"),
                                  source_transition_id="pt_1", **base)
    await commit_alert_transition(conn, _TENANT, to_state="resolved",
                                  alert_transition_id=_rid("alt-tr"),
                                  source_transition_id="pt_2", **base)
    with pytest.raises(AlertingError, match="terminal"):
        await commit_alert_transition(conn, _TENANT, to_state="resolved",
                                      alert_transition_id=_rid("alt-tr"),
                                      source_transition_id="pt_3", **base)


async def test_health_source_forbids_problem_id(conn):
    from shared.alerting_repo import AlertingError, commit_alert_transition
    with pytest.raises(AlertingError, match="problem_id"):
        await commit_alert_transition(
            conn, _TENANT,
            alert_transition_id=_rid("alt-tr"), alert_id=_rid("alt"),
            to_state="active", transition_reason="t",
            source_kind="monitoring_health_projection",
            monitoring_source_id="s", source_instance_generation="g",
            monitoring_resource_id="r", problem_id="not-allowed",
            source_transition_id="ht_1", source_projection_revision=1,
            policy_id="p", policy_version=1, correlation_id="c")


async def test_policy_evidence_required(conn):
    from shared.alerting_repo import AlertingError, commit_alert_transition
    src = await _seed_problem_source(conn)
    with pytest.raises(AlertingError, match="policy"):
        await commit_alert_transition(
            conn, _TENANT,
            alert_transition_id=_rid("alt-tr"), alert_id=_rid("alt"),
            to_state="active", transition_reason="t",
            source_kind="monitoring_problem",
            monitoring_source_id=src["source_id"],
            source_instance_generation=src["generation"],
            monitoring_resource_id=src["resource_id"],
            problem_id=src["problem_id"], source_transition_id="pt_1",
            source_projection_revision=1,
            policy_id="", policy_version=1, correlation_id="c")


async def test_stale_source_fails_closed(conn):
    from shared.alerting_repo import AlertingError, commit_alert_transition
    src = await _seed_problem_source(conn)
    aid = _rid("alt")
    base = dict(
        alert_id=aid, transition_reason="t",
        source_kind="monitoring_problem",
        monitoring_source_id=src["source_id"],
        source_instance_generation=src["generation"],
        monitoring_resource_id=src["resource_id"],
        problem_id=src["problem_id"],
        policy_id="p", policy_version=1, correlation_id="c")
    await commit_alert_transition(conn, _TENANT, to_state="active",
                                  alert_transition_id=_rid("alt-tr"),
                                  source_transition_id="pt_1",
                                  source_projection_revision=1, **base)
    # Claim a revision the projection does not have — must fail closed.
    with pytest.raises(AlertingError, match="stale"):
        await commit_alert_transition(conn, _TENANT, to_state="resolved",
                                      alert_transition_id=_rid("alt-tr"),
                                      source_transition_id="pt_2",
                                      source_projection_revision=999, **base)
