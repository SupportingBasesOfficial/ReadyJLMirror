"""G35 Certificate checker — verify TLS cert expiry for tracked domains."""

from __future__ import annotations

import hashlib
import logging
import socket
import ssl
from datetime import datetime, timezone

import psycopg

logger = logging.getLogger("workers.cert_checker")

_CHECK_INTERVAL_SECS = 3600  # re-check each cert at most once per hour


def _fetch_cert(domain: str, port: int) -> dict:
    ctx = ssl.create_default_context()
    try:
        with socket.create_connection((domain, port), timeout=10) as sock:
            with ctx.wrap_socket(sock, server_hostname=domain) as tls:
                cert = tls.getpeercert()
                not_after_str: str = cert.get("notAfter", "")
                not_after: datetime | None = None
                if not_after_str:
                    not_after = datetime.strptime(
                        not_after_str, "%b %d %H:%M:%S %Y %Z"
                    ).replace(tzinfo=timezone.utc)

                raw_issuer = cert.get("issuer", ())
                issuer_dict = {k: v for pair in raw_issuer for k, v in pair}
                issuer = issuer_dict.get(
                    "organizationName",
                    issuer_dict.get("commonName", "unknown"),
                )

                der = tls.getpeercert(binary_form=True)
                fingerprint = hashlib.sha256(der).hexdigest() if der else None

                return {
                    "expires_at": not_after,
                    "issuer": issuer,
                    "fingerprint": fingerprint,
                    "error": None,
                }
    except Exception as exc:
        return {
            "expires_at": None,
            "issuer": None,
            "fingerprint": None,
            "error": str(exc)[:500],
        }


def _state_for(
    expires_at: datetime | None, alert_days: int, error: str | None
) -> str:
    if error:
        return "error"
    if expires_at is None:
        return "unknown"
    now = datetime.now(timezone.utc)
    delta_days = (expires_at - now).total_seconds() / 86400
    if delta_days < 7:
        return "critical"
    if delta_days < alert_days:
        return "warning"
    return "ok"


def _process_pending(conn: psycopg.Connection) -> int:
    cur = conn.execute(
        """
        SELECT cert_id, tenant_id, domain, port, alert_days
          FROM g1.cert_tracker
         WHERE check_enabled = true
           AND (
               last_checked_at IS NULL
               OR last_checked_at < now() - (%s || ' seconds')::INTERVAL
           )
         ORDER BY last_checked_at NULLS FIRST
         LIMIT 20
        """,
        (str(_CHECK_INTERVAL_SECS),),
    )
    rows = cur.fetchall()
    checked = 0

    for cert_id, tenant_id, domain, port, alert_days in rows:
        result = _fetch_cert(domain, port)
        state = _state_for(result["expires_at"], alert_days, result["error"])
        try:
            conn.execute(
                """
                UPDATE g1.cert_tracker
                   SET expires_at         = %s,
                       issuer             = %s,
                       fingerprint_sha256 = %s,
                       state              = %s,
                       error_detail       = %s,
                       last_checked_at    = now(),
                       updated_at         = now()
                 WHERE cert_id = %s
                """,
                (
                    result["expires_at"],
                    result["issuer"],
                    result["fingerprint"],
                    state,
                    result["error"],
                    cert_id,
                ),
            )
            conn.commit()
            checked += 1
            if state in ("critical", "error"):
                logger.warning(
                    "cert %s domain=%s state=%s error=%s",
                    cert_id, domain, state, result["error"],
                )
        except Exception:
            conn.rollback()
            logger.exception("cert_checker update failed cert_id=%s", cert_id)

    return checked
