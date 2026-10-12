# Runbook: Rollback

Use when a production deployment fails health checks or causes regressions.

---

## Fast rollback — previous image tag

If you deployed a new image tag and need to revert:

```bash
# Find the previous image digest
docker image ls | grep readyjlmirror

# Stop the stack
docker compose \
  --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml \
  down --remove-orphans

# Check out the previous release tag
git fetch --tags
git checkout v<PREVIOUS_VERSION>

# Re-deploy (images re-build from the old commit)
docker compose \
  --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --build

# Verify
docker compose ps
docker compose exec bff python -m scripts.production_preflight
```

---

## Database rollback

Migrations are one-directional (no down scripts). Reverting a migration
requires restoring from backup.

```bash
# 1. Stop the application (keep DB running)
docker compose \
  --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml \
  stop bff api worker

# 2. Restore from the last known-good backup
python -m scripts.restore_verify --backup /path/to/backup.sql.gz

# 3. Verify restore
docker compose exec db psql -U jlmirror_owner -d jlmirror \
  -c "SELECT count(*) FROM public._migrations"

# 4. Deploy the previous application version (see above)
```

---

## Partial rollback — config only

If the issue is a misconfiguration (not a code regression):

```bash
# Edit .env.prod to correct the bad value
# Then restart only the affected service
docker compose \
  --env-file .env.prod \
  -f docker-compose.yml -f docker-compose.prod.yml \
  up -d --no-deps bff   # or api, worker, etc.
```

---

## Escalation

If rollback does not resolve the issue within 30 minutes:
1. Scale down to maintenance mode (stop BFF, leave DB + worker running to drain outbox)
2. Open incident in ITSM
3. Engage on-call engineer

See also: `docs/runbooks/disaster-recovery.md`
