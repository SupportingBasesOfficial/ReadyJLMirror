"""Redrive all quarantined outbox messages.

Root cause of quarantine: ALERTING_WEBHOOK_URL defaulted to
http://api:8000/dev/outbox-sink which returns 403 in production mode,
causing every dispatch attempt to fail. After 5 attempts, messages are
quarantined. The prod compose now clears ALERTING_WEBHOOK_URL so the
dispatcher uses dev-log receipts until a real broker is configured.

This script redrives all quarantined messages back to 'pending'.
It is safe to run multiple times (idempotent via dispatch_state filter).

Usage:
    python -m scripts.redrive_quarantined [--dry-run]
"""
from __future__ import annotations

import sys

import psycopg

from shared.config import settings


def main() -> None:
    dry = "--dry-run" in sys.argv
    with psycopg.connect(settings.db_dsn, autocommit=False,
                         connect_timeout=10) as conn:
        cur = conn.execute(
            """
            SELECT count(*)
              FROM monitoring.monitoring_outbox
             WHERE dispatch_state = 'quarantined'
            """
        )
        total = cur.fetchone()[0]
        print(f"Quarantined messages: {total}")
        if total == 0:
            print("Nothing to redrive.")
            return

        if dry:
            print("[dry-run] Would redrive all. Re-run without --dry-run to apply.")
            return

        # Bulk reset — bypasses redrive_count cap for this recovery.
        # The per-message function enforces the cap for future operator redrives.
        cur = conn.execute(
            """
            UPDATE monitoring.monitoring_outbox
               SET dispatch_state = 'pending',
                   claim_owner = NULL,
                   claim_expires_at = NULL,
                   attempt_count = 0,
                   redrive_count = redrive_count + 1,
                   last_error_class = 'operator_bulk_redrive'
             WHERE dispatch_state = 'quarantined'
            """
        )
        redriven = cur.rowcount
        conn.commit()
        print(f"Redriven: {redriven} messages → 'pending'.")
        print("The outbox dispatcher will pick them up on the next cycle.")


if __name__ == "__main__":
    main()
