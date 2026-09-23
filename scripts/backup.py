"""Cell-database backup (ADR-018) — pg_dump + manifest.

Produces backups/<ts>/dump.pg_dump (custom format) + manifest.json
recording the recovery point R and continuity watermarks an operator
needs for the (R, F] reconciliation interval: outbox state counts,
sync-operation states, latest projections.

Requires the compose db container (pg_dump runs inside it so versions
always match) unless `--local` is passed — then pg_dump runs directly
against DB_* env (the CI shape, where psql/pg_dump are on the host).

`--loop SECONDS` runs forever (the compose `backup` service shape);
`--retain N` prunes all but the newest N timestamped backup dirs
after each successful run.

Usage: python -m scripts.backup [--local] [--loop SECONDS]
       [--retain N]
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
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


def _retain(keep: int) -> None:
    """Prune all but the newest `keep` timestamped backup dirs."""
    if keep <= 0 or not OUT.is_dir():
        return
    dirs = sorted(
        (d for d in OUT.iterdir()
         if d.is_dir() and (d / "dump.pg_dump").exists()),
        key=lambda d: d.name)
    for stale in dirs[:-keep]:
        shutil.rmtree(stale, ignore_errors=True)
        print(f"retention: pruned {stale}")


def _once(local: bool) -> int:
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
    if local:
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


def _arg(flag: str, default: str) -> str:
    return (sys.argv[sys.argv.index(flag) + 1]
            if flag in sys.argv else default)


def main() -> int:
    local = "--local" in sys.argv
    loop = int(_arg("--loop", "0"))
    retain = int(_arg("--retain", "0"))
    if loop <= 0:
        rc = _once(local)
        if rc == 0:
            _retain(retain)
        return rc
    while True:
        try:
            if _once(local) == 0:
                _retain(retain)
        except Exception as exc:
            print(f"backup tick failed: {exc}", file=sys.stderr)
        time.sleep(loop)


if __name__ == "__main__":
    sys.exit(main())
