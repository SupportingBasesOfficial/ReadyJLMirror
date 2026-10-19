"""G37 Synthetic monitoring — HTTP health checks."""

from __future__ import annotations

import ipaddress
import secrets
import socket
import time
from urllib.parse import urlparse

import httpx
from fastapi import APIRouter, HTTPException, Request, status
from pydantic import BaseModel

from api.routers.monitoring import _authoritative_tenant
from shared.db import db_tenant_connection

router = APIRouter(prefix="/api/v1/synthetic", tags=["synthetic"])

_METHODS = ("GET", "HEAD", "POST")
_MAX_INTERVAL = 86400  # 24 h
_MIN_INTERVAL = 30     # 30 s
_MAX_TIMEOUT = 30


class CheckCreate(BaseModel):
    name: str
    url: str
    method: str = "GET"
    expected_status: int = 200
    timeout_seconds: int = 10
    interval_seconds: int = 300
    headers: dict[str, str] | None = None
    enabled: bool = True


class CheckUpdate(BaseModel):
    name: str | None = None
    url: str | None = None
    method: str | None = None
    expected_status: int | None = None
    timeout_seconds: int | None = None
    interval_seconds: int | None = None
    headers: dict[str, str] | None = None
    enabled: bool | None = None


def _assert_external_url(url: str) -> None:
    """Raise 422 if *url* targets a private, loopback, or link-local address.

    Blocks:
    - Loopback: 127.0.0.0/8, ::1
    - Link-local / cloud metadata: 169.254.0.0/16, fe80::/10
    - RFC-1918 private: 10/8, 172.16/12, 192.168/16
    - Single-label hostnames (Docker service names like 'api', 'db', 'keycloak')
    - Literal IP addresses that fall in the above ranges

    DNS is resolved at validation time (fail-closed: DNS error → rejected).
    """
    try:
        parsed = urlparse(url)
        host = parsed.hostname or ""
    except Exception:
        raise HTTPException(status_code=422, detail="url is malformed")

    if not host:
        raise HTTPException(status_code=422, detail="url missing host")

    # Single-label hostname = internal Docker service (no dots)
    if "." not in host:
        raise HTTPException(
            status_code=422,
            detail="url must point to a publicly reachable host",
        )

    # Literal IP address check
    try:
        addr = ipaddress.ip_address(host)
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
            raise HTTPException(
                status_code=422,
                detail="url must point to a publicly reachable host",
            )
        return  # public IP literal — OK
    except ValueError:
        pass  # not an IP literal; proceed to DNS check

    # DNS resolution — fail-closed: if DNS fails we reject
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except Exception:
        raise HTTPException(
            status_code=422,
            detail="url host could not be resolved",
        )

    for info in infos:
        ip_str = info[4][0]
        try:
            addr = ipaddress.ip_address(ip_str)
            if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
                raise HTTPException(
                    status_code=422,
                    detail="url must point to a publicly reachable host",
                )
        except ValueError:
            pass


def _validate_check(name: str, url: str, method: str,
                    expected_status: int, timeout: int, interval: int) -> None:
    if not name.strip():
        raise HTTPException(status_code=422, detail="name required")
    if not url.strip().startswith(("http://", "https://")):
        raise HTTPException(status_code=422,
                            detail="url must start with http:// or https://")
    _assert_external_url(url)
    if method not in _METHODS:
        raise HTTPException(status_code=422,
                            detail=f"method must be one of {_METHODS}")
    if not (100 <= expected_status <= 599):
        raise HTTPException(status_code=422,
                            detail="expected_status must be 100-599")
    if not (1 <= timeout <= _MAX_TIMEOUT):
        raise HTTPException(status_code=422,
                            detail=f"timeout_seconds must be 1-{_MAX_TIMEOUT}")
    if not (_MIN_INTERVAL <= interval <= _MAX_INTERVAL):
        raise HTTPException(
            status_code=422,
            detail=f"interval_seconds must be {_MIN_INTERVAL}-{_MAX_INTERVAL}")


