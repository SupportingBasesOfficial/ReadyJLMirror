#!/usr/bin/env bash
# JLMirror — first-boot production deploy script.
# Run once on the server after cloning the repo and filling .env.
#
# Usage:
#   cp .env.prod.example .env   # then edit with real values
#   chmod +x deploy.sh
#   ./deploy.sh
#
# Re-running after the first boot is safe — migrations are idempotent,
# OpenBao init is skipped if already initialized.
set -euo pipefail

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
info()  { echo -e "${GREEN}[deploy]${NC} $*"; }
warn()  { echo -e "${YELLOW}[deploy]${NC} $*"; }
error() { echo -e "${RED}[deploy]${NC} $*" >&2; exit 1; }

COMPOSE="docker compose -f docker-compose.yml -f docker-compose.prod.yml"

[ -f .env ] || error ".env not found. Copy .env.prod.example to .env and fill all REQUIRED values."

# ── 0. Sanity checks ──────────────────────────────────────────────────────────
for cmd in docker curl jq; do
  command -v "$cmd" &>/dev/null || error "'$cmd' is not installed."
done

docker info &>/dev/null || error "Docker is not running or this user lacks Docker access."

if grep -q "REQUIRED_CHANGE_ME" .env; then
  error "Found REQUIRED_CHANGE_ME in .env — fill all required values before deploying."
fi

# ── 1. Build images (includes frontend via multi-stage Dockerfile) ────────────
info "Building application images (frontend + Python)…"
$COMPOSE build --pull

# ── 2. Start infrastructure (DB + Keycloak) ───────────────────────────────────
info "Starting database and Keycloak…"
$COMPOSE up -d db keycloak

info "Waiting for database…"
for i in $(seq 1 30); do
  $COMPOSE exec -T db pg_isready -U jlmirror_owner -d jlmirror &>/dev/null && break
  [ "$i" -eq 30 ] && error "Database did not become healthy after 150 s."
  sleep 5
done
info "Database ready."

info "Waiting for Keycloak…"
KC_DOMAIN=$(grep '^KC_DOMAIN=' .env | cut -d= -f2)
for i in $(seq 1 60); do
  curl -sf "http://localhost:8180/realms/jlmirror" &>/dev/null && break
  [ "$i" -eq 60 ] && error "Keycloak did not become ready after 300 s."
  sleep 5
done
info "Keycloak ready — realm jlmirror imported."

# ── 3. Run database migrations ────────────────────────────────────────────────
info "Running migrations…"
$COMPOSE run --rm migrate
info "Migrations complete."

# ── 4. Initialize OpenBao (skipped if already initialized) ───────────────────
info "Starting OpenBao…"
$COMPOSE --profile secrets up -d openbao

# Port 8200 is not exposed to the host — detect init state via the token
# file written by bao-init on success, not via curl/exec.
if [ -s ./secrets/bao_token ]; then
  info "OpenBao already initialized — skipping init."
else
  info "Initializing OpenBao… (bao-init will retry until OpenBao is ready)"
  $COMPOSE --profile secrets run --rm bao-init
  info "OpenBao initialized."
  warn "Add BAO_TOKEN=$(cat ./secrets/bao_token 2>/dev/null || echo '<see ./secrets/bao_token>') to .env and re-run deploy.sh."
  exit 0
fi

# ── 5. Start all services (including Caddy) ───────────────────────────────────
info "Starting API, BFF, Worker, and Caddy…"
$COMPOSE --profile worker up -d

info "Waiting for BFF…"
for i in $(seq 1 30); do
  curl -sf "http://localhost:8080/health" &>/dev/null && break
  [ "$i" -eq 30 ] && { warn "BFF health check timed out — check: $COMPOSE logs bff"; }
  sleep 5
done

# ── 6. Status summary ─────────────────────────────────────────────────────────
echo ""
info "Deploy complete. Service status:"
$COMPOSE ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
echo ""
info "App:      https://$(grep '^PUBLIC_DOMAIN=' .env | cut -d= -f2)"
info "Auth:     https://$(grep '^KC_DOMAIN=' .env | cut -d= -f2)"
warn "Firewall: block portas 8080, 8180, 5434, 8200 do acesso externo."
warn "Keycloak: troque a senha do admin em https://$(grep '^KC_DOMAIN=' .env | cut -d= -f2)/admin"
