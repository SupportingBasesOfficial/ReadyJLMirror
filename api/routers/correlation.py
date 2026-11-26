"""Correlation router — alert grouping rules, alert groups, SSE stream."""

from __future__ import annotations

import asyncio
import hashlib
import json
from typing import AsyncIterator

from fastapi import APIRouter, HTTPException, Request, status
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from shared.access import _require_ctx, _require_operate
from shared.audit import record_audit_event
from shared.db import db_connection

router = APIRouter(prefix="/api/v1/correlation", tags=["correlation"])

_SEVERITIES = ("unknown", "informational", "warning", "degraded", "critical")
_STATUSES = ("firing", "acknowledged", "resolved")
_SEV_ORDER = {s: i for i, s in enumerate(_SEVERITIES)}


def _ser(row) -> dict:
    out = dict(row)
    for k, v in out.items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out


def _fingerprint(tenant_id: str, group_by: list[str], labels: dict) -> str:
    key = json.dumps({"t": tenant_id, "by": sorted(group_by),
                      "labels": {k: labels.get(k) for k in sorted(group_by)}},
                     sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(key.encode()).hexdigest()[:32]


# ---------------------------------------------------------------------------
# Correlation rules
# ---------------------------------------------------------------------------

class RuleCreate(BaseModel):
    name: str
    description: str | None = None
    enabled: bool = True
    match_severity: list[str] = []
    match_source_kind: str = "*"
    match_labels: dict = {}
    group_by: list[str] = []
    group_window_seconds: int = 300
    group_wait_seconds: int = 30
    auto_resolve_seconds: int | None = None


class RuleUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    enabled: bool | None = None
    match_severity: list[str] | None = None
    match_source_kind: str | None = None
    match_labels: dict | None = None
    group_by: list[str] | None = None
    group_window_seconds: int | None = None
    group_wait_seconds: int | None = None
    auto_resolve_seconds: int | None = None


@router.get("/rules")
async def list_rules(request: Request):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT rule_id, name, description, enabled,
                   match_severity, match_source_kind, match_labels,
                   group_by, group_window_seconds, group_wait_seconds,
                   auto_resolve_seconds, created_at, created_by
            FROM g1.correlation_rule
            WHERE tenant_id = %s
            ORDER BY created_at DESC
            """,
            (tid,),
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
    return [_ser(dict(zip(cols, r))) for r in rows]


@router.post("/rules", status_code=status.HTTP_201_CREATED)
async def create_rule(body: RuleCreate, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    for sev in body.match_severity:
        if sev not in _SEVERITIES:
            raise HTTPException(400, f"severity inválida: {sev}")
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.correlation_rule
              (tenant_id, name, description, enabled,
               match_severity, match_source_kind, match_labels,
               group_by, group_window_seconds, group_wait_seconds,
               auto_resolve_seconds, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING rule_id
            """,
            (tid, body.name, body.description, body.enabled,
             body.match_severity, body.match_source_kind,
             json.dumps(body.match_labels), body.group_by,
             body.group_window_seconds, body.group_wait_seconds,
             body.auto_resolve_seconds, actor),
        )
        row = await cur.fetchone()
        rule_id = str(row[0])
        await record_audit_event(conn, tid, actor, "correlation_rule.created", rule_id, {"name": body.name})
        await conn.commit()
    return {"rule_id": rule_id}


