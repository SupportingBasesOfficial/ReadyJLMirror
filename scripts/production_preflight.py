"""G14 Production preflight validation.

Checks all required production readiness criteria before deploying.
Exits 0 if all required checks pass, 1 if any fail.

Usage:
    python -m scripts.production_preflight
"""
from __future__ import annotations

import os
import sys
import textwrap


def _check(label: str, ok: bool, detail: str = "") -> bool:
    tag = "PASS" if ok else "FAIL"
    suffix = f"  ({detail})" if detail else ""
    print(f"  [{tag}] {label}{suffix}")
    return ok


def _warn(label: str, detail: str = "") -> None:
    suffix = f"  ({detail})" if detail else ""
    print(f"  [WARN] {label}{suffix}")


def main() -> None:
    print(textwrap.dedent("""\
        ╔══════════════════════════════════════════╗
        ║  ReadyJLMirror Production Preflight      ║
        ║  G14 — run before promoting to prod      ║
        ╚══════════════════════════════════════════╝
    """))

    results: list[bool] = []

    # ------------------------------------------------------------------
    # Environment configuration
    # ------------------------------------------------------------------
    print("Environment configuration:")
    env = os.environ.get("APP_ENVIRONMENT", "development")
    results.append(_check("APP_ENVIRONMENT = production", env == "production", env))

    dev_bypass = os.environ.get("DEV_AUTH_BYPASS", "false").lower()
    results.append(_check("DEV_AUTH_BYPASS is false",
                          dev_bypass not in ("true", "1", "yes"),
                          dev_bypass or "unset"))

    bff_secret = os.environ.get("BFF_INTERNAL_SECRET", "")
    results.append(_check("BFF_INTERNAL_SECRET overridden",
                          bool(bff_secret)
                          and bff_secret != "dev-internal-secret-change-me"))

    kc_secret = os.environ.get("KEYCLOAK_CLIENT_SECRET", "")
    results.append(_check("KEYCLOAK_CLIENT_SECRET overridden",
                          bool(kc_secret)
                          and kc_secret != "dev-bff-secret-change-me"))

    cb_secret = os.environ.get("NOTIFICATION_CALLBACK_SECRET", "")
    results.append(_check("NOTIFICATION_CALLBACK_SECRET overridden",
                          bool(cb_secret)
                          and cb_secret != "dev-callback-secret"))

    cookie_secure = os.environ.get("COOKIE_SECURE", "false").lower()
    results.append(_check("COOKIE_SECURE = true",
                          cookie_secure == "true",
                          cookie_secure or "unset"))

    db_password = os.environ.get("DB_PASSWORD", "")
    results.append(_check("DB_PASSWORD not default",
                          bool(db_password) and db_password != "jlmirror_dev",
                          "still set to jlmirror_dev" if db_password == "jlmirror_dev" else "ok"))

    smtp_host = os.environ.get("SMTP_HOST", "")
    if not smtp_host:
        _warn("SMTP_HOST not set — notification emails will be silently discarded")

    # ------------------------------------------------------------------
    # Transport security
    # ------------------------------------------------------------------
    print("\nTransport security:")
    tls_cert = os.environ.get("TLS_CERT_FILE", "")
    tls_key = os.environ.get("TLS_KEY_FILE", "")
    results.append(_check("BFF TLS configured",
                          bool(tls_cert and tls_key),
                          "TLS_CERT_FILE + TLS_KEY_FILE"))

    api_mtls = os.environ.get("API_MTLS", "").lower() in ("1", "true", "yes")
    results.append(_check("API mTLS enabled", api_mtls, "API_MTLS=1"))

    db_user = os.environ.get("DB_USER", "")
    results.append(_check("DB_USER is not owner",
                          db_user not in ("jlmirror_owner", "postgres", ""),
                          db_user or "unset"))

    # ------------------------------------------------------------------
    # Data plane
    # ------------------------------------------------------------------
    print("\nData plane:")
    try:
        import psycopg  # type: ignore[import]

        dsn_parts = {
            "host": os.environ.get("DB_HOST", "localhost"),
            "port": int(os.environ.get("DB_PORT", "5432")),
            "dbname": os.environ.get("DB_NAME", "jlmirror"),
            "user": os.environ.get("DB_USER", "jlmirror_app"),
            "password": os.environ.get("DB_PASSWORD", ""),
            "connect_timeout": 5,
        }
        with psycopg.connect(**dsn_parts) as conn:
            results.append(_check("DB reachable", True))

            cur = conn.execute("SELECT count(*) FROM public._migrations")
            migration_count = cur.fetchone()[0]
            results.append(_check(f"Migrations applied",
                                  migration_count > 0,
                                  f"{migration_count} rows in _migrations"))

            cur = conn.execute(
                """
                SELECT count(*) FROM monitoring.worker_heartbeat
                 WHERE last_seen_at > now() - interval '120 seconds'
                """
            )
            heartbeat_alive = cur.fetchone()[0] > 0
            results.append(_check("Worker heartbeat alive (last 120 s)",
                                  heartbeat_alive))

    except ImportError:
        results.append(_check("DB reachable", False,
                              "psycopg not installed"))
    except Exception as exc:
        results.append(_check("DB reachable", False, str(exc)))

    # ------------------------------------------------------------------
    # Advisory
    # ------------------------------------------------------------------
    print("\nAdvisory (warnings do not block deployment):")
    if not os.environ.get("ANTHROPIC_API_KEY", "").strip():
        _warn("ANTHROPIC_API_KEY not set — AIOps will be disabled")
    else:
        print("  [INFO] ANTHROPIC_API_KEY set — AIOps enabled")

    bao_addr = os.environ.get("BAO_ADDR", "")
    if not bao_addr:
        _warn("BAO_ADDR not set — OpenBao secret resolution disabled")

    # ------------------------------------------------------------------
    # Summary
    # ------------------------------------------------------------------
    passed = sum(results)
    total = len(results)
    failed = total - passed

    print(f"\n{'─' * 45}")
    print(f"  {passed}/{total} required checks passed")

    if failed == 0:
        print("\n  ✓ All checks passed — deployment authorized.\n")
        sys.exit(0)
    else:
        print(f"\n  ✗ {failed} check(s) FAILED — do NOT deploy to production.\n")
        sys.exit(1)


if __name__ == "__main__":
    main()
