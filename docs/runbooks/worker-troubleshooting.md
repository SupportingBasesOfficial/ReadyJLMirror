# Runbook: Worker Troubleshooting

## Symptom: worker container is `(unhealthy)`

The healthcheck verifies that `monitoring.worker_heartbeat` was updated
within the last 120 seconds. Unhealthy means the pipeline has stalled.

### Step 1 — Check logs

```bash
docker compose logs worker --tail 50
```

Common patterns:

| Log message | Cause | Fix |
|---|---|---|
| `password authentication failed for user "jlmirror_worker"` | Wrong password in `secrets/db_password_jlmirror_worker` | Re-run `setup_prod_secrets.sh` |
| `db connection lost; reconnecting` (looping) | DB unreachable or firewall | Check `docker compose ps db`, check network |
| `tick loop error; retrying` | Exception inside a worker processor | Check for ERROR lines above |
| `AttributeError` / `ImportError` | Code mismatch with DB schema | Check migration state |

### Step 2 — Verify DB connectivity from worker

```bash
docker compose exec worker \
  python -c "
import os, psycopg
c = psycopg.connect(
  host=os.environ['DB_HOST'], port=int(os.environ['DB_PORT']),
  dbname=os.environ['DB_NAME'], user=os.environ['DB_USER'],
  password=open('/run/secrets/db_password_jlmirror_worker').read().strip(),
  connect_timeout=5)
print('DB OK')
c.close()
"
```

### Step 3 — Check heartbeat staleness

```bash
docker compose exec db \
  psql -U jlmirror_owner -d jlmirror \
  -c "SELECT worker_id, last_seen_at,
             extract(epoch from now() - last_seen_at) AS staleness_s
      FROM monitoring.worker_heartbeat"
```

### Step 4 — Check outbox backlog

```bash
docker compose exec db \
  psql -U jlmirror_owner -d jlmirror \
  -c "SELECT state, count(*) FROM monitoring.monitoring_outbox
      GROUP BY state ORDER BY state"
```

Large `pending` counts indicate the dispatcher is not draining. Large
`quarantined` counts need operator redrive from the UI (source detail →
operations → quarantined deliveries).

### Step 5 — Restart worker

```bash
docker compose restart worker
# Wait 2 minutes for health check to pass
docker compose ps worker
```

---

## Symptom: sync operations stuck in `claimed`

Operations stay `claimed` when the worker died mid-tick without releasing
the claim. The `requeue_stale_claims` job runs every 10 minutes to recover
these, but you can trigger it manually:

```bash
docker compose exec db \
  psql -U jlmirror_owner -d jlmirror \
  -c "SELECT monitoring.requeue_stale_claims()"
```

---

## Symptom: outbox quarantine accumulating

Messages are quarantined after 5 delivery attempts. They must be redriven
manually via the API:

```bash
curl -X POST \
  -H "Authorization: Bearer $TOKEN" \
  https://<BFF_URL>/api/v1/monitoring-sources/<source-id>/redrive-quarantine
```

Or use the UI: Source Detail → Operations → Quarantined Deliveries → Redrive.
