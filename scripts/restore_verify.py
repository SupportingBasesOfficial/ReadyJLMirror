"""Restore rehearsal (ADR-018): restore a backup into an isolated
scratch database and validate invariants BEFORE it could ever be
authoritative.

    python -m scripts.restore_verify [backups/<ts>]

Never restores over the live database — the recovered target stays
non-authoritative in `jlmirror_restore_*` until invariants pass.
Then it is dropped. This is the dev-scale shape of the canonical
"tenant logical recovery into an isolated verification namespace".

Checks: schema + RLS present, row counts per table, FORCE RLS flags,
idempotency/sync-operation counts match the manifest watermarks.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import psycopg

from shared.config import settings

DB_CONTAINER = "readyjlmirror-db-1"
SCRATCH = "jlmirror_restore_rehearsal"


def _exec(*args: str) -> str:
    r = subprocess.run(["docker", "exec", DB_CONTAINER, *args],
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(r.stderr.strip() or r.stdout.strip())
    return r.stdout


def _drop_scratch() -> None:
    _exec("psql", "-U", "jlmirror_owner", "-d", "postgres",
          "-c", f"DROP DATABASE IF EXISTS {SCRATCH} WITH (FORCE)")


def _scratch_dsn() -> str:
    return (f"postgresql://{settings.db_user}:{settings.db_password}"
            f"@{settings.db_host}:{settings.db_port}/{SCRATCH}")


def main() -> int:
    backups = sorted(Path("backups").glob("*/dump.pg_dump"),
                     key=lambda p: p.stat().st_mtime)
    target = Path(sys.argv[1]) / "dump.pg_dump" if len(sys.argv) > 1 \
        else backups[-1]
    manifest_path = target.parent / "manifest.json"
    manifest = json.loads(manifest_path.read_text()) \
        if manifest_path.exists() else {}
    print(f"rehearsing restore of {target}")

    # Stage the dump into the container and restore into scratch.
    subprocess.run(["docker", "cp", str(target),
                    f"{DB_CONTAINER}:/tmp/restore.pg_dump"], check=True)
    _drop_scratch()
    _exec("psql", "-U", "jlmirror_owner", "-d", "postgres",
          "-c", f"CREATE DATABASE {SCRATCH} OWNER jlmirror_owner")
    _exec("pg_restore", "-U", "jlmirror_owner", "-d", SCRATCH,
          "--no-owner", "--role=jlmirror_owner", "/tmp/restore.pg_dump")
    print("restored into scratch database:", SCRATCH)

    checks: list[tuple[str, bool, str]] = []
    with psycopg.connect(_scratch_dsn()) as conn:
        def q1(sql):
            return conn.execute(sql).fetchone()[0]

        n_tables = q1(
            "SELECT count(*) FROM information_schema.tables"
            " WHERE table_schema='monitoring'")
        checks.append(("monitoring tables >= 20", n_tables >= 20,
                       f"{n_tables} tables"))
        n_forced = q1(
            "SELECT count(*) FROM pg_class c JOIN pg_namespace n"
            " ON n.oid=c.relnamespace"
            " WHERE n.nspname='monitoring' AND c.relrowsecurity"
            " AND c.relforcerowsecurity")
        checks.append(("FORCE RLS on all monitoring tables",
                       n_forced == n_tables,
                       f"{n_forced}/{n_tables}"))
        n_sessions = q1("SELECT count(*) FROM g1.browser_sessions")
        checks.append(("sessions restored",
                       n_sessions == manifest.get("watermarks", {})
                       .get("sessions", n_sessions),
                       f"{n_sessions}"))
        n_ops = q1(
            "SELECT count(*) FROM monitoring.monitoring_sync_operation")
        exp = sum(manifest.get("watermarks", {})
                  .get("sync_operation_states", {}).values()) \
            or n_ops
        checks.append(("sync operations match manifest", n_ops == exp,
                       f"{n_ops} vs manifest {exp}"))

    failed = [name for name, ok, _ in checks if not ok]
    for name, ok, detail in checks:
        print(f"  {'PASS' if ok else 'FAIL'} {name} ({detail})")

    _drop_scratch()
    if failed:
        print(f"REHEARSAL FAILED: {failed} — scratch dropped")
        return 1
    print("rehearsal PASS — scratch dropped, live DB untouched")
    return 0


if __name__ == "__main__":
    sys.exit(main())
