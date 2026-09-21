"""G9 notification delivery — intent, dispatch, evidence,
projection reads (canonical g9.notification-delivery@1).

Intent creation requires alerting:operate; reads alerting:read.
The callback endpoint is external (no session) — authenticity is
HMAC over the raw body; unbindable/forged callbacks are poisoned.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets

from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared import access
from shared.audit import record_audit_event
from shared.db import db_tenant_connection
from shared.notification import _hash

router = APIRouter(prefix="/api/v1/alerting", tags=["notifications"])

_REASONS = ("alert_requires_attention", "alert_action_requested",
            "customer_awareness_required")


class IntentCreate(BaseModel):
    recipient_principal_id: str | None = None
    destination_ref: str            # phone_number_id / msisdn ref
    reason: str = "alert_requires_attention"
    payload_ref: str = "alert_notification"
    visibility_requirement_id: str | None = None
    logical_action_id: str | None = None


@router.post("/alerts/{alert_id}/notifications",
             status_code=status.HTTP_201_CREATED)
async def create_intent(alert_id: str, request: Request,
                        body: IntentCreate,
                        tenant_id: str | None = None) -> dict:
    """Immutable notification intent + durable dispatch enqueue.
    NEVER mutates alert lifecycle/action ownership."""
    tenant = _authoritative_tenant(request, tenant_id)
    ctx = request.state.jlmirror_context or {}
    actor = ctx.get("principal_id", "dev-operator")
    if body.reason not in _REASONS:
        raise HTTPException(status_code=422,
                            detail=f"reason one of {_REASONS}")
    logical_id = (body.logical_action_id
                  or f"nti_{secrets.token_urlsafe(12)}")
    intent_id = f"nti_{secrets.token_urlsafe(12)}"
    content = {"alert_id": alert_id, "destination_ref":
               body.destination_ref, "reason": body.reason,
               "payload_ref": body.payload_ref}
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "SELECT lifecycle_state FROM alerting.alert "
            "WHERE tenant_id=%s AND alert_id=%s", (tenant, alert_id))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404,
                                detail="alert not found")
        perms = sorted(await access.effective_permissions(
            conn, actor, tenant))
        snapshot = {"principal_id": actor, "tenant_id": tenant,
                    "permissions": perms}
        cur = await conn.execute(
            """
            SELECT notification_intent_id
              FROM notification.notification_intent
             WHERE tenant_id=%s AND logical_action_id=%s
            """, (tenant, logical_id))
        prior = await cur.fetchone()
        if prior:
            return {"notification_intent_id": prior[0],
                    "replayed": True}
        await conn.execute(
            """
            INSERT INTO notification.notification_intent
                (tenant_id, notification_intent_id, alert_id,
                 recipient_principal_id, destination_ref,
                 channel_class, reason, payload_ref, content_hash,
                 visibility_requirement_id, authority_snapshot,
                 logical_action_id, created_by_principal_id)
            VALUES (%s,%s,%s,%s,%s,'whatsapp_business@1',%s,%s,
                    %s,%s,%s::jsonb,%s,%s)
            """,
            (tenant, intent_id, alert_id,
             body.recipient_principal_id, body.destination_ref,
             body.reason, body.payload_ref, _hash(content),
             body.visibility_requirement_id, json.dumps(snapshot),
             logical_id, actor))
        dispatch_id = f"dsp_{secrets.token_urlsafe(12)}"
        await conn.execute(
            """
            INSERT INTO notification.notification_dispatch_outbox
                (tenant_id, dispatch_id, notification_intent_id,
                 logical_dispatch_id, attempt_number)
            VALUES (%s,%s,%s,%s,1)
            """,
            (tenant, dispatch_id, intent_id,
             f"dispatch:{intent_id}:1"))
        await record_audit_event(
            conn, tenant, action="notification.intent.created",
            actor_kind="principal", actor_id=actor,
            subject_type="alert", subject_id=alert_id,
            detail={"intent_id": intent_id, "reason": body.reason})
        await conn.commit()
    return {"notification_intent_id": intent_id,
            "dispatch_id": dispatch_id}


@router.get("/notifications")
async def list_notifications(request: Request,
                             tenant_id: str | None = None,
                             limit: int = 50) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT i.notification_intent_id, i.alert_id, i.reason,
                   i.destination_ref, i.created_at,
                   p.current_state, p.attempt_count,
                   p.retry_required, p.fallback_action_required,
                   (SELECT MIN(o.next_attempt_at)
                      FROM notification.notification_dispatch_outbox o
                     WHERE o.notification_intent_id
                           = i.notification_intent_id
                       AND o.state = 'pending') AS next_attempt_at
              FROM notification.notification_intent i
              LEFT JOIN notification.notification_projection p
                ON p.tenant_id = i.tenant_id
               AND p.notification_intent_id = i.notification_intent_id
             ORDER BY i.created_at DESC LIMIT %s
            """, (min(limit, 200),))
        cols = [d.name for d in cur.description]
        rows = []
        for r in await cur.fetchall():
            row = dict(zip(cols, r))
            row["created_at"] = row["created_at"].isoformat()
            if row["next_attempt_at"]:
                row["next_attempt_at"] = (
                    row["next_attempt_at"].isoformat())
            rows.append(row)
        return rows


