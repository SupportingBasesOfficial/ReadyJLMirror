"""G10 ITSM sync worker — claims the durable provider-sync outbox
through the canonical invoker boundary (SET LOCAL ROLE inside each
transaction; jlmirror_worker holds no itsm.* table privilege).

Loop per tenant: next candidate -> claim (lease) -> adapter
create_or_link -> complete (linked/failed/unknown) -> bounded retry
via g10_schedule_sync_retry. Expired claims become
reconciliation_required -> reconciled to unknown -> retry.
"""

from __future__ import annotations

import logging
import secrets

import psycopg
from psycopg.types.json import Jsonb

from providers import itsm as itsm_adapter

logger = logging.getLogger(__name__)

_WORKER_ROLE = "jlmirror_g10_itsm_worker_invoker"
_CLAIM_SECONDS = 60


def _call(conn: psycopg.Connection, fn: str, params: tuple):
    """One canonical g10 function call as the worker invoker, inside
    its own transaction so the role never bleeds into other work."""
    with conn.transaction():
        conn.execute(f"SET LOCAL ROLE {_WORKER_ROLE}")
        cur = conn.execute(
            f"SELECT itsm.{fn}("
            + ",".join(["%s"] * len(params)) + ")",
            params)
        row = cur.fetchone()
    return row[0] if row else None


def _sync_tenant(conn: psycopg.Connection, tenant_id: str,
                 executor_id: str) -> int:
    cand = _call(conn, "g10_next_sync_candidate", (tenant_id,))
    if cand is None:
        return 0
    outbox_id = cand["sync_outbox_id"]
    claim = _call(conn, "g10_claim_sync",
                  (tenant_id, outbox_id, executor_id, _CLAIM_SECONDS))
    state = claim.get("state") if claim else None

    if state == "reconciliation_required":
        # Claim lease expired — outcome unknowable, fail closed to
        # unknown and schedule the bounded retry.
        _call(conn, "g10_reconcile_sync", (tenant_id, outbox_id))
        _call(conn, "g10_schedule_sync_retry",
              (tenant_id, cand["incident_id"]))
        logger.info("itsm sync %s reconciled -> unknown", outbox_id)
        return 1
    if state != "dispatching":
        return 0

    try:
        result = itsm_adapter.create_or_link(
            incident=cand, sync_identity=cand["sync_identity"])
        result_state = result.get("state", "unknown")
        if result_state not in ("linked", "failed", "unknown"):
            result_state = "unknown"
        ticket_ref = result.get("provider_ticket_ref")
        failure = result.get("failure_class")
        evidence = {"adapter_version": itsm_adapter.ADAPTER_VERSION,
                    "provider_status": result.get("provider_status")}
    except itsm_adapter.ITSMError as exc:
        result_state = "unknown"
        ticket_ref = None
        failure = str(exc)[:128]
        evidence = {"adapter_version": itsm_adapter.ADAPTER_VERSION,
                    "error": str(exc)[:256]}

    _call(conn, "g10_complete_sync",
          (tenant_id, outbox_id, executor_id, result_state,
           ticket_ref, Jsonb(evidence), failure))
    if result_state in ("failed", "unknown"):
        _call(conn, "g10_schedule_sync_retry",
              (tenant_id, cand["incident_id"]))
    logger.info("itsm sync %s incident %s -> %s",
                outbox_id, cand["incident_id"], result_state)
    return 1


def _process_pending(conn: psycopg.Connection) -> int:
    cur = conn.execute(
        "SELECT tenant_id FROM g1.tenants WHERE state='active'")
    tenants = [r[0] for r in cur.fetchall()]
    conn.commit()
    executor = f"itsm-worker-{secrets.token_hex(4)}"
    processed = 0
    for tenant_id in tenants:
        try:
            processed += _sync_tenant(conn, tenant_id, executor)
        except Exception:
            conn.rollback()
            logger.exception("itsm sync tick failed for %s", tenant_id)
    return processed
