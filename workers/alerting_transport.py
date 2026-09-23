"""G6 Monitoring -> Alerting transport consumer
(authorization: g6.monitoring-alerting-transport@1).

Consumes the two accepted integration events from the durable
outbox, dedupes through create-or-observe inbox receipts, re-reads
the canonical Monitoring owner state and durably completes the
invalidation resync responsibility.

This worker NEVER creates/resolves/reopens Alerts and never
evaluates policy — event arrival has no Alert authority. The only
effect is the durable resync responsibility.

    receive -> validate envelope/contract/producer
    -> create-or-observe receipt (equivalence fail-closed)
    -> claim -> re-read Monitoring owner projection
    -> complete with resync_result_class
"""

from __future__ import annotations

import hashlib
import json
import logging
import secrets

logger = logging.getLogger("workers.alerting_transport")

CONTRACTS = (
    "monitoring.problem-state.changed",
    "monitoring.health-projection.changed",
)


def _sha(payload: bytes) -> bytes:
    return hashlib.sha256(payload).digest()


def _reread(conn, tenant_id: str, contract: str, payload: dict) -> tuple:
    """Re-read the canonical Monitoring owner state — currentness is
    decided by the owner projection, never by the event payload or
    broker order. Returns (result_class, current_revision)."""
    if contract == "monitoring.problem-state.changed":
        cur = conn.execute(
            """
            SELECT projection_revision FROM monitoring.monitoring_problem
             WHERE tenant_id = %s AND problem_id = %s
               AND monitoring_source_id = %s
               AND source_instance_generation = %s
            """,
            (tenant_id, payload.get("problem_id"),
             payload.get("monitoring_source_id"),
             payload.get("source_instance_generation")))
    else:
        cur = conn.execute(
            """
            SELECT projection_revision FROM monitoring.health_projection
             WHERE tenant_id = %s AND monitoring_resource_id = %s
               AND monitoring_source_id = %s
               AND source_instance_generation = %s
            """,
            (tenant_id, payload.get("monitoring_resource_id"),
             payload.get("monitoring_source_id"),
             payload.get("source_instance_generation")))
    row = cur.fetchone()
    if row is not None:
        claimed = payload.get("projection_revision")
        if claimed is not None and row[0] > claimed:
            return ("stale_generation", row[0])
        return ("current", row[0])
    cur = conn.execute(
        """
        SELECT 1 FROM monitoring.monitoring_source
         WHERE tenant_id = %s AND monitoring_source_id = %s
        """,
        (tenant_id, payload.get("monitoring_source_id")))
    return (("source_missing" if cur.fetchone() is None
             else "projection_missing"), None)


