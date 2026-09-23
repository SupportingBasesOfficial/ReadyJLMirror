"""Purge test-fixture rows for the suite tenant (dev-only).

The pytest suite runs live-PG tests against `tenant:test` in the
development database. Sources created by fixtures accumulate and the
worker schedules sync operations for them forever — the churn that
motivated this purge. `pytest_sessionfinish` calls `purge()` after
each run; it can also be invoked standalone:

    python -m scripts.purge_test_tenant

Safety: refuses to touch any tenant other than `tenant:test`. Uses
`session_replication_role = 'replica'` to bypass the evidence
immutability triggers for this session only — the deletes are
ordered leaf-to-root so referential integrity holds without them.
Owner connection required (superuser); same credentials the tests
use for RLS-bypass asserts.
"""

from __future__ import annotations

import os
import sys

import psycopg

TENANT = "tenant:test"

# Leaf-to-root across every pipeline schema. g1.* (tenant identity,
# principals, sessions) and audit.* are intentionally preserved.
TABLES = [
    "notification.provider_ref_binding",
    "notification.notification_callback_inbox",
    "notification.notification_attempt",
    "notification.notification_provider_evidence",
    "notification.notification_projection",
    "notification.notification_dispatch_outbox",
    "notification.notification_intent",
    "itsm.incident_sync_outbox",
    "itsm.incident_provider_link",
    "itsm.incident_comment",
    "itsm.incident_assignment",
    "itsm.incident_transition",
    "itsm.incident",
    "human_operations.visibility_receipt",
    "human_operations.current_action_projection",
    "human_operations.alert_action_assignment",
    "human_operations.alert_acknowledgement",
    "human_operations.visibility_requirement",
    "human_operations.resource_responsibility_assignment",
    "alerting.alert_transition",
    "alerting.alert_decision",
    "alerting.alert",
    "alerting.inbox_receipt",
    "alerting.alert_policy_effective_version",
    "alerting.alert_policy_version",
    "alerting.alert_policy",
    "monitoring.monitoring_metric_current_state_transition",
    "monitoring.metric_current_state",
    "monitoring.metric_observation",
    "monitoring.monitoring_metric_observation_acceptance",
    "monitoring.metric_history_gap_evidence",
    "monitoring.metric_history_stream_state",
    "monitoring.monitoring_metric_definition_provider_evidence",
    "monitoring.monitoring_metric_definition_snapshot_evidence",
    "monitoring.metric_definition_provider_binding",
    "monitoring.metric_definition",
    "monitoring.monitoring_problem_transition",
    "monitoring.health_projection_transition",
    "monitoring.health_projection",
    "monitoring.monitoring_problem",
    "monitoring.monitoring_problem_snapshot_evidence",
    "monitoring.monitoring_problem_provider_binding",
    "monitoring.monitoring_trigger_binding",
    "monitoring.monitoring_problem_state_runtime_admission",
    "monitoring.monitoring_resource",
    "monitoring.monitoring_resource_provider_evidence",
    "monitoring.monitoring_host_inventory_snapshot_evidence",
    "monitoring.monitoring_source_validation_evidence",
    "monitoring.monitoring_outbox",
    "monitoring.monitoring_sync_operation",
    "monitoring.monitoring_source_create_idempotency",
    "monitoring.monitoring_source",
    "monitoring.monitoring_source_generation",
    "monitoring.worker_heartbeat",
]


def purge(tenant: str = TENANT) -> dict[str, int]:
    """Delete every pipeline row for `tenant`. Returns per-table counts."""
    if tenant != TENANT:
        raise ValueError(f"refusing to purge non-fixture tenant {tenant!r}")
    counts: dict[str, int] = {}
    with psycopg.connect(
        host=os.environ.get("DB_HOST", "localhost"),
        port=int(os.environ.get("DB_PORT", "5434")),
        dbname=os.environ.get("DB_NAME", "jlmirror"),
        user="jlmirror_owner",
        password=os.environ.get("DB_OWNER_PASSWORD", "jlmirror_dev"),
    ) as conn:
        conn.execute("SET session_replication_role = 'replica'")
        for table in TABLES:
            cur = conn.execute(
                f"DELETE FROM {table} WHERE tenant_id = %s", (tenant,))
            if cur.rowcount:
                counts[table] = cur.rowcount
    return counts


def main() -> int:
    counts = purge()
    total = sum(counts.values())
    for table, n in counts.items():
        print(f"  {n:>7} {table}")
    print(f"purged {total} rows from {TENANT}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
