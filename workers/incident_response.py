"""G11 Incident Response worker — processes the action_request outbox.

Polls per tenant for pending open_ticket / notify / automation actions.
Each action is claimed with a lease, dispatched, then completed with
linked / failed / skipped / unknown. Follows the same _call() pattern as
itsm_sync.py: one canonical SECURITY DEFINER function per transaction,
SET LOCAL ROLE inside the transaction so the boundary never bleeds.

open_ticket: delegates to shared.itsm_adapter (generic HTTP webhook).
  Set ITSM_WEBHOOK_URL + ITSM_WEBHOOK_TOKEN to wire a real provider.
  Without ITSM_WEBHOOK_URL the action is marked skipped.
notify: resolves destinations from the IR policy (g11_get_notify_destinations)
  and dispatches via email/slack/whatsapp providers. Fails gracefully when
  providers are not configured (env vars not set).
automation: creates automation_run records for each script in automation_triggers;
  the automation_runner worker executes them on the next tick.
"""

from __future__ import annotations

import logging
import secrets

import psycopg

from shared import itsm_adapter

logger = logging.getLogger(__name__)

_WORKER_ROLE = "jlmirror_g11_ir_worker_invoker"
_CLAIM_SECONDS = 60
_EXECUTOR_ID = f"g11-worker-{secrets.token_hex(4)}"


def _call(conn: psycopg.Connection, fn: str, params: tuple):
    with conn.transaction():
        conn.execute(f"SET LOCAL ROLE {_WORKER_ROLE}")
        cur = conn.execute(
            f"SELECT incident_response.{fn}("
            + ",".join(["%s"] * len(params)) + ")",
            params)
        row = cur.fetchone()
    return row[0] if row else None


def _tenants(conn: psycopg.Connection) -> list[str]:
    cur = conn.execute("SELECT tenant_id FROM g1.tenants WHERE state='active'")
    return [r[0] for r in cur.fetchall()]


def _dispatch_channel(channel_class: str, destination_ref: str,
                      correlation_id: str, tenant_id: str = "") -> None:
    """Call the appropriate notification provider for an IR event."""
    if channel_class == "email_smtp@1":
        from providers.email import send_message as _send
        _send(destination_ref=destination_ref, template_name="ir_error_event",
              correlation_id=correlation_id)
    elif channel_class == "slack@1":
        from providers.slack import send_message as _send
        _send(destination_ref=destination_ref, template_name="ir_error_event",
              correlation_id=correlation_id)
    else:
        from providers.whatsapp import send_message as _send
        _send(destination_ref=destination_ref, template_name="ir_error_event",
              correlation_id=correlation_id,
              template_variables=[tenant_id, correlation_id])


def _process_tenant(conn: psycopg.Connection, tenant_id: str) -> int:
    candidate = _call(conn, "g11_next_pending_action", (tenant_id,))
    if candidate is None:
        return 0

    request_id = candidate["request_id"]
    action_kind = candidate["action_kind"]

    claim = _call(conn, "g11_claim_action",
                  (tenant_id, request_id, _EXECUTOR_ID, _CLAIM_SECONDS))
    if not claim or claim.get("status") != "dispatching":
        return 0

    result_state = "unknown"
    provider_ref: str | None = None
    failure_class: str | None = None

    try:
        if action_kind == "open_ticket":
            ref = itsm_adapter.open_ticket(
                tenant_id=tenant_id,
                request_id=request_id,
                event_id=candidate.get("event_id"),
                metadata=candidate.get("metadata"),
            )
            if ref is not None:
                provider_ref = ref
                result_state = "linked"
                logger.info(
                    "g11 open_ticket tenant=%s event=%s ref=%s",
                    tenant_id, candidate.get("event_id"), provider_ref)
            else:
                result_state = "skipped"
                failure_class = "itsm_not_configured"
                logger.debug(
                    "g11 open_ticket skipped (ITSM_WEBHOOK_URL not set)"
                    " tenant=%s", tenant_id)

        elif action_kind == "notify":
            destinations = _call(conn, "g11_get_notify_destinations", (tenant_id,)) or []
            if not destinations:
                result_state = "skipped"
                failure_class = "notify_no_channels_configured"
                logger.debug("g11 notify skipped — no channels in policy tenant=%s",
                             tenant_id)
            else:
                sent = 0
                last_err: str | None = None
                for dest in destinations:
                    try:
                        _dispatch_channel(
                            dest["channel_class"],
                            dest["destination_ref"],
                            request_id,
                            tenant_id,
                        )
                        sent += 1
                    except Exception as exc:
                        last_err = str(exc)[:128]
                        logger.warning(
                            "g11 notify channel=%s error: %s",
                            dest.get("destination_config_id"), exc)
                if sent > 0:
                    result_state = "linked"
                    provider_ref = f"sent:{sent}/{len(destinations)}"
                    logger.info("g11 notify tenant=%s sent=%s/%s",
                                tenant_id, sent, len(destinations))
                else:
                    result_state = "failed"
                    failure_class = f"notify_all_failed:{last_err}"

        elif action_kind == "automation":
            policy = _call(conn, "g11_get_policy", (tenant_id,)) or {}
            triggers = policy.get("automation_triggers") or []
            queued = 0
            for trig in triggers:
                script_id = trig.get("script_id") if isinstance(trig, dict) else None
                if not script_id:
                    continue
                run_id = f"arun:{secrets.token_urlsafe(16)}"
                res = _call(conn, "g11_enqueue_automation",
                            (tenant_id, script_id, run_id))
                if res and res.get("status") == "enqueued":
                    queued += 1
                    logger.info(
                        "g11 automation enqueued run=%s script=%s tenant=%s",
                        run_id, script_id, tenant_id)
            if queued > 0:
                result_state = "linked"
                provider_ref = f"runs:{queued}"
            else:
                result_state = "skipped"
                failure_class = "automation_no_scripts_queued"

        else:
            result_state = "skipped"
            failure_class = f"unsupported_kind:{action_kind}"

    except Exception as exc:
        result_state = "unknown"
        failure_class = f"dispatch_error:{type(exc).__name__}"
        logger.exception("g11 dispatch error tenant=%s request=%s",
                         tenant_id, request_id)

    _call(conn, "g11_complete_action",
          (tenant_id, request_id, _EXECUTOR_ID,
           result_state, provider_ref, failure_class))
    return 1


def _process_pending(conn: psycopg.Connection) -> int:
    """Entry point called by run_all.py on every scheduler tick."""
    total = 0
    try:
        tenant_ids = _tenants(conn)
    except Exception:
        conn.rollback()
        logger.exception("g11 worker: failed to fetch tenants")
        return 0
    for tenant_id in tenant_ids:
        try:
            total += _process_tenant(conn, tenant_id)
        except Exception:
            conn.rollback()
            logger.exception("g11 worker error tenant=%s", tenant_id)
    conn.commit()
    return total
