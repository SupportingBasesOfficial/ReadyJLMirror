# Runbook: Backup & Restore Drill

Run this drill quarterly (or before each major release) to verify that
backup and restore actually work. Record the outcome in the ITSM change
record.

---

## Backup verification

```bash
# Trigger a manual backup
docker compose exec backup python -m scripts.backup

# List recent backups
ls -lh /var/backups/jlmirror/   # or the configured BACKUP_PATH
```

Check the backup file:
- Non-zero size
- Created within the last 5 minutes
- Filename format: `jlmirror_<YYYYMMDD_HHMMSS>.sql.gz`

---

## Restore drill (on a staging clone)

**Do NOT run the restore on the production DB.** Use a separate host or a
temporary Docker container.

### 1 — Start an isolated Postgres

```bash
docker run -d --name jlm-restore-test \
  -e POSTGRES_USER=jlmirror_owner \
  -e POSTGRES_PASSWORD=drill_password \
  -e POSTGRES_DB=jlmirror \
  -p 5499:5432 \
  postgres:16-alpine
```

### 2 — Restore

```bash
export RESTORE_DB_HOST=localhost
export RESTORE_DB_PORT=5499
export RESTORE_DB_PASSWORD=drill_password

python -m scripts.restore_verify \
  --backup /var/backups/jlmirror/<latest>.sql.gz \
  --host $RESTORE_DB_HOST \
  --port $RESTORE_DB_PORT \
  --password $RESTORE_DB_PASSWORD
```

Expected output:
```
[PASS] Backup decompressed
[PASS] Schema applied
[PASS] Migration count matches source
[PASS] Row count sanity (monitoring_sources, resources, alerts)
Restore drill PASSED
```

### 3 — Clean up

```bash
docker rm -f jlm-restore-test
```

---

## Evidence to record

After each drill, record in the ITSM change request:

| Field | Value |
|---|---|
| Date | YYYY-MM-DD |
| Backup file | jlmirror_<timestamp>.sql.gz |
| Backup size | N MB |
| Restore duration | N minutes |
| Migration count matches | yes/no |
| Row count sanity | yes/no |
| Drill outcome | PASS / FAIL |
| Operator | Name |

---

## Automated restore check in CI

`scripts/restore_verify.py` is also called from the chaos matrix
(`scripts/chaos_matrix.py`). To run it in CI against a freshly restored DB,
set `CI_RESTORE_DRILL=1` and the CI job will include it automatically.
