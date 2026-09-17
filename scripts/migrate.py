"""Migration runner — applies SQL from the ProjectJLMirror submodule.

The SQL files in vendor/ProjectJLMirror/sql/ are applied in canonical
order (wave1 → wave2 → wave4 → integration → d2-open-rel-030). Each
applied file is tracked in a `_migrations` table to ensure idempotency.

NOTE: Not all SQL files are safe to apply blindly as migrations. Some
are assertions, evidence scripts, or hardening scripts. This runner
applies only the canonical schema-creation files. Production
deployments must review and classify each file before execution.
"""

from __future__ import annotations

import logging
import sys
from pathlib import Path

import psycopg
from psycopg import Connection

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# Canonical migration order
MIGRATION_DIRS = [
    "wave1",
    "wave2",
    "wave4",
    "integration",
    "d2-open-rel-030",
]

# Files to skip (evidence/assertion scripts, not schema migrations)
SKIP_PATTERNS = {
    # Add patterns here for files that should not be applied as migrations
}


def get_vendor_sql_dir() -> Path:
    """Return the path to the SQL directory in the ProjectJLMirror submodule."""
    here = Path(__file__).resolve().parent
    sql_dir = here.parent / "vendor" / "ProjectJLMirror" / "sql"
    if not sql_dir.exists():
        raise FileNotFoundError(f"SQL directory not found: {sql_dir}")
    return sql_dir


def ensure_migrations_table(conn: Connection) -> None:
    """Create the migrations tracking table if it doesn't exist."""
    with conn.cursor() as cur:
        cur.execute(
            """
            CREATE TABLE IF NOT EXISTS _migrations (
                id SERIAL PRIMARY KEY,
                filename TEXT NOT NULL UNIQUE,
                applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
            )
            """
        )
    conn.commit()


def is_applied(conn: Connection, filename: str) -> bool:
    """Check if a migration file has already been applied."""
    with conn.cursor() as cur:
        cur.execute("SELECT 1 FROM _migrations WHERE filename = %s", (filename,))
        return cur.fetchone() is not None


def mark_applied(conn: Connection, filename: str) -> None:
    """Mark a migration file as applied."""
    with conn.cursor() as cur:
        cur.execute(
            "INSERT INTO _migrations (filename) VALUES (%s) ON CONFLICT DO NOTHING",
            (filename,),
        )
    conn.commit()


def apply_migration(conn: Connection, filepath: Path) -> None:
    """Apply a single SQL migration file."""
    sql = filepath.read_text(encoding="utf-8")
    with conn.cursor() as cur:
        cur.execute(sql)
    conn.commit()
    mark_applied(conn, str(filepath.relative_to(get_vendor_sql_dir())))
    logger.info("Applied: %s", filepath.name)


def main() -> None:
    """Run all pending migrations."""
    from app.config import settings

    sql_dir = get_vendor_sql_dir()
    logger.info("SQL directory: %s", sql_dir)

    dsn = settings.db_dsn
    logger.info("Connecting to: %s:%s/%s", settings.db_host, settings.db_port, settings.db_name)

    with psycopg.connect(dsn, autocommit=False) as conn:
        ensure_migrations_table(conn)

        applied_count = 0
        skipped_count = 0

        for dir_name in MIGRATION_DIRS:
            dir_path = sql_dir / dir_name
            if not dir_path.exists():
                logger.warning("Directory not found: %s", dir_path)
                continue

            sql_files = sorted(dir_path.glob("*.sql"))
            for filepath in sql_files:
                rel_name = str(filepath.relative_to(sql_dir))
                if any(pattern in rel_name for pattern in SKIP_PATTERNS):
                    logger.info("Skipping (pattern match): %s", rel_name)
                    skipped_count += 1
                    continue

                if is_applied(conn, rel_name):
                    logger.debug("Already applied: %s", rel_name)
                    continue

                try:
                    logger.info("Applying: %s", rel_name)
                    apply_migration(conn, filepath)
                    applied_count += 1
                except Exception as exc:
                    logger.error("Failed to apply %s: %s", rel_name, exc)
                    conn.rollback()
                    sys.exit(1)

        logger.info(
            "Migrations complete: %s applied, %s skipped", applied_count, skipped_count
        )


if __name__ == "__main__":
    main()
