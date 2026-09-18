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

## What this does NOT cover yet (canonical gaps)

- Real PITR (WAL archiving) — dev uses dump-level recovery points.
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
