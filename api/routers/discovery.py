"""Discovery router — auto-discovery de dispositivos via ping/SNMP/port scan."""

from __future__ import annotations

import json
from typing import Optional

from fastapi import APIRouter, HTTPException, Query, Request, status
from pydantic import BaseModel

from shared.access import _require_ctx, _require_operate
from shared.audit import record_audit_event
from shared.db import db_connection

router = APIRouter(prefix="/api/v1/discovery", tags=["discovery"])

_SCAN_TYPES = ("ping", "snmp", "ping+snmp", "port")
_SNMP_VERSIONS = ("v1", "v2c", "v3")
_STATUSES = ("idle", "running", "completed", "failed", "cancelled")


def _ser(row) -> dict:
    out = dict(row)
    for k, v in out.items():
        if hasattr(v, "isoformat"):
            out[k] = v.isoformat()
    return out


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

class SessionCreate(BaseModel):
    name: str
    description: str | None = None
    scan_type: str = "ping+snmp"
    cidr_ranges: list[str] = []
    snmp_community: str = "public"
    snmp_version: str = "v2c"
    snmp_port: int = 161
    snmp_timeout_ms: int = 2000
    snmp_retries: int = 1
    probe_ports: list[int] = []
    enabled: bool = True


class SessionUpdate(BaseModel):
    name: str | None = None
    description: str | None = None
    scan_type: str | None = None
    cidr_ranges: list[str] | None = None
    snmp_community: str | None = None
    snmp_version: str | None = None
    snmp_port: int | None = None
    snmp_timeout_ms: int | None = None
    snmp_retries: int | None = None
    probe_ports: list[int] | None = None
    enabled: bool | None = None


@router.get("/sessions")
async def list_sessions(request: Request):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT s.session_id, s.name, s.description, s.scan_type,
                   s.cidr_ranges, s.snmp_community, s.snmp_version, s.snmp_port,
                   s.snmp_timeout_ms, s.snmp_retries, s.probe_ports,
                   s.status, s.last_scan_at, s.last_scan_duration_s,
                   s.discovered_count, s.enabled, s.created_at,
                   LATERAL (
                       SELECT log_id, status AS log_status, total_scanned,
                              new_devices, updated_devices, started_at, finished_at
                       FROM g1.discovery_scan_log
                       WHERE session_id = s.session_id
                       ORDER BY created_at DESC LIMIT 1
                   ) last_scan ON TRUE
            FROM g1.discovery_session s
            WHERE s.tenant_id = %s
            ORDER BY s.created_at DESC
            """,
            (tid,),
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]
    return [_ser(dict(zip(cols, r))) for r in rows]


@router.get("/sessions")
async def list_sessions_simple(request: Request):
    # fallback without LATERAL (called if DB doesn't support it inline)
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT session_id, name, description, scan_type,
                   cidr_ranges, snmp_version, snmp_port,
                   status, last_scan_at, last_scan_duration_s,
                   discovered_count, enabled, created_at
            FROM g1.discovery_session
            WHERE tenant_id = %s
            ORDER BY created_at DESC
            """,
            (tid,),
        )
        rows = await cur.fetchall()
        cols = [d[0] for d in cur.description]

        # get last scan per session
        result = []
        for row in rows:
            d = _ser(dict(zip(cols, row)))
            cur2 = await conn.execute(
                """
                SELECT log_id, status AS log_status, total_scanned,
                       new_devices, updated_devices, started_at, finished_at
                FROM g1.discovery_scan_log
                WHERE session_id = %s
                ORDER BY created_at DESC LIMIT 1
                """,
                (d["session_id"],),
            )
            lrow = await cur2.fetchone()
            if lrow:
                lcols = [x[0] for x in cur2.description]
                d["last_scan"] = _ser(dict(zip(lcols, lrow)))
            else:
                d["last_scan"] = None
            result.append(d)
    return result


