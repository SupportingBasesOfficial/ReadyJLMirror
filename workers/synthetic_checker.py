"""G37 Synthetic monitoring worker — periodic HTTP health checks."""

from __future__ import annotations

import ipaddress
import logging
import secrets
import socket
import time
from urllib.parse import urlparse

import httpx
import psycopg

logger = logging.getLogger("workers.synthetic_checker")

_BATCH = 20


def _is_private_host(host: str) -> bool:
    """Return True if host resolves to a private/loopback/link-local address."""
    if not host or "." not in host:
        return True  # single-label = Docker service name
    try:
        addr = ipaddress.ip_address(host)
        return addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved
    except ValueError:
        pass
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
        for info in infos:
            addr = ipaddress.ip_address(info[4][0])
            if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
                return True
    except Exception:
        return True  # fail-closed: DNS failure → block
    return False


def _run_check(url: str, method: str, expected_status: int,
               timeout: int, headers: dict) -> tuple[bool, int | None, int, str | None]:
    # Defense-in-depth: block private-network URLs at execution time.
    # Redirects disabled — a redirect to a private host bypasses the
    # up-front validation done at check creation time.
    try:
        host = urlparse(url).hostname or ""
        if _is_private_host(host):
            return False, None, 0, "url blocked by security policy"
    except Exception:
        return False, None, 0, "url is malformed"

    t0 = time.monotonic()
    ok = False
    status_code: int | None = None
    error: str | None = None
    try:
        with httpx.Client(timeout=timeout, follow_redirects=False) as client:
            resp = client.request(method, url, headers=headers)
        status_code = resp.status_code
        ok = (status_code == expected_status)
    except Exception as exc:
        error = str(exc)[:500]
    response_ms = int((time.monotonic() - t0) * 1000)
    return ok, status_code, response_ms, error


def _process_pending(conn: psycopg.Connection) -> int:
    cur = conn.execute(
        """
        SELECT check_id, tenant_id, url, method,
               expected_status, timeout_seconds, headers
          FROM monitoring.synthetic_check
         WHERE enabled = true
           AND (
               last_checked_at IS NULL
               OR last_checked_at + (interval_seconds || ' seconds')::INTERVAL
                  <= now()
           )
         ORDER BY last_checked_at NULLS FIRST
         LIMIT %s
        """,
        (_BATCH,))
    rows = cur.fetchall()
    processed = 0

    for (check_id, tenant_id, url, method,
         exp_status, timeout, headers_obj) in rows:
        headers: dict = headers_obj or {}
        ok, status_code, response_ms, error = _run_check(
            url, method, exp_status, timeout, headers)

        result_id = f"synres_{secrets.token_urlsafe(10)}"
        try:
            conn.execute(
                """
                INSERT INTO monitoring.synthetic_result
                    (result_id, check_id, tenant_id, ok,
                     status_code, response_ms, error)
                VALUES (%s,%s,%s,%s,%s,%s,%s)
                """,
                (result_id, check_id, tenant_id, ok,
                 status_code, response_ms, error))
            conn.execute(
                """
                UPDATE monitoring.synthetic_check
                   SET last_checked_at = now(), last_ok = %s,
                       last_status_code = %s, last_response_ms = %s,
                       last_error = %s
                 WHERE check_id = %s
                """,
                (ok, status_code, response_ms, error, check_id))
            conn.commit()
            processed += 1
            if not ok:
                logger.warning(
                    "synthetic check FAIL check_id=%s url=%s "
                    "status=%s error=%s",
                    check_id, url, status_code, error)
        except Exception:
            conn.rollback()
            logger.exception("synthetic_checker failed check_id=%s", check_id)

        # Prune old results — keep last 200 per check
        try:
            conn.execute(
                """
                DELETE FROM monitoring.synthetic_result
                 WHERE check_id = %s
                   AND result_id NOT IN (
                       SELECT result_id
                         FROM monitoring.synthetic_result
                        WHERE check_id = %s
                        ORDER BY checked_at DESC
                        LIMIT 200
                   )
                """,
                (check_id, check_id))
            conn.commit()
        except Exception:
            conn.rollback()

    return processed