def _process_message(conn, msg: dict) -> str:
    """Process one delivered outbox message through the inbox law.
    Returns the receipt state reached."""
    tenant_id = msg["tenant_id"]
    try:
        payload = json.loads(msg["encoded_payload"].tobytes()
                             if isinstance(msg["encoded_payload"], memoryview)
                             else msg["encoded_payload"])
    except Exception:
        payload = {}
    payload_hash = _sha(bytes(msg["encoded_payload"]))

    # Envelope validation — exact contract/version/producer/scope.
    if (msg["contract_name"] not in CONTRACTS
            or msg["contract_version"] != "1"
            or msg["message_class"] != "integration_event"
            or msg["producer"].lower() != "monitoring"):
        conn.execute(
            """
            INSERT INTO alerting.inbox_receipt
                (tenant_id, producer_message_scope, message_id,
                 contract_name, contract_version, producer,
                 correlation_id, causation_id, payload_hash, payload,
                 state, last_error_class)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb,
                    'quarantined', 'envelope_invalid')
            ON CONFLICT (tenant_id, producer_message_scope, message_id)
            DO NOTHING
            """,
            (tenant_id, msg["producer_message_scope"], msg["message_id"],
             msg["contract_name"], msg["contract_version"], msg["producer"],
             msg["correlation_id"], msg["causation_id"], payload_hash,
             json.dumps(payload)))
        conn.commit()
        return "quarantined"

    # Create-or-observe the receipt; same identity + same meaning is
    # ONE receipt — duplicate delivery never duplicates responsibility.
    cur = conn.execute(
        """
        INSERT INTO alerting.inbox_receipt
            (tenant_id, producer_message_scope, message_id,
             contract_name, contract_version, producer,
             correlation_id, causation_id, payload_hash, payload)
        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s::jsonb)
        ON CONFLICT (tenant_id, producer_message_scope, message_id)
        DO NOTHING
        RETURNING message_id
        """,
        (tenant_id, msg["producer_message_scope"], msg["message_id"],
         msg["contract_name"], msg["contract_version"], msg["producer"],
         msg["correlation_id"], msg["causation_id"], payload_hash,
         json.dumps(payload)))
    if cur.fetchone() is None:
        # Existing receipt — equivalence check, fail closed on
        # same identity + different immutable meaning.
        cur = conn.execute(
            """
            SELECT payload_hash, state FROM alerting.inbox_receipt
             WHERE tenant_id = %s AND producer_message_scope = %s
               AND message_id = %s
            """,
            (tenant_id, msg["producer_message_scope"], msg["message_id"]))
        existing = cur.fetchone()
        if existing[0] != payload_hash:
            conn.execute(
                """
                UPDATE alerting.inbox_receipt
                   SET state = 'quarantined',
                       last_error_class = 'inbox.identity_conflict'
                 WHERE tenant_id = %s AND producer_message_scope = %s
                   AND message_id = %s
                """,
                (tenant_id, msg["producer_message_scope"],
                 msg["message_id"]))
            conn.commit()
            logger.warning("inbox identity conflict: %s", msg["message_id"])
            return "quarantined"
        if existing[1] in ("completed", "quarantined"):
            conn.commit()
            return existing[1]  # duplicate delivery — nothing new
        state = existing[1]
    else:
        state = "received"

    # Claim (bounded: token + staleness makes restart safe).
    token = secrets.token_urlsafe(12)
    cur = conn.execute(
        """
        UPDATE alerting.inbox_receipt
           SET state = 'processing', claim_token = %s,
               claimed_at = transaction_timestamp()
         WHERE tenant_id = %s AND producer_message_scope = %s
           AND message_id = %s AND state = %s
        """,
        (token, tenant_id, msg["producer_message_scope"],
         msg["message_id"], state))
    if cur.rowcount != 1:
        conn.rollback()
        return "claimed_elsewhere"

    result_class, revision = _reread(
        conn, tenant_id, msg["contract_name"], payload)
    conn.execute(
        """
        UPDATE alerting.inbox_receipt
           SET state = 'completed', resync_result_class = %s,
               source_revision_current = %s, claim_token = NULL,
               completed_at = transaction_timestamp()
         WHERE tenant_id = %s AND producer_message_scope = %s
           AND message_id = %s AND claim_token = %s
        """,
        (result_class, revision, tenant_id,
         msg["producer_message_scope"], msg["message_id"], token))
    conn.commit()
    return "completed"


def _process_pending(conn) -> int:
    """Scan delivered outbox messages for the two contracts and drive
    each through the inbox law. Returns messages processed."""
    cur = conn.execute(
        """
        SELECT o.tenant_id, o.message_id, o.producer_message_scope,
               o.message_class, o.contract_name, o.contract_version,
               o.producer, o.correlation_id, o.causation_id,
               o.encoded_payload
          FROM monitoring.monitoring_outbox o
          LEFT JOIN alerting.inbox_receipt r
            ON r.tenant_id = o.tenant_id
           AND r.producer_message_scope = o.producer_message_scope
           AND r.message_id = o.message_id
         WHERE o.dispatch_state = 'published'
           AND o.contract_name IN
               ('monitoring.problem-state.changed',
                'monitoring.health-projection.changed')
           AND (r.message_id IS NULL
                OR r.state IN ('received', 'processing',
                               'reconciliation_required'))
         ORDER BY o.record_id
         LIMIT 50
        """)
    keys = ("tenant_id", "message_id", "producer_message_scope",
            "message_class", "contract_name", "contract_version",
            "producer", "correlation_id", "causation_id",
            "encoded_payload")
    processed = 0
    for row in cur.fetchall():
        msg = dict(zip(keys, row))
        try:
            state = _process_message(conn, msg)
            logger.info("inbox %s -> %s", msg["message_id"][:20], state)
            processed += 1
        except Exception:
            conn.rollback()
            logger.exception("inbox processing failed: %s",
                             msg["message_id"][:20])
            conn.execute(
                """
                UPDATE alerting.inbox_receipt
                   SET state = 'reconciliation_required',
                       last_error_class = 'consumer.error',
                       claim_token = NULL
                 WHERE tenant_id = %s AND producer_message_scope = %s
                   AND message_id = %s
                """,
                (msg["tenant_id"], msg["producer_message_scope"],
                 msg["message_id"]))
            conn.commit()
            processed += 1
    return processed
