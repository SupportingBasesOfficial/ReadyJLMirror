# Runbook: Production Deployment

## Prerequisites

- Server with Docker Engine 24+ and Docker Compose v2
- SSH access to production host
- `.env.prod` with all placeholders filled in (see `.env.prod` for `FILL_IN_*` markers)
- TLS certificates (CA-signed for public endpoints)

---

## Step 1 — Prepare secrets

```bash
# On the production server, inside the repo directory:
source .env.prod
bash scripts/setup_prod_secrets.sh
```

Verify:

```bash
ls -la secrets/
# Must include: db_password, db_password_jlmirror_worker,
#               bff_internal_secret, keycloak_client_secret,
#               notification_callback_secret, session_secret, tls/
```

## Step 2 — TLS certificates

For production, replace the self-signed dev CA with real certs:

```bash
# Place CA-signed certificates:
cp /path/to/signed/cert.pem   secrets/tls/cert.pem
cp /path/to/signed/key.pem    secrets/tls/key.pem
cp /path/to/signed/api.pem    secrets/tls/api-cert.pem
cp /path/to/signed/api.key    secrets/tls/api-key.pem
# ... repeat for bff-cert, bff-key, worker-cert, worker-key
```

For staging (self-signed CA acceptable):

```bash
python -m scripts.dev_tls
```

## Step 3 — Pull images and start

```bash
docker compose \
  --env-file .env.prod \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  pull

docker compose \
  --env-file .env.prod \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  up -d
```

## Step 4 — Wait for health

```bash
# All services should reach healthy within 3 minutes
watch docker compose ps

# Confirm:
# - db          healthy
# - migrate     Exited(0)
# - api         healthy
# - bff         healthy
# - worker      healthy
# - keycloak    healthy
```

## Step 5 — Run preflight

```bash
docker compose \
  --env-file .env.prod \
  -f docker-compose.yml \
  -f docker-compose.prod.yml \
  exec bff python -m scripts.production_preflight
```

Expected: **16/16 required checks passed.**

## Step 6 — Configure Keycloak

1. Open `https://<KC_HOSTNAME>/admin`
2. Login with `KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD` from `.env.prod`
3. Select realm `jlmirror` → Clients → `jlmirror-bff`
4. Credentials tab → set Secret to the value of `KEYCLOAK_CLIENT_SECRET`

## Step 7 — Smoke test

```bash
export JLMIRROR_SMOKE_URL=https://<BFF_PUBLIC_URL>
export JLMIRROR_SMOKE_TOKEN=<admin-token-from-keycloak>
pytest tests/test_smoke_prod.py -v
```

---

## Rollback

See `docs/runbooks/rollback.md`.
