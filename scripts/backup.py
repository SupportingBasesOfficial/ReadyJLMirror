"""Cell-database backup (ADR-018) — pg_dump + manifest.

Produces backups/<ts>/dump.pg_dump (custom format) + manifest.json
recording the recovery point R and continuity watermarks an operator
needs for the (R, F] reconciliation interval: outbox state counts,
sync-operation states, latest projections.

Requires the compose db container (pg_dump runs inside it so versions
always match) unless `--local` is passed — then pg_dump runs directly
against DB_* env (the CI shape, where psql/pg_dump are on the host).

Usage: python -m scripts.backup [--local]
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import psycopg

from shared.config import settings

OUT = Path("backups")


def _env() -> dict:
    env = dict(os.environ)
    env["PGPASSWORD"] = settings.db_password
    return env


def _watermarks(dsn: str) -> dict:
    with psycopg.connect(dsn) as conn:
        def q(sql):
            return conn.execute(sql).fetchall()
        wm: dict = {}
        wm["outbox_states"] = {s: n for s, n in q(
            "SELECT dispatch_state, count(*) FROM monitoring.monitoring_outbox"
            " GROUP BY 1")}
        wm["sync_operation_states"] = {s: n for s, n in q(
            "SELECT state, count(*) FROM monitoring.monitoring_sync_operation"
            " GROUP BY 1")}
        wm["sources"] = q(
            "SELECT count(*) FROM monitoring.monitoring_source")[0][0]
        wm["sessions"] = q(
            "SELECT count(*) FROM g1.browser_sessions")[0][0]
        wm["max_outbox_record"] = q(
            "SELECT max(record_id) FROM monitoring.monitoring_outbox")[0][0]
    return wm


def main() -> int:
    ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = OUT / ts
    dest.mkdir(parents=True, exist_ok=True)

    dsn = settings.db_dsn
    print(f"collecting recovery-point watermarks from {settings.db_name}...")
    wm = _watermarks(dsn)
    manifest = {
        "recovery_point_utc": ts,
        "database": settings.db_name,
        "watermarks": wm,
    }
    (dest / "manifest.json").write_text(json.dumps(manifest, indent=2))

    dump = dest / "dump.pg_dump"
    print(f"pg_dump -> {dump}")
    if "--local" in sys.argv:
        r = subprocess.run(
            ["pg_dump", "-h", settings.db_host, "-p", str(settings.db_port),
             "-U", settings.db_user, "-d", settings.db_name,
             "-Fc", "-f", str(dump)],
            capture_output=True, text=True, env=_env())
        if r.returncode != 0:
            print(f"pg_dump failed: {r.stderr.strip()}")
            return 1
    else:
        r = subprocess.run(
            ["docker", "exec", "readyjlmirror-db-1",
             "pg_dump", "-U", "jlmirror_owner", "-d", settings.db_name,
             "-Fc", "-f", "/tmp/dump.pg_dump"],
            capture_output=True, text=True)
        if r.returncode != 0:
            print(f"pg_dump failed: {r.stderr.strip()}")
            return 1
        r = subprocess.run(
            ["docker", "cp", "readyjlmirror-db-1:/tmp/dump.pg_dump",
             str(dump)],
            capture_output=True, text=True)
        if r.returncode != 0:
            print(f"docker cp failed: {r.stderr.strip()}")
            return 1

    print(f"backup complete: {dest}/ "
          f"({dump.stat().st_size / 1024:.0f} KiB)")
    print("watermarks:", json.dumps(wm))
    return 0


if __name__ == "__main__":
    sys.exit(main())