@router.post("/sessions", status_code=status.HTTP_201_CREATED)
async def create_session(body: SessionCreate, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    if body.scan_type not in _SCAN_TYPES:
        raise HTTPException(400, f"scan_type inválido: {body.scan_type}")
    if body.snmp_version not in _SNMP_VERSIONS:
        raise HTTPException(400, f"snmp_version inválida: {body.snmp_version}")
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            INSERT INTO g1.discovery_session
              (tenant_id, name, description, scan_type, cidr_ranges,
               snmp_community, snmp_version, snmp_port, snmp_timeout_ms,
               snmp_retries, probe_ports, enabled, created_by)
            VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)
            RETURNING session_id
            """,
            (tid, body.name, body.description, body.scan_type, body.cidr_ranges,
             body.snmp_community, body.snmp_version, body.snmp_port,
             body.snmp_timeout_ms, body.snmp_retries, body.probe_ports,
             body.enabled, actor),
        )
        row = await cur.fetchone()
        session_id = str(row[0])
        await record_audit_event(conn, tid, actor, "discovery_session.created", session_id, {"name": body.name})
        await conn.commit()
    return {"session_id": session_id}


@router.put("/sessions/{session_id}")
async def update_session(session_id: str, body: SessionUpdate, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    updates: list[str] = []
    vals: list = []
    for field, col in [
        ("name", "name"), ("description", "description"), ("scan_type", "scan_type"),
        ("cidr_ranges", "cidr_ranges"), ("snmp_community", "snmp_community"),
        ("snmp_version", "snmp_version"), ("snmp_port", "snmp_port"),
        ("snmp_timeout_ms", "snmp_timeout_ms"), ("snmp_retries", "snmp_retries"),
        ("probe_ports", "probe_ports"), ("enabled", "enabled"),
    ]:
        v = getattr(body, field)
        if v is not None:
            updates.append(f"{col} = %s")
            vals.append(v)
    if not updates:
        raise HTTPException(400, "nenhum campo para atualizar")
    vals.extend([session_id, tid])
    async with db_connection() as conn:
        cur = await conn.execute(
            f"UPDATE g1.discovery_session SET {', '.join(updates)} WHERE session_id = %s AND tenant_id = %s RETURNING session_id",
            vals,
        )
        if not await cur.fetchone():
            raise HTTPException(404, "sessão não encontrada")
        await record_audit_event(conn, tid, actor, "discovery_session.updated", session_id, {})
        await conn.commit()
    return {"ok": True}


@router.delete("/sessions/{session_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_session(session_id: str, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            "DELETE FROM g1.discovery_session WHERE session_id = %s AND tenant_id = %s RETURNING session_id",
            (session_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "sessão não encontrada")
        await record_audit_event(conn, tid, actor, "discovery_session.deleted", session_id, {})
        await conn.commit()


# ---------------------------------------------------------------------------
# Scan trigger & log
# ---------------------------------------------------------------------------

@router.post("/sessions/{session_id}/scan", status_code=status.HTTP_201_CREATED)
async def trigger_scan(session_id: str, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT cidr_ranges, status FROM g1.discovery_session WHERE session_id = %s AND tenant_id = %s",
            (session_id, tid),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "sessão não encontrada")
        cidr_ranges, cur_status = row[0], row[1]
        if cur_status == "running":
            raise HTTPException(409, "scan já em execução para esta sessão")

        cur2 = await conn.execute(
            """
            INSERT INTO g1.discovery_scan_log
              (session_id, tenant_id, status, triggered_by, cidr_ranges)
            VALUES (%s, %s, 'running', %s, %s)
            RETURNING log_id
            """,
            (session_id, tid, actor, cidr_ranges),
        )
        lrow = await cur2.fetchone()
        log_id = str(lrow[0])
        await conn.execute(
            "UPDATE g1.discovery_session SET status = 'running' WHERE session_id = %s",
            (session_id,),
        )
        await record_audit_event(conn, tid, actor, "discovery_session.scan_triggered", session_id,
                                 {"log_id": log_id, "cidr_ranges": cidr_ranges})
        await conn.commit()
    return {"log_id": log_id}


class ScanLogUpdate(BaseModel):
    status: str
    total_scanned: int | None = None
    new_devices: int | None = None
    updated_devices: int | None = None
    error_message: str | None = None
    duration_s: int | None = None


@router.put("/scan-logs/{log_id}")
async def update_scan_log(log_id: str, body: ScanLogUpdate, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    if body.status not in ("completed", "failed", "cancelled"):
        raise HTTPException(400, f"status inválido: {body.status}")
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT session_id FROM g1.discovery_scan_log WHERE log_id = %s AND tenant_id = %s",
            (log_id, tid),
        )
        row = await cur.fetchone()
        if not row:
            raise HTTPException(404, "log não encontrado")
        session_id = str(row[0])
        await conn.execute(
            """
            UPDATE g1.discovery_scan_log
            SET status = %s, total_scanned = %s, new_devices = %s,
                updated_devices = %s, error_message = %s, finished_at = now()
            WHERE log_id = %s
            """,
            (body.status, body.total_scanned, body.new_devices,
             body.updated_devices, body.error_message, log_id),
        )
        new_session_status = "completed" if body.status == "completed" else ("failed" if body.status == "failed" else "idle")
        updates = ["status = %s", "last_scan_at = now()"]
        vals: list = [new_session_status]
        if body.duration_s is not None:
            updates.append("last_scan_duration_s = %s")
            vals.append(body.duration_s)
        if body.new_devices is not None:
            updates.append("discovered_count = discovered_count + %s")
            vals.append(body.new_devices)
        vals.append(session_id)
        await conn.execute(
            f"UPDATE g1.discovery_session SET {', '.join(updates)} WHERE session_id = %s",
            vals,
        )
        await conn.commit()
    return {"ok": True}


@router.get("/sessions/{session_id}/scan-logs")
async def list_scan_logs(session_id: str, request: Request, limit: int = 20):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT session_id FROM g1.discovery_session WHERE session_id = %s AND tenant_id = %s",
            (session_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "sessão não encontrada")
        cur2 = await conn.execute(
            """
            SELECT log_id, status, triggered_by, total_scanned, new_devices,
                   updated_devices, error_message, started_at, finished_at, created_at,
                   EXTRACT(EPOCH FROM (COALESCE(finished_at, now()) - started_at))::INT AS duration_s
            FROM g1.discovery_scan_log
            WHERE session_id = %s
            ORDER BY created_at DESC
            LIMIT %s
            """,
            (session_id, min(limit, 100)),
        )
        rows = await cur2.fetchall()
        cols = [d[0] for d in cur2.description]
    return [_ser(dict(zip(cols, r))) for r in rows]


# ---------------------------------------------------------------------------
# Results — bulk upsert (worker) + list + mark imported
# ---------------------------------------------------------------------------

class ResultItem(BaseModel):
    ip_address: str
    mac_address: str | None = None
    hostname: str | None = None
    sys_name: str | None = None
    sys_descr: str | None = None
    sys_object_id: str | None = None
    sys_location: str | None = None
    sys_contact: str | None = None
    device_type: str | None = None
    os_hint: str | None = None
    open_ports: list[int] = []
    snmp_reachable: bool = False
    ping_rtt_ms: float | None = None
    scan_log_id: str | None = None


class BulkResultsBody(BaseModel):
    results: list[ResultItem]


@router.post("/sessions/{session_id}/results", status_code=status.HTTP_201_CREATED)
async def bulk_upsert_results(session_id: str, body: BulkResultsBody, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    if not body.results:
        return {"upserted": 0}
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT session_id FROM g1.discovery_session WHERE session_id = %s AND tenant_id = %s",
            (session_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "sessão não encontrada")

        rows_values: list[tuple] = []
        for r in body.results:
            rows_values.append((
                session_id, tid, r.scan_log_id,
                r.ip_address, r.mac_address, r.hostname,
                r.sys_name, r.sys_descr, r.sys_object_id,
                r.sys_location, r.sys_contact,
                r.device_type, r.os_hint, r.open_ports,
                r.snmp_reachable, r.ping_rtt_ms,
            ))

        # Build parameterized bulk upsert
        placeholders = ", ".join(
            f"(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)" for _ in rows_values
        )
        flat_vals: list = [v for row in rows_values for v in row]
        await conn.execute(
            f"""
            INSERT INTO g1.discovery_result
              (session_id, tenant_id, scan_log_id,
               ip_address, mac_address, hostname,
               sys_name, sys_descr, sys_object_id,
               sys_location, sys_contact,
               device_type, os_hint, open_ports,
               snmp_reachable, ping_rtt_ms)
            VALUES {placeholders}
            ON CONFLICT (session_id, ip_address) DO UPDATE SET
              mac_address = EXCLUDED.mac_address,
              hostname = EXCLUDED.hostname,
              sys_name = EXCLUDED.sys_name,
              sys_descr = EXCLUDED.sys_descr,
              sys_object_id = EXCLUDED.sys_object_id,
              sys_location = EXCLUDED.sys_location,
              sys_contact = EXCLUDED.sys_contact,
              device_type = EXCLUDED.device_type,
              os_hint = EXCLUDED.os_hint,
              open_ports = EXCLUDED.open_ports,
              snmp_reachable = EXCLUDED.snmp_reachable,
              ping_rtt_ms = EXCLUDED.ping_rtt_ms,
              last_seen_at = now(),
              is_new = FALSE
            """,
            flat_vals,
        )
        await conn.commit()
    return {"upserted": len(body.results)}


@router.get("/sessions/{session_id}/results")
async def list_results(
    session_id: str,
    request: Request,
    snmp_only: bool = False,
    device_type: Optional[str] = None,
    imported: Optional[bool] = None,
    search: Optional[str] = Query(None),
    limit: int = 100,
):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            "SELECT session_id FROM g1.discovery_session WHERE session_id = %s AND tenant_id = %s",
            (session_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "sessão não encontrada")

        where = ["session_id = %s", "tenant_id = %s"]
        vals: list = [session_id, tid]
        if snmp_only:
            where.append("snmp_reachable = TRUE")
        if device_type:
            where.append("device_type = %s")
            vals.append(device_type)
        if imported is not None:
            where.append("imported_to_inventory = %s")
            vals.append(imported)
        if search:
            where.append("(ip_address ILIKE %s OR hostname ILIKE %s OR sys_name ILIKE %s)")
            q = f"%{search}%"
            vals.extend([q, q, q])
        vals.append(min(limit, 500))

        cur2 = await conn.execute(
            f"""
            SELECT result_id, ip_address, mac_address, hostname,
                   sys_name, sys_descr, sys_location, sys_contact,
                   device_type, os_hint, open_ports, snmp_reachable,
                   ping_rtt_ms, is_new, imported_to_inventory,
                   first_seen_at, last_seen_at
            FROM g1.discovery_result
            WHERE {' AND '.join(where)}
            ORDER BY last_seen_at DESC
            LIMIT %s
            """,
            vals,
        )
        rows = await cur2.fetchall()
        cols = [d[0] for d in cur2.description]
    return [_ser(dict(zip(cols, r))) for r in rows]


@router.post("/sessions/{session_id}/results/{result_id}/import")
async def mark_imported(session_id: str, result_id: str, request: Request):
    ctx = await _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["principal_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            UPDATE g1.discovery_result
            SET imported_to_inventory = TRUE
            WHERE result_id = %s AND session_id = %s AND tenant_id = %s
            RETURNING result_id
            """,
            (result_id, session_id, tid),
        )
        if not await cur.fetchone():
            raise HTTPException(404, "resultado não encontrado")
        await record_audit_event(conn, tid, actor, "discovery_result.imported", result_id, {})
        await conn.commit()
    return {"ok": True}


@router.get("/stats")
async def get_stats(request: Request):
    ctx = await _require_ctx(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT
              COUNT(*) FILTER (WHERE s.enabled) AS active_sessions,
              COUNT(*) FILTER (WHERE s.status = 'running') AS running_scans,
              SUM(s.discovered_count) AS total_discovered,
              (SELECT COUNT(*) FROM g1.discovery_result r WHERE r.tenant_id = %s AND r.is_new = TRUE) AS new_devices,
              (SELECT COUNT(*) FROM g1.discovery_result r WHERE r.tenant_id = %s AND r.snmp_reachable = TRUE) AS snmp_devices,
              (SELECT COUNT(*) FROM g1.discovery_result r WHERE r.tenant_id = %s AND r.imported_to_inventory = FALSE) AS pending_import
            FROM g1.discovery_session s
            WHERE s.tenant_id = %s
            """,
            (tid, tid, tid, tid),
        )
        row = await cur.fetchone()
        cols = [d[0] for d in cur.description]
    result = dict(zip(cols, row))
    for k, v in result.items():
        if v is None:
            result[k] = 0
    return result
