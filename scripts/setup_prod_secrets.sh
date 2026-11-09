#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# ReadyJLMirror — Production secrets bootstrap
# Run once on the server before `./deploy.sh`.
#
# Usage:
#   set -a && source .env.prod && set +a
#   bash scripts/setup_prod_secrets.sh
#
# Required env vars (from .env.prod):
#   APP_DB_PASSWORD           — password for jlmirror_app role
#   WORKER_DB_PASSWORD        — password for jlmirror_worker role
#   BFF_INTERNAL_SECRET       — HMAC secret for BFF→API context headers
#   KEYCLOAK_CLIENT_SECRET    — OIDC client credential
#   KEYCLOAK_ADMIN_PASSWORD   — Keycloak admin user password
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
require_var KEYCLOAK_ADMIN_PASSWORD
require_var NOTIFICATION_CALLBACK_SECRET
require_var SESSION_SECRET

# DB passwords — both names so config.py resolves db_password_jlmirror_app
# (specific) and db_password (fallback) with the same value.
printf '%s' "$APP_DB_PASSWORD"    > "$SECRETS_DIR/db_password"
printf '%s' "$APP_DB_PASSWORD"    > "$SECRETS_DIR/db_password_jlmirror_app"
printf '%s' "$WORKER_DB_PASSWORD" > "$SECRETS_DIR/db_password_jlmirror_worker"

# Application secrets
printf '%s' "$BFF_INTERNAL_SECRET"          > "$SECRETS_DIR/bff_internal_secret"
printf '%s' "$KEYCLOAK_CLIENT_SECRET"       > "$SECRETS_DIR/keycloak_client_secret"
printf '%s' "$KEYCLOAK_ADMIN_PASSWORD"      > "$SECRETS_DIR/keycloak_admin_password"
printf '%s' "$NOTIFICATION_CALLBACK_SECRET" > "$SECRETS_DIR/notification_callback_secret"
printf '%s' "$SESSION_SECRET"               > "$SECRETS_DIR/session_secret"

# 644: readable by container users (non-root uid), not writable.
# Secret files owned by root with 600 cannot be read inside containers.
chmod 644 \
  "$SECRETS_DIR/db_password" \
  "$SECRETS_DIR/db_password_jlmirror_app" \
  "$SECRETS_DIR/db_password_jlmirror_worker" \
  "$SECRETS_DIR/bff_internal_secret" \
  "$SECRETS_DIR/keycloak_client_secret" \
  "$SECRETS_DIR/keycloak_admin_password" \
  "$SECRETS_DIR/notification_callback_secret" \
  "$SECRETS_DIR/session_secret"

echo "Secrets written to $SECRETS_DIR/:"
ls -1 "$SECRETS_DIR/" | grep -Ev '^(tls|openbao|bao_token|README)$'
echo
echo "Next steps:"
echo "  1. mkdir -p $SECRETS_DIR/openbao"
echo "     openssl rand -base64 32 | tr -d '\\n' > $SECRETS_DIR/openbao/unseal.key"
echo "     chown 100:100 $SECRETS_DIR/openbao/unseal.key && chmod 644 $SECRETS_DIR/openbao/unseal.key"
echo "     chown 100:100 $SECRETS_DIR && chmod 755 $SECRETS_DIR"
echo "     chown 100:100 $SECRETS_DIR/openbao && chmod 750 $SECRETS_DIR/openbao"
echo "     echo 'OPENBAO_UNSEAL_KEY_PATH=./secrets/openbao/unseal.key' >> .env"
echo "  2. ./deploy.sh   (first pass — will pause asking for BAO_TOKEN)"
echo "  3. echo \"BAO_TOKEN=\$(cat $SECRETS_DIR/bao_token)\" >> .env"
echo "  4. ./deploy.sh   (second pass — brings up full stack)"
