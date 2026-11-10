#!/usr/bin/env bash
# Local production test — identical to deploy.sh but uses localhost URLs.
# Does NOT touch your dev .env file.
#
# Usage:
#   chmod +x test-prod-local.sh
#   ./test-prod-local.sh
#
# Access: http://localhost:8080
# Keycloak admin: http://localhost:8180/admin  (admin / password from .env.prod)
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[test-prod]${NC} $*"; }
warn()  { echo -e "${YELLOW}[test-prod]${NC} $*"; }
error() { echo -e "${RED}[test-prod]${NC} $*" >&2; exit 1; }

ENV_FILE=".env.prod"
COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.local-prod-test.yml --env-file $ENV_FILE"

[ -f "$ENV_FILE" ] || error "$ENV_FILE not found."

for cmd in docker python; do
  command -v "$cmd" &>/dev/null || error "'$cmd' is not installed."
done
docker info &>/dev/null || error "Docker is not running."

# ── 1. mTLS certs ─────────────────────────────────────────────────────────────
if [ ! -f secrets/tls/ca.pem ]; then
  info "Generating mTLS certs…"
  SECRETS_DIR=secrets python -m scripts.dev_tls
else
  info "mTLS certs already exist — skipping."
fi

# ── 2. DB password secret files ───────────────────────────────────────────────
mkdir -p secrets
APP_PWD=$(grep '^APP_DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)
WORKER_PWD=$(grep '^WORKER_DB_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)

if [ -n "$APP_PWD" ]; then
  printf '%s' "$APP_PWD" > secrets/db_password
  info "secrets/db_password written."
fi
if [ -n "$WORKER_PWD" ]; then
  printf '%s' "$WORKER_PWD" > secrets/db_password_jlmirror_worker
  info "secrets/db_password_jlmirror_worker written."
fi

# ── 3. Build images ───────────────────────────────────────────────────────────
info "Building images…"
$COMPOSE build --pull

# ── 4. Start DB + Keycloak ────────────────────────────────────────────────────
info "Starting DB and Keycloak…"
$COMPOSE up -d db keycloak

info "Waiting for DB…"
for i in $(seq 1 30); do
  $COMPOSE exec -T db pg_isready -U jlmirror_owner -d jlmirror &>/dev/null && break
  [ "$i" -eq 30 ] && error "DB not ready after 150 s."
  sleep 5
done
info "DB ready."

info "Waiting for Keycloak…"
for i in $(seq 1 60); do
  curl -sf "http://localhost:8180/realms/jlmirror" &>/dev/null && break
  [ "$i" -eq 60 ] && error "Keycloak not ready after 300 s."
  sleep 5
done
info "Keycloak ready."

# ── 5. Migrations ─────────────────────────────────────────────────────────────
info "Running migrations…"
$COMPOSE run --rm migrate
info "Migrations complete."

# ── 6. OpenBao ────────────────────────────────────────────────────────────────
info "Starting OpenBao…"
$COMPOSE --profile secrets up -d openbao

info "Waiting for OpenBao…"
for i in $(seq 1 20); do
  curl -sf "http://localhost:8200/v1/sys/health" &>/dev/null && break
  sleep 3
done

BAO_INIT=$(curl -sf "http://localhost:8200/v1/sys/init" | python -c "import sys,json; print(json.load(sys.stdin).get('initialized','false'))" 2>/dev/null || echo "false")
if [ "$BAO_INIT" != "true" ]; then
  info "Initializing OpenBao…"
  $COMPOSE --profile secrets run --rm bao-init
  warn "Add BAO_TOKEN=$(cat ./secrets/bao_token 2>/dev/null || echo '<see secrets/bao_token>') to .env.prod and re-run."
  exit 0
else
  info "OpenBao already initialized."
fi

# ── 7. Start API + BFF + Worker ───────────────────────────────────────────────
info "Starting API, BFF and Worker…"
$COMPOSE --profile worker up -d

info "Waiting for BFF…"
for i in $(seq 1 30); do
  curl -sf "http://localhost:8080/health" &>/dev/null && break
  [ "$i" -eq 30 ] && { warn "BFF health check timed out — check: $COMPOSE logs bff"; }
  sleep 5
done

echo ""
info "Stack running. Access:"
info "  App:      http://localhost:8080"
info "  Keycloak: http://localhost:8180/admin"
echo ""
$COMPOSE ps --format "table {{.Name}}\t{{.Status}}"