@router.get("/notifications/{intent_id}")
async def notification_detail(intent_id: str, request: Request,
                              tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT notification_intent_id, alert_id, reason,
                   destination_ref, channel_class,
                   visibility_requirement_id, created_at
              FROM notification.notification_intent
             WHERE notification_intent_id=%s
            """, (intent_id,))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404,
                                detail="intent not found")
        cols = [d.name for d in cur.description]
        intent = dict(zip(cols, row))
        intent["created_at"] = intent["created_at"].isoformat()

        cur = await conn.execute(
            """
            SELECT notification_attempt_id, attempt_number, outcome,
                   provider_message_ref, failure_class, started_at,
                   completed_at
              FROM notification.notification_attempt
             WHERE notification_intent_id=%s ORDER BY attempt_number
            """, (intent_id,))
        cols = [d.name for d in cur.description]
        attempts = [dict(zip(cols, r)) for r in await cur.fetchall()]
        for a in attempts:
            for k in ("started_at", "completed_at"):
                if a[k]:
                    a[k] = a[k].isoformat()

        cur = await conn.execute(
            """
            SELECT notification_evidence_id, normalized_state,
                   provider_callback_id, observed_at
              FROM notification.notification_provider_evidence
             WHERE notification_intent_id=%s ORDER BY observed_at
            """, (intent_id,))
        cols = [d.name for d in cur.description]
        evidence = [dict(zip(cols, r)) for r in await cur.fetchall()]
        for e in evidence:
            e["observed_at"] = e["observed_at"].isoformat()

        cur = await conn.execute(
            """
            SELECT current_state, attempt_count, delivered_at,
                   external_read_observed_at, retry_required,
                   fallback_action_required, projection_revision
              FROM notification.notification_projection
             WHERE notification_intent_id=%s
            """, (intent_id,))
        prow = await cur.fetchone()
        projection = None
        if prow:
            projection = {
                "current_state": prow[0], "attempt_count": prow[1],
                "delivered_at": prow[2].isoformat() if prow[2] else None,
                "external_read_observed_at":
                    prow[3].isoformat() if prow[3] else None,
                "retry_required": prow[4],
                "fallback_action_required": prow[5],
                "revision": prow[6]}

        # Retry policy surface — operators can see the budget and the
        # next scheduled dispatch without reading the outbox directly.
        from shared import notification as notif
        cur = await conn.execute(
            """
            SELECT next_attempt_at
              FROM notification.notification_dispatch_outbox
             WHERE notification_intent_id=%s AND state='pending'
             ORDER BY next_attempt_at LIMIT 1
            """, (intent_id,))
        nrow = await cur.fetchone()
        retry_policy = {
            "adapter_version": notif.ADAPTER_VERSION,
            "max_attempts": notif.MAX_ATTEMPTS,
            "backoff_seconds_per_attempt": 30,
            "next_attempt_at":
                nrow[0].isoformat() if nrow else None}
    return {"intent": intent, "attempts": attempts,
            "evidence": evidence, "projection": projection,
            "retry_policy": retry_policy}


# ---------------------------------------------------------------------------
# Provider callback — external boundary, HMAC-verified, deduped
# ---------------------------------------------------------------------------


_CALLBACK_SECRET = os.environ.get("NOTIFICATION_CALLBACK_SECRET",
                                 "dev-callback-secret")
# Signed-payload timestamps older than this are rejected — the
# timestamp is inside the HMAC'd body so a captured callback cannot
# be freshened without the secret.
_REPLAY_WINDOW_SECONDS = int(
    os.environ.get("NOTIFICATION_CALLBACK_REPLAY_WINDOW", "600"))


@router.post("/notifications/callback", include_in_schema=False)
async def provider_callback(request: Request) -> dict:
    """WhatsApp-style status callback. Authenticity = HMAC-SHA256
    over the raw body. Tenant routing comes from trusted config —
    never from payload assertion. Unbindable callbacks -> poisoned.
    """
    raw = await request.body()
    sig = request.headers.get("x-provider-signature", "")
    expected = hmac.new(_CALLBACK_SECRET.encode(), raw,
                        hashlib.sha256).hexdigest()
    if not hmac.compare_digest(sig, expected):
        raise HTTPException(status_code=401,
                            detail="invalid callback signature")
    payload = json.loads(raw.decode())
    # Dev callback shape: {callback_id, provider_message_ref,
    #                      status: sent|delivered|read|failed,
    #                      timestamp: epoch-seconds (optional)}
    callback_id = payload.get("callback_id")
    provider_ref = payload.get("provider_message_ref")
    cb_ts = payload.get("timestamp")
    import time as _time
    from shared import notification as _notif
    expired = (cb_ts is not None
               and _notif.callback_timestamp_expired(
                   cb_ts, now=_time.time(),
                   window=_REPLAY_WINDOW_SECONDS))
    status_map = {"sent": "provider_accepted",
                  "delivered": "delivered",
                  "read": "external_read_observed",
                  "failed": "failed"}
    norm = status_map.get(payload.get("status"), "unknown")
    digest = hashlib.sha256(raw).hexdigest()
    tenant = os.environ.get("NOTIFICATION_CALLBACK_TENANT",
                            "tenant:dev")
    envelope = {"callback_id": callback_id,
                "provider_message_ref": provider_ref,
                "status": payload.get("status")}

    import asyncio

    import psycopg
    from shared import notification as notif
    from shared.config import settings

    def _ingest() -> str:
        """Sync psycopg in a thread — shares the worker's
        notification helpers (dedup + monotonic reconcile)."""
        with psycopg.connect(settings.db_dsn,
                             autocommit=False) as conn:
            conn.execute(
                "SELECT set_config('jlmirror.tenant_id', %s, false)",
                (tenant,))
            # Bind by provider message ref — an evidence lookup
            # key, never platform identity.
            intent_id = None
            if provider_ref:
                cur = conn.execute(
                    """
                    SELECT notification_intent_id
                      FROM notification.notification_attempt
                     WHERE tenant_id=%s AND provider_message_ref=%s
                     ORDER BY attempt_number DESC LIMIT 1
                    """, (tenant, provider_ref))
                row = cur.fetchone()
                intent_id = row[0] if row else None
            if expired:
                state, err_class = "poisoned", "replay_window_expired"
            else:
                state = "processed" if intent_id else "poisoned"
                err_class = None if intent_id else "unbindable_callback"
            cur = conn.execute(
                """
                INSERT INTO notification.notification_callback_inbox
                    (tenant_id, callback_inbox_id, callback_digest,
                     notification_intent_id, provider_callback_id,
                     normalized_state, state, raw_envelope,
                     last_error_class, processed_at)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s,
                        transaction_timestamp())
                ON CONFLICT (tenant_id, callback_digest) DO NOTHING
                RETURNING callback_inbox_id
                """,
                (tenant, f"cbi_{secrets.token_urlsafe(12)}", digest,
                 intent_id, callback_id, norm, state,
                 json.dumps(envelope), err_class))
            if cur.fetchone() is None:
                conn.commit()
                return "duplicate"          # replayed callback
            if intent_id and not expired:
                notif.record_evidence(
                    conn, tenant_id=tenant, intent_id=intent_id,
                    normalized_state=norm,
                    provider_callback_id=callback_id,
                    provider_message_ref=provider_ref,
                    raw_envelope=envelope)
            conn.commit()
            return "expired" if expired else state

    state = await asyncio.to_thread(_ingest)
    if state == "expired":
        raise HTTPException(status_code=400,
                            detail="callback outside replay window")
    return {"state": state}