@router.put("/rules/{rule_id}")
async def update_rule(rule_id: str, body: RuleUpdate, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    updates: list[str] = []
    vals: list = []
    for field, col in [
        ("name", "name"), ("description", "description"), ("enabled", "enabled"),
        ("match_severity", "match_severity"), ("match_source_kind", "match_source_kind"),
        ("group_by", "group_by"), ("group_window_seconds", "group_window_seconds"),
        ("group_wait_seconds", "group_wait_seconds"), ("auto_resolve_seconds", "auto_resolve_seconds"),
    ]:
        v = getattr(body, field)
        if v is not None:
            updates.append(f"{col} = %s")
            vals.append(v)
    if body.match_labels is not None:
        updates.append("match_labels = %s")
        vals.append(json.dumps(body.match_labels))
    if not updates:
        raise HTTPException(400, "nenhum campo para atualizar")
    vals.extend([rule_id, tid])
    async with db_connection() as conn:
        cur = await conn.execute(
            f"UPDATE g1.correlation_rule SET {', '.join(updates)} WHERE rule_id = %s AND tenant_id = %s RETURNING rule_id",
            vals,
        )
        if not await cur.fetchone():
            raise HTTPException(404, "regra não encontrada")
        await record_audit_event(conn, tid, actor, "correlation_rule.updated", rule_id, {})
        await conn.commit()
    return {"ok": True}


@router.delete("/rules/{rule_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_rule(rule_id: str, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM g1.correlation_rule WHERE rule_id = %s AND tenant_id = %s RETURNING rule_id",
            (rule_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "regra não encontrada")
        await record_audit_event(conn, tid, actor, "correlation_rule.deleted", rule_id, {})
        await conn.commit()


# ---------------------------------------------------------------------------
# Alert groups
# ---------------------------------------------------------------------------

class GroupCreate(BaseModel):
    rule_id: str | None = None
    fingerprint: str | None = None
    severity: str = "unknown"
    labels: dict = {}
    summary: str | None = None
    group_by: list[str] = []


class MemberAdd(BaseModel):
    alert_occurrence_id: str | None = None
    alert_name: str
    host_id: str | None = None
    severity: str = "unknown"
    labels: dict = {}
    summary: str | None = None


@router.get("/alert-groups")
async def list_alert_groups(
    request: Request,
    status_filter: str | None = None,
    severity: str | None = None,
    limit: int = 50,
):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    where = ["ag.tenant_id = %s"]
    vals: list = [tid]
    if status_filter and status_filter in _STATUSES:
        where.append("ag.status = %s")
        vals.append(status_filter)
    if severity and severity in _SEVERITIES:
        where.append("ag.severity = %s")
        vals.append(severity)
    vals.append(min(limit, 200))
    async with db_connection() as conn:
        cur = await conn.execute(
            f"""
            SELECT ag.group_id, ag.rule_id, cr.name AS rule_name,
                   ag.fingerprint, ag.status, ag.severity, ag.alert_count,
                   ag.labels, ag.summary, ag.acknowledged_by, ag.acknowledged_at,
                   ag.resolved_at, ag.first_fired_at, ag.last_updated_at
            FROM g1.alert_group ag
            LEFT JOIN g1.correlation_rule cr ON cr.rule_id = ag.rule_id
            WHERE {' AND '.join(where)}
            ORDER BY ag.last_updated_at DESC
            LIMIT %s
            """,
            vals,
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
    return [_ser(dict(zip(cols, r))) for r in rows]


@router.post("/alert-groups", status_code=status.HTTP_201_CREATED)
async def create_alert_group(body: GroupCreate, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    if body.severity not in _SEVERITIES:
        raise HTTPException(400, f"severity inválida: {body.severity}")
    fp = body.fingerprint or _fingerprint(tid, body.group_by, body.labels)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.alert_group
              (tenant_id, rule_id, fingerprint, severity, labels, summary)
            VALUES (%s, %s, %s, %s, %s, %s)
            ON CONFLICT (tenant_id, fingerprint) DO UPDATE
              SET severity = EXCLUDED.severity,
                  alert_count = g1.alert_group.alert_count,
                  last_updated_at = now()
            RETURNING group_id
            """,
            (tid, body.rule_id, fp, body.severity,
             json.dumps(body.labels), body.summary),
        )
        row = await cur.fetchone()
        group_id = str(row[0])
        await record_audit_event(conn, tid, actor, "alert_group.created", group_id, {"fingerprint": fp})
        await conn.commit()
    return {"group_id": group_id, "fingerprint": fp}


@router.get("/alert-groups/{group_id}")
async def get_alert_group(group_id: str, request: Request):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT ag.group_id, ag.rule_id, cr.name AS rule_name,
                   ag.fingerprint, ag.status, ag.severity, ag.alert_count,
                   ag.labels, ag.summary, ag.acknowledged_by, ag.acknowledged_at,
                   ag.resolved_at, ag.first_fired_at, ag.last_updated_at
            FROM g1.alert_group ag
            LEFT JOIN g1.correlation_rule cr ON cr.rule_id = ag.rule_id
            WHERE ag.group_id = %s AND ag.tenant_id = %s
            """,
            (group_id, tid),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "grupo não encontrado")
        cols = [d[0] for d in cur.description]
        group = _ser(dict(zip(cols, row)))

        cur2 = await conn.execute(
            """
            SELECT member_id, alert_occurrence_id, alert_name, host_id,
                   severity, labels, summary, added_at
            FROM g1.alert_group_member
            WHERE group_id = %s
            ORDER BY added_at DESC
            LIMIT 100
            """,
            (group_id,),
        )
        mrows = await cur2.fetchall()
        mcols = [d[0] for d in cur2.description]
    group["members"] = [_ser(dict(zip(mcols, r))) for r in mrows]
    return group


@router.post("/alert-groups/{group_id}/acknowledge")
async def acknowledge_group(group_id: str, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            UPDATE g1.alert_group
            SET status = 'acknowledged', acknowledged_by = %s,
                acknowledged_at = now(), last_updated_at = now()
            WHERE group_id = %s AND tenant_id = %s AND status = 'firing'
            RETURNING group_id
            """,
            (actor, group_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "grupo não encontrado ou já não está firing")
        await record_audit_event(conn, tid, actor, "alert_group.acknowledged", group_id, {})
        await conn.commit()
    return {"ok": True}


@router.post("/alert-groups/{group_id}/resolve")
async def resolve_group(group_id: str, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            UPDATE g1.alert_group
            SET status = 'resolved', resolved_at = now(), last_updated_at = now()
            WHERE group_id = %s AND tenant_id = %s AND status != 'resolved'
            RETURNING group_id
            """,
            (group_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "grupo não encontrado ou já resolvido")
        await record_audit_event(conn, tid, actor, "alert_group.resolved", group_id, {})
        await conn.commit()
    return {"ok": True}


@router.post("/alert-groups/{group_id}/members", status_code=status.HTTP_201_CREATED)
async def add_member(group_id: str, body: MemberAdd, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT group_id FROM g1.alert_group WHERE group_id = %s AND tenant_id = %s",
            (group_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "grupo não encontrado")
        cur2 = await conn.execute(
            """
            INSERT INTO g1.alert_group_member
              (group_id, tenant_id, alert_occurrence_id, alert_name, host_id,
               severity, labels, summary)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING member_id
            """,
            (group_id, tid, body.alert_occurrence_id, body.alert_name,
             body.host_id, body.severity, json.dumps(body.labels), body.summary),
        )
        row = await cur2.fetchone()
        member_id = str(row[0])
        # update severity and count
        await conn.execute(
            """
            UPDATE g1.alert_group
            SET alert_count = alert_count + 1,
                last_updated_at = now(),
                severity = CASE
                    WHEN %s::text = 'critical' THEN 'critical'
                    WHEN severity = 'critical' THEN 'critical'
                    WHEN %s::text = 'degraded' THEN 'degraded'
                    WHEN severity = 'degraded' THEN 'degraded'
                    WHEN %s::text = 'warning' THEN 'warning'
                    WHEN severity = 'warning' THEN 'warning'
                    ELSE severity
                END
            WHERE group_id = %s
            """,
            (body.severity, body.severity, body.severity, group_id),
        )
        await record_audit_event(conn, tid, actor, "alert_group.member_added", group_id,
                                 {"alert_name": body.alert_name, "member_id": member_id})
        await conn.commit()
    return {"member_id": member_id}


@router.get("/stats")
async def get_stats(request: Request):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT
              COUNT(*) FILTER (WHERE status = 'firing') AS firing,
              COUNT(*) FILTER (WHERE status = 'acknowledged') AS acknowledged,
              COUNT(*) FILTER (WHERE status = 'resolved' AND resolved_at > now() - INTERVAL '24h') AS resolved_24h,
              COUNT(*) FILTER (WHERE severity = 'critical' AND status != 'resolved') AS critical_active,
              COUNT(*) FILTER (WHERE first_fired_at > now() - INTERVAL '1h') AS new_last_hour,
              COUNT(*) FILTER (WHERE first_fired_at > now() - INTERVAL '24h') AS new_24h
            FROM g1.alert_group
            WHERE tenant_id = %s
            """,
            (tid,),
        )
        row = await cur.fetchone()
        cols = [d[0] for d in cur.description]
    return dict(zip(cols, row))


# ---------------------------------------------------------------------------
# SSE stream — real-time alert group events
# ---------------------------------------------------------------------------

async def _sse_generator(tid: str) -> AsyncIterator[str]:
    """Poll alert groups every 5s and stream changes via SSE."""
    seen: dict[str, str] = {}  # group_id → status:severity:count
    try:
        while True:
            async with db_connection() as conn:
                cur = await conn.execute(
                    """
                    SELECT group_id::text, status, severity, alert_count,
                           labels, summary, first_fired_at, last_updated_at
                    FROM g1.alert_group
                    WHERE tenant_id = %s AND status != 'resolved'
                      AND last_updated_at > now() - INTERVAL '1h'
                    ORDER BY last_updated_at DESC
                    LIMIT 100
                    """,
                    (tid,),
                )
                rows = await cur.fetchall()
                cols = [d[0] for d in cur.description]

            events: list[dict] = []
            current_ids: set[str] = set()
            for row in rows:
                d = _ser(dict(zip(cols, row)))
                gid = d["group_id"]
                current_ids.add(gid)
                sig = f"{d['status']}:{d['severity']}:{d['alert_count']}"
                if gid not in seen or seen[gid] != sig:
                    seen[gid] = sig
                    events.append({"type": "update", "group": d})

            # Detect resolved (disappeared from query)
            gone = set(seen.keys()) - current_ids
            for gid in gone:
                del seen[gid]
                events.append({"type": "resolved", "group_id": gid})

            for ev in events:
                yield f"data: {json.dumps(ev)}\n\n"

            yield ": heartbeat\n\n"
            await asyncio.sleep(5)
    except asyncio.CancelledError:
        pass


@router.get("/stream")
async def stream_alert_groups(request: Request):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]

    async def _gen():
        async for chunk in _sse_generator(tid):
            if await request.is_disconnected():
                break
            yield chunk

    return StreamingResponse(
        _gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )
