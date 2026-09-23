"""Sync scheduler — enqueues due ops per source on a cadence.

Production cadence driver: the poll buttons in the shell are operator
overrides, not the steady state. Each responsibility_kind has a
cadence; a source is due when its last completed op of that kind is
older than the cadence and no fresh pending/running op exists.

Ops carry the source's authority snapshot (generation + revisions) —
claim gates fence anything that went stale while queued, so a late
op is rejected instead of overwriting newer evidence.

Cadences are env-tunable (seconds); per-source cadence overrides are
a deliberate non-goal for now (needs a config column + audit).
"""

from __future__ import annotations

import logging
import os
import secrets
import time
from datetime import datetime, timezone

import psycopg

logger = logging.getLogger("workers.scheduler")

# kind -> seconds between runs
_CADENCES = {
    "problem_state_sync": int(os.environ.get("SCHED_PROBLEM_SECONDS", "60")),
    "current_state_poll": int(os.environ.get("SCHED_CURRENT_SECONDS", "300")),
    "host_inventory_sync": int(os.environ.get("SCHED_INVENTORY_SECONDS", "1800")),
    "metric_definition_poll": int(
        os.environ.get("SCHED_METRICS_SECONDS", "3600")),
    "metric_history_sync": int(os.environ.get("SCHED_HISTORY_SECONDS", "3600")),
}

_HISTORY_WINDOW_SECONDS = int(
    os.environ.get("SCHED_HISTORY_WINDOW_SECONDS", "3600"))

# Evidence states each kind may run against. problem_state_sync is
# gated to 'current' by its claim fence (alert evaluation must never
# see degraded scope evidence); the other kinds also run on degraded
# sources — a successful pass is what restores evidence to 'current'.
_SCHEDULABLE = {
    "problem_state_sync": ("current",),
    "current_state_poll": ("current", "stale", "reconciliation_required"),
    "host_inventory_sync": ("current", "stale", "reconciliation_required"),
    "metric_definition_poll": ("current", "stale", "reconciliation_required"),
    "metric_history_sync": ("current", "stale", "reconciliation_required"),
}

# A pending op older than this stops deduplicating new enqueues —
# fenced/orphaned pendings must not stall the cadence forever.
_PENDING_DEDUP_MINUTES = 15

_DUE_SQL = """
SELECT s.tenant_id, s.monitoring_source_id,
       s.active_source_instance_generation, s.configuration_revision,
       s.scope_revision,
       s.item_definition_poll_epoch, s.item_definition_poll_generation,
       s.current_state_poll_epoch, s.current_state_poll_generation
  FROM monitoring.monitoring_source s
 WHERE s.operational_evidence_state = ANY(%s)
   AND NOT EXISTS (
     SELECT 1 FROM monitoring.monitoring_sync_operation o
      WHERE o.tenant_id = s.tenant_id
        AND o.monitoring_source_id = s.monitoring_source_id
        AND o.responsibility_kind = %s
        AND o.state IN ('pending','running')
        AND o.created_at > now() - make_interval(mins => %s))
   AND COALESCE((SELECT MAX(o2.completed_at)
                   FROM monitoring.monitoring_sync_operation o2
                  WHERE o2.tenant_id = s.tenant_id
                    AND o2.monitoring_source_id = s.monitoring_source_id
                    AND o2.responsibility_kind = %s
                    AND o2.state IN ('succeeded','reconciliation_required',
                                     'failed_terminal')),
                'epoch'::timestamptz) < now() - make_interval(secs => %s)
"""

_INSERT_SQL = """
INSERT INTO monitoring.monitoring_sync_operation
    (tenant_id, monitoring_sync_operation_id, monitoring_source_id,
     source_instance_generation, configuration_revision,
     scope_revision, responsibility_kind, state,
     item_definition_poll_epoch, item_definition_poll_generation,
     current_state_poll_epoch, current_state_poll_generation,
     history_time_from, history_time_till)
VALUES (%s, %s, %s, %s, %s, %s, %s, 'pending', %s, %s, %s, %s, %s, %s)
"""


def _enqueue_due(conn: psycopg.Connection, kind: str, cadence: int) -> int:
    cur = conn.execute(
        _DUE_SQL,
        (list(_SCHEDULABLE[kind]), kind, _PENDING_DEDUP_MINUTES,
         kind, cadence),
    )
    rows = cur.fetchall()
    now = int(datetime.now(timezone.utc).timestamp())
    for (tenant_id, source_id, gen, cfg_rev, scope_rev,
         item_epoch, item_gen, cur_epoch, cur_gen) in rows:
        # Two schedulers must not double-enqueue the same due slot —
        # advisory xact lock per (tenant, source, kind).
        cur = conn.execute(
            "SELECT pg_try_advisory_xact_lock(hashtext(%s))",
            (f"{tenant_id}:{source_id}:{kind}",))
        if not cur.fetchone()[0]:
            continue
        op_id = f"mon-op_{secrets.token_urlsafe(18)}"
        hist_from = hist_till = None
        item_e = item_g = cur_e = cur_g = None
        if kind == "metric_definition_poll":
            item_e, item_g = item_epoch, (item_gen or 0) + 1
        elif kind == "current_state_poll":
            cur_e, cur_g = cur_epoch, (cur_gen or 0) + 1
        elif kind == "metric_history_sync":
            hist_from, hist_till = now - _HISTORY_WINDOW_SECONDS, now
        conn.execute(
            _INSERT_SQL,
            (tenant_id, op_id, source_id, gen, cfg_rev, scope_rev, kind,
             item_e, item_g, cur_e, cur_g, hist_from, hist_till),
        )
        logger.info("scheduled %s for %s/%s", kind, tenant_id, source_id)
    return len(rows)


def _process_pending(conn: psycopg.Connection) -> int:
    """Enqueue ops that are due. Returns count of new ops."""
    enqueued = 0
    for kind, cadence in _CADENCES.items():
        enqueued += _enqueue_due(conn, kind, cadence)
    if enqueued:
        conn.commit()
    return enqueued


def run_scheduler_worker(poll_interval: int = 30, once: bool = False) -> None:
    from shared.config import settings
    with psycopg.connect(settings.db_dsn, autocommit=False) as conn:
        while True:
            n = _process_pending(conn)
            if once:
                logger.info("scheduled %s ops", n)
                return
            time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_scheduler_worker()
