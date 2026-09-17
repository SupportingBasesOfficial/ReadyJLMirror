"""Migration runner — applies ReadyJLMirror SQL migrations.

Applies sql/ directories in lexical order (sql/g1/*.sql, then any future
sql/<slice>/). Each applied file is tracked in `public._migrations` for
idempotency.

The canonical vendor SQL (vendor/ProjectJLMirror/sql/) is applied only
when explicitly requested via `--vendor` — its bootstrap is heavy and
governed separately.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import psycopg

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)


def get_sql_dir() -> Path:
    here = Path(__file__).resolve().parent
    sql_dir = here.parent / "sql"
    if not sql_dir.exists():
        raise FileNotFoundError(f"SQL directory not found: {sql_dir}")
    return sql_dir


def ensure_migrations_table(conn) -> None:
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS public._migrations (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL UNIQUE,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
    conn.commit()


def is_applied(conn, filename: str) -> bool:
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM public._migrations WHERE filename = %s", (filename,))
        return cur.fetchone() is not None


def apply_file(conn, filepath: Path, rel_name: str) -> None:
    sql = filepath.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
        cur.execute(
            "INSERT INTO public._migrations (filename) VALUES (%s) ON CONFLICT DO NOTHING",
            (rel_name,),
        )
    conn.commit()
    logger.info("Applied: %s", rel_name)


def main() -> None:
    from shared.config import settings

    sql_dir = get_sql_dir()
    dsn = settings.db_dsn
    logger.info("Connecting to %s:%s/%s", settings.db_host, settings.db_port, settings.db_name)

    with psycopg.connect(dsn, autocommit=False) as conn:
        ensure_migrations_table(conn)
        applied = 0
        for filepath in sorted(sql_dir.rglob("*.sql")):
            rel_name = filepath.relative_to(sql_dir).as_posix()
            if is_applied(conn, rel_name):
                logger.debug("Already applied: %s", rel_name)
                continue
            try:
                apply_file(conn, filepath, rel_name)
                applied += 1
            except Exception as exc:
                logger.error("Failed to apply %s: %s", rel_name, exc)
                conn.rollback()
                sys.exit(1)

    logger.info("Migrations complete: %s applied", applied)


if __name__ == "__main__":
    main()