@router.get("/checks")
async def list_checks(request: Request,
                      tenant_id: str | None = None) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT check_id, name, check_type, url, method,
                   expected_status, timeout_seconds, interval_seconds,
                   enabled, last_checked_at, last_ok,
                   last_status_code, last_response_ms, last_error,
                   created_at
              FROM monitoring.synthetic_check
             WHERE tenant_id = %s
             ORDER BY created_at DESC
            """, (tenant,))
        cols = [d.name for d in cur.description]
        rows = []
        for r in await cur.fetchall():
            row = dict(zip(cols, r))
            for ts in ("last_checked_at", "created_at"):
                if row[ts]:
                    row[ts] = row[ts].isoformat()
            rows.append(row)
        return rows


@router.post("/checks", status_code=status.HTTP_201_CREATED)
async def create_check(request: Request, body: CheckCreate,
                       tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    _validate_check(body.name, body.url, body.method, body.expected_status,
                    body.timeout_seconds, body.interval_seconds)
    check_id = f"synchk_{secrets.token_urlsafe(10)}"
    import json
    headers_json = json.dumps(body.headers) if body.headers else None
    async with db_tenant_connection(tenant) as conn:
        try:
            cur = await conn.execute(
                """
                INSERT INTO monitoring.synthetic_check
                    (check_id, tenant_id, name, url, method,
                     expected_status, timeout_seconds, interval_seconds,
                     headers, enabled)
                VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb,%s)
                RETURNING check_id, name, url, method, enabled, created_at
                """,
                (check_id, tenant, body.name.strip(), body.url.strip(),
                 body.method, body.expected_status, body.timeout_seconds,
                 body.interval_seconds, headers_json, body.enabled))
            row = await cur.fetchone()
            await conn.commit()
        except Exception as exc:
            if "unique" in str(exc).lower():
                raise HTTPException(status_code=409,
                                    detail="check name already exists")
            raise
    return {"check_id": row[0], "name": row[1], "url": row[2],
            "method": row[3], "enabled": row[4],
            "created_at": row[5].isoformat()}


@router.patch("/checks/{check_id}")
async def update_check(check_id: str, request: Request, body: CheckUpdate,
                       tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT name, url, method, expected_status,
                   timeout_seconds, interval_seconds, enabled
              FROM monitoring.synthetic_check
             WHERE tenant_id = %s AND check_id = %s
            """, (tenant, check_id))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="check not found")
        name, url, method, exp_st, timeout, interval, enabled = row

        name = body.name.strip() if body.name is not None else name
        url = body.url.strip() if body.url is not None else url
        method = body.method if body.method is not None else method
        exp_st = body.expected_status if body.expected_status is not None else exp_st
        timeout = body.timeout_seconds if body.timeout_seconds is not None else timeout
        interval = body.interval_seconds if body.interval_seconds is not None else interval
        enabled = body.enabled if body.enabled is not None else enabled
        _validate_check(name, url, method, exp_st, timeout, interval)

        import json as _json
        headers_json = (_json.dumps(body.headers)
                        if body.headers is not None else None)
        set_headers = "headers = %s::jsonb," if body.headers is not None else ""
        params = ([headers_json] if body.headers is not None else []) + [
            name, url, method, exp_st, timeout, interval, enabled,
            tenant, check_id]
        await conn.execute(
            f"""
            UPDATE monitoring.synthetic_check
               SET {set_headers}
                   name = %s, url = %s, method = %s,
                   expected_status = %s, timeout_seconds = %s,
                   interval_seconds = %s, enabled = %s,
                   updated_at = now()
             WHERE tenant_id = %s AND check_id = %s
            """, params)
        await conn.commit()
    return {"ok": True}


@router.delete("/checks/{check_id}", status_code=status.HTTP_200_OK)
async def delete_check(check_id: str, request: Request,
                       tenant_id: str | None = None) -> dict:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            "DELETE FROM monitoring.synthetic_check "
            "WHERE tenant_id=%s AND check_id=%s RETURNING check_id",
            (tenant, check_id))
        if await cur.fetchone() is None:
            raise HTTPException(status_code=404, detail="check not found")
        await conn.commit()
    return {"ok": True}


@router.get("/checks/{check_id}/results")
async def get_results(check_id: str, request: Request,
                      limit: int = 50,
                      tenant_id: str | None = None) -> list[dict]:
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT result_id, checked_at, ok, status_code,
                   response_ms, error
              FROM monitoring.synthetic_result
             WHERE check_id = %s AND tenant_id = %s
             ORDER BY checked_at DESC
             LIMIT %s
            """, (check_id, tenant, min(limit, 200)))
        cols = [d.name for d in cur.description]
        rows = []
        for r in await cur.fetchall():
            row = dict(zip(cols, r))
            row["checked_at"] = row["checked_at"].isoformat()
            rows.append(row)
        return rows


@router.post("/checks/{check_id}/run")
async def run_check_now(check_id: str, request: Request,
                        tenant_id: str | None = None) -> dict:
    """Trigger a check immediately, outside the scheduled cadence."""
    tenant = _authoritative_tenant(request, tenant_id)
    async with db_tenant_connection(tenant) as conn:
        cur = await conn.execute(
            """
            SELECT url, method, expected_status, timeout_seconds, headers
              FROM monitoring.synthetic_check
             WHERE tenant_id = %s AND check_id = %s
            """, (tenant, check_id))
        row = await cur.fetchone()
        if row is None:
            raise HTTPException(status_code=404, detail="check not found")
        url, method, exp_status, timeout, headers_obj = row

    headers: dict[str, str] = headers_obj or {}
    # Defense-in-depth: re-validate URL before execution (catches rows that
    # pre-date the SSRF fix). Redirects disabled — a redirect to a private
    # host would bypass the up-front DNS check done at creation time.
    try:
        _assert_external_url(url)
    except HTTPException:
        return {"ok": False, "status_code": None, "response_ms": 0,
                "error": "check url blocked by security policy"}
    t0 = time.monotonic()
    ok = False
    status_code: int | None = None
    error: str | None = None
    try:
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            resp = await client.request(method, url, headers=headers)
        status_code = resp.status_code
        ok = (status_code == exp_status)
    except Exception as exc:
        error = str(exc)[:500]
    response_ms = int((time.monotonic() - t0) * 1000)

    result_id = f"synres_{secrets.token_urlsafe(10)}"
    async with db_tenant_connection(tenant) as conn:
        await conn.execute(
            """
            INSERT INTO monitoring.synthetic_result
                (result_id, check_id, tenant_id, ok,
                 status_code, response_ms, error)
            VALUES (%s,%s,%s,%s,%s,%s,%s)
            """,
            (result_id, check_id, tenant, ok,
             status_code, response_ms, error))
        await conn.execute(
            """
            UPDATE monitoring.synthetic_check
               SET last_checked_at = now(), last_ok = %s,
                   last_status_code = %s, last_response_ms = %s,
                   last_error = %s
             WHERE check_id = %s
            """,
            (ok, status_code, response_ms, error, check_id))
        await conn.commit()

    return {"ok": ok, "status_code": status_code,
            "response_ms": response_ms, "error": error}
