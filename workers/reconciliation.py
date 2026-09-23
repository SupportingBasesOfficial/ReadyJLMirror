"""Reaper + reconciliation worker — durable op recovery.

Three failure modes closed, all bounded:

1. **Orphaned `running`** — the claiming worker died mid-op. The op
   holds a claim_token forever and the source silently stalls. Ops
   past the lease (`WORKER_OP_LEASE_SECONDS`, default 600s) are
   returned to `pending` for a fresh claim — polls are
   snapshot-authoritative so re-execution is idempotent. Past
   `WORKER_OP_RECOVERY_MAX` returns the op goes `failed_terminal`
   with `claim.orphaned_exhausted` — a deterministic crash must not
   loop forever.

2. **Zombie `pending`** — every claim fence requires the op's
   (generation, configuration_revision, scope_revision) snapshot to
   equal the source's current authority. When the source moved on the
   op is provably unclaimable; it would sit `pending` forever and
   block scheduler dedup. Swept to `failed_terminal` with
   `authority_superseded`.

3. **`reconciliation_required` / `failed_terminal`** — terminal ops
   with no live successor. Auto-requeue (bounded by recovery_count and
   `WORKER_RECONCILE_BACKOFF_SECONDS`) closes the recovery loop the
   operator endpoint performs manually. Skipped when the scheduler
   already produced a live op of the same kind — cadence is the
   preferred path, the reconciler is the last resort.
"""

from __future__ import annotations

import logging
import os
import time

import psycopg

from shared import telemetry
from shared.config import settings

logger = logging.getLogger(__name__)

_LEASE_SECONDS = int(os.environ.get("WORKER_OP_LEASE_SECONDS", "600"))
_RECOVERY_MAX = int(os.environ.get("WORKER_OP_RECOVERY_MAX", "3"))
_BACKOFF_SECONDS = int(
    os.environ.get("WORKER_RECONCILE_BACKOFF_SECONDS", "300"))


def _reap_orphaned_running(conn: psycopg.Connection) -> int:
    """running ops past the lease -> pending (bounded) or terminal."""
    cur = conn.execute(
        """
        UPDATE monitoring.monitoring_sync_operation
           SET state = 'pending', claim_token = NULL, started_at = NULL,
               recovery_count = recovery_count + 1,
               last_error_class = 'claim.orphaned'
         WHERE state = 'running'
           AND started_at < transaction_timestamp()
                          - make_interval(secs => %s)
           AND recovery_count < %s
        """,
        (_LEASE_SECONDS, _RECOVERY_MAX),
    )
    requeued = cur.rowcount
    cur = conn.execute(
        """
        UPDATE monitoring.monitoring_sync_operation
           SET state = 'failed_terminal', claim_token = NULL,
               completed_at = transaction_timestamp(),
               last_error_class = 'claim.orphaned_exhausted'
         WHERE state = 'running'
           AND started_at < transaction_timestamp()
                          - make_interval(secs => %s)
           AND recovery_count >= %s
        """,
        (_LEASE_SECONDS, _RECOVERY_MAX),
    )
    exhausted = cur.rowcount
    if requeued:
        logger.warning("reaper: %s orphaned running op(s) requeued",
                       requeued)
    if exhausted:
        logger.error(
            "reaper: %s orphaned running op(s) exhausted recovery",
            exhausted)
    return requeued + exhausted


