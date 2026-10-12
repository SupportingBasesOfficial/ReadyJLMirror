#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ReadyJLMirror — Production secrets bootstrap
# Run this once on the server before `docker compose ... up -d`.
#
# Usage:
#   source .env.prod   # or export vars individually
#   bash scripts/setup_prod_secrets.sh
#
# Required env vars (from .env.prod):
#   APP_DB_PASSWORD       — password for jlmirror_app role
#   WORKER_DB_PASSWORD    — password for jlmirror_worker role
#   BFF_INTERNAL_SECRET   — HMAC secret for BFF→API context headers
#   KEYCLOAK_CLIENT_SECRET
#   NOTIFICATION_CALLBACK_SECRET
#   SESSION_SECRET
# ---------------------------------------------------------------------------
set -euo pipefail

SECRETS_DIR="${SECRETS_DIR:-secrets}"
mkdir -p "$SECRETS_DIR"

require_var() {
    local var="$1"
    if [[ -z "${!var:-}" ]]; then
        echo "ERROR: $var is not set. Source .env.prod first." >&2
        exit 1
    fi
}

require_var APP_DB_PASSWORD
require_var WORKER_DB_PASSWORD
require_var BFF_INTERNAL_SECRET
require_var KEYCLOAK_CLIENT_SECRET
require_var NOTIFICATION_CALLBACK_SECRET
require_var SESSION_SECRET

# DB passwords — named per-role so shared/config.py picks the right one.
printf '%s' "$APP_DB_PASSWORD"    > "$SECRETS_DIR/db_password"
printf '%s' "$WORKER_DB_PASSWORD" > "$SECRETS_DIR/db_password_jlmirror_worker"

# Application secrets
printf '%s' "$BFF_INTERNAL_SECRET"          > "$SECRETS_DIR/bff_internal_secret"
printf '%s' "$KEYCLOAK_CLIENT_SECRET"       > "$SECRETS_DIR/keycloak_client_secret"
printf '%s' "$NOTIFICATION_CALLBACK_SECRET" > "$SECRETS_DIR/notification_callback_secret"
printf '%s' "$SESSION_SECRET"               > "$SECRETS_DIR/session_secret"

chmod 600 "$SECRETS_DIR"/*

echo "Secrets written to $SECRETS_DIR/:"
ls -1 "$SECRETS_DIR/" | grep -v '^tls$'
echo
echo "Next: generate TLS certs if not already done:"
echo "  python -m scripts.dev_tls   # dev/staging self-signed CA"
echo "  # or place CA-signed certs in $SECRETS_DIR/tls/"
echo
echo "Then deploy:"
echo "  docker compose --env-file .env.prod \\"
echo "    -f docker-compose.yml -f docker-compose.prod.yml up -d"
