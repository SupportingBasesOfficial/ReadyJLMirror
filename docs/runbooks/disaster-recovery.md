# Runbook — Backup & Restore Rehearsal (ADR-018)

Dev-scale implementation of the canonical recovery model. The restored
target is **never authoritative** until invariants pass — same posture
as the canonical recovery quarantine, at single-cell scale.

## Backup

```bash
python -m scripts.backup
```

Produces `backups/<utc-ts>/`:

- `dump.pg_dump` — custom-format dump of the cell database (all
  schemas: `g1`, `monitoring`, `public`).
- `manifest.json` — recovery point `R` plus continuity watermarks:
  outbox dispatch-state counts, sync-operation states, source and
  session counts, max outbox record id. These are the `(R, F]`
  reconciliation inputs an operator needs before any restored
  target resumes authority.

## Restore rehearsal

```bash
python -m scripts.restore_verify [backups/<ts>]   # defaults to latest
```

Restores into an **isolated scratch database**
(`jlmirror_restore_rehearsal`) on the same PostgreSQL instance —
never over the live database — then validates:

- monitoring schema present (>= 20 tables)
- `FORCE ROW LEVEL SECURITY` on every monitoring table
- session count matches manifest watermark
- sync-operation count matches manifest watermark

On PASS the scratch DB is dropped; on FAIL it is also dropped and
the rehearsal reports which invariant failed.

## PITR (WAL archive + base backups)

The db archives WAL continuously into the `wal_archive` volume
(`archive_timeout=300` bounds the exposure window to 5 min). The
`backup` profile takes a `pg_basebackup` every cycle alongside the
logical dump, producing `backups/<ts>/base/`:

- `base.tar.gz` — the data directory at backup start (with checksum
  manifest in `backup_manifest`);
- `pg_wal.tar.gz` — WAL needed to reach a consistent state
  (`-X stream`).

`manifest.json` records `wal_anchor` (WAL file current when the
cycle started) and `pg_stat_archiver` stats. After retention prunes
old snapshots, `pg_archivecleanup` removes archived WAL older than
the oldest retained anchor — the archive holds exactly what the
retained base backups need.

### Point-in-time restore (operator)

1. Stop the stack: `docker compose stop api bff worker db`.
2. Extract `backups/<ts>/base/base.tar.gz` into a fresh data dir
   (or a scratch volume for rehearsal — never over live data).
3. Extract `backups/<ts>/base/pg_wal.tar.gz` into `<datadir>/pg_wal/`.
4. Copy the archived WAL you want to replay into a restore area —
   files from the `wal_anchor` in the manifest up to the target time.
5. Append to `postgresql.auto.conf`:
   ```
   restore_command = 'cp /restore_area/%f %p'
   recovery_target_time = '2026-09-23 08:00:00+00'
   recovery_target_action = 'promote'
   ```
   (or `recovery_target_lsn`/`recovery_target_xid` for a tighter cut;
   omit `recovery_target_*` to replay all available WAL)
6. `touch <datadir>/recovery.signal` and start postgres — it replays
   to the target and promotes. Run the `restore_verify` invariants
   before treating it as authoritative.

This procedure was rehearsed live: a base backup restored into a
scratch container, WAL replayed from `wal_archive`, and a marker row
created after the backup was recovered — full pipeline verified
end-to-end.

## What this does NOT cover yet (canonical gaps)

- Revocation/governance continuity reconciliation in `(R, F]` —
  the watermark manifest records the state needed; merge rules are
  the canonical PITR procedure, not yet automated.
- KMS/secret-authority recovery — secrets live in OpenBao/mounted
  files; the vault itself needs its own DR.
- Object-artifact retention (no object store yet).
- Scheduled rehearsal automation (run the script manually or via CI).

## Emergency restore (operator)

1. `python -m scripts.backup` BEFORE anything destructive, always.
2. Restore into scratch: `python -m scripts.restore_verify`.
3. If PASS and you intend cutover: stop api/bff/worker, restore the
   dump into the live DB with `pg_restore --clean`, restart stack.
4. Re-run `restore_verify` invariants against the live DB.
5. Investigate `(R, F]` interval from the manifest watermarks —
   ops in `reconciliation_required`/`pending` at R need the
   canonical reconciliation path before trusting results.

Keep dumps OUT of git (`backups/` is gitignored). They contain
production-shaped data — treat as protected.