def _sweep_zombie_pending(conn: psycopg.Connection) -> int:
    """pending ops whose authority snapshot no longer matches the
    source can never be claimed — every claim fence requires
    generation + configuration_revision + scope_revision equality,
    and the poll kinds additionally fence on their epoch/generation
    pair (claimable only when source.poll_generation =
    op.poll_generation - 1)."""
    cur = conn.execute(
        """
        UPDATE monitoring.monitoring_sync_operation o
           SET state = 'failed_terminal',
               completed_at = transaction_timestamp(),
               last_error_class = 'authority_superseded'
          FROM monitoring.monitoring_source s
         WHERE s.tenant_id = o.tenant_id
           AND s.monitoring_source_id = o.monitoring_source_id
           AND o.state = 'pending'
           AND o.claim_token IS NULL
           AND (s.active_source_instance_generation
                    <> o.source_instance_generation
                OR s.configuration_revision <> o.configuration_revision
                OR s.scope_revision <> o.scope_revision
                OR (o.responsibility_kind = 'metric_definition_poll'
                    AND (o.item_definition_poll_epoch IS NULL
                         OR o.item_definition_poll_generation IS NULL
                         OR s.item_definition_poll_epoch
                             IS DISTINCT FROM o.item_definition_poll_epoch
                         OR s.item_definition_poll_generation
                             IS DISTINCT FROM
                                 o.item_definition_poll_generation - 1))
                OR (o.responsibility_kind = 'current_state_poll'
                    AND (o.current_state_poll_epoch IS NULL
                         OR o.current_state_poll_generation IS NULL
                         OR s.current_state_poll_epoch
                             IS DISTINCT FROM o.current_state_poll_epoch
                         OR s.current_state_poll_generation
                             IS DISTINCT FROM
                                 o.current_state_poll_generation - 1)))
        """,
    )
    n = cur.rowcount
    if n:
        logger.warning(
            "reaper: %s zombie pending op(s) terminated "
            "(authority snapshot superseded)", n)
    return n


def _reconcile_terminal(conn: psycopg.Connection) -> int:
    """Bounded auto-requeue of terminal ops with no live successor.

    `requeue_sync_operation` restores source evidence authority — the
    reconciliation act. A live pending/running op of the same kind
    means the scheduler already regenerated the work; do not double.
    """
    cur = conn.execute(
        """
        SELECT o.tenant_id, o.monitoring_source_id,
               o.monitoring_sync_operation_id, o.responsibility_kind
          FROM monitoring.monitoring_sync_operation o
         WHERE o.state IN ('reconciliation_required', 'failed_terminal')
           AND o.recovery_count < %s
           AND o.completed_at < transaction_timestamp()
                                - make_interval(secs => %s)
           AND NOT EXISTS (
               SELECT 1 FROM monitoring.monitoring_sync_operation n
                WHERE n.tenant_id = o.tenant_id
                  AND n.monitoring_source_id = o.monitoring_source_id
                  AND n.responsibility_kind = o.responsibility_kind
                  AND n.state IN ('pending', 'running'))
         ORDER BY o.completed_at
         LIMIT 32
        """,
        (_RECOVERY_MAX, _BACKOFF_SECONDS),
    )
    rows = cur.fetchall()
    requeued = 0
    for tenant_id, source_id, op_id, kind in rows:
        cur = conn.execute(
            "SELECT monitoring.requeue_sync_operation(%s, %s, %s)",
            (tenant_id, source_id, op_id))
        if cur.fetchone()[0]:
            requeued += 1
            telemetry.correlation_id_var.set(op_id)
            telemetry.tenant_id_var.set(tenant_id)
            logger.info(
                "reconciler: requeued %s op %s for source %s",
                kind, op_id, source_id)
    return requeued


def _process_pending(conn: psycopg.Connection) -> int:
    """One recovery pass. Returns ops recovered + terminated."""
    n = (_reap_orphaned_running(conn)
         + _sweep_zombie_pending(conn)
         + _reconcile_terminal(conn))
    conn.commit()
    return n


def run_reconciliation_worker(
    poll_interval: int = 15, once: bool = False
) -> None:
    """Run the reaper/reconciler loop (blocking)."""
    logger.info(
        "reconciliation worker starting (poll=%ss, lease=%ss, "
        "backoff=%ss, max_recovery=%s)",
        poll_interval, _LEASE_SECONDS, _BACKOFF_SECONDS, _RECOVERY_MAX)
    while True:
        try:
            with psycopg.connect(
                    settings.db_dsn, autocommit=False,
                    connect_timeout=10) as conn:
                n = _process_pending(conn)
                if n:
                    logger.info("reconciliation pass recovered %s ops", n)
        except psycopg.OperationalError:
            logger.exception("db connection lost; reconnecting")
        if once:
            return
        time.sleep(poll_interval)


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO)
    run_reconciliation_worker(once="--once" in __import__("sys").argv)
