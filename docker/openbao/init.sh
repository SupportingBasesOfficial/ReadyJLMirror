#!/bin/sh
# OpenBao one-shot init for the persistent dev server.
# - waits for the listener, initializes once, enables KV v2 at secret/
# - writes the root token to /secrets/bao_token (the file the
#   BaoCredentialResolver falls back to when BAO_TOKEN is unset)
# Idempotent: exits 0 when already initialized.
set -u

BAO_ADDR="${BAO_ADDR:-http://openbao:8200}"
export BAO_ADDR

for i in $(seq 1 30); do
  if bao status >/dev/null 2>&1; then break; fi
  # status exits 2 while sealed/uninitialized-but-up — also fine
  if bao status 2>&1 | grep -q "Initialized"; then break; fi
  sleep 2
done

if bao operator init -status 2>/dev/null | grep -q "true"; then
  echo "openbao already initialized"
else
  echo "initializing openbao..."
  # Static seal has no shamir shares — bare init returns a root token.
  out=$(bao operator init -format=json)
  token=$(printf '%s' "$out" | sed -n 's/.*"root_token": *"\([^"]*\)".*/\1/p')
  if [ -z "$token" ]; then
    echo "init failed: $out" >&2
    exit 1
  fi
  printf '%s' "$token" > /secrets/bao_token
  chmod 600 /secrets/bao_token 2>/dev/null || true
  echo "root token written to /secrets/bao_token"
fi

# Dev-mode servers mount secret/ automatically; a file-storage server
# does not — enable KV v2 if absent.
token=$(cat /secrets/bao_token 2>/dev/null || true)
if [ -n "$token" ]; then
  if ! BAO_TOKEN="$token" bao secrets list -format=json 2>/dev/null \
       | grep -q '"secret/"'; then
    BAO_TOKEN="$token" bao secrets enable -path=secret kv-v2
    echo "enabled kv-v2 at secret/"
  fi
fi
echo "openbao init done"
