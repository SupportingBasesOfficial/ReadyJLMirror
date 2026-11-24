#!/usr/bin/env bash
# Generate internal CA + mTLS certs for BFF↔API (Docker service names as SANs).
# Run once per environment. Never commit secrets/tls/ to git.
#
# Output: secrets/tls/
#   ca.key / ca.pem         — internal CA (keep ca.key offline after generation)
#   api-key.pem / api-cert.pem — API server cert  (SAN: DNS:api)
#   bff-key.pem / bff-cert.pem — BFF client cert  (mTLS auth to API)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$REPO_ROOT/secrets/tls"

mkdir -p "$OUT"
chmod 700 "$OUT"

if [[ -f "$OUT/ca.pem" ]]; then
  echo "ERROR: $OUT/ca.pem already exists." >&2
  echo "Delete secrets/tls/ and re-run to regenerate all certs." >&2
  exit 1
fi

gen_key() {
  openssl genpkey -algorithm EC -pkeyopt ec_paramgen_curve:P-256 -out "$1" 2>/dev/null
  chmod 600 "$1"
}

sign_cert() {
  local key="$1" cert_out="$2" cn="$3" san="$4" eku="$5"
  local csr ext
  csr=$(mktemp /tmp/jlm_csr.XXXXXX)
  ext=$(mktemp /tmp/jlm_ext.XXXXXX)
  # shellcheck disable=SC2064
  trap "rm -f '$csr' '$ext'" RETURN

  openssl req -new -key "$key" \
    -subj "/O=JLMirror Internal/CN=$cn" \
    -out "$csr" 2>/dev/null

  printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=%s\nsubjectAltName=%s\n' \
    "$eku" "$san" > "$ext"

  openssl x509 -req \
    -in "$csr" \
    -CA "$OUT/ca.pem" -CAkey "$OUT/ca.key" -CAcreateserial \
    -days 3650 -sha256 \
    -extfile "$ext" \
    -out "$cert_out" 2>/dev/null
}

echo "→ Generating internal CA..."
gen_key "$OUT/ca.key"
openssl req -new -x509 \
  -key "$OUT/ca.key" \
  -days 3650 -sha256 \
  -subj "/O=JLMirror Internal/CN=JLMirror Internal CA" \
  -out "$OUT/ca.pem" 2>/dev/null

echo "→ Generating API server cert (SAN: DNS:api)..."
gen_key "$OUT/api-key.pem"
sign_cert "$OUT/api-key.pem" "$OUT/api-cert.pem" \
  "JLMirror API" "DNS:api" "serverAuth"

echo "→ Generating BFF client cert (mTLS auth to API)..."
gen_key "$OUT/bff-key.pem"
sign_cert "$OUT/bff-key.pem" "$OUT/bff-cert.pem" \
  "JLMirror BFF" "DNS:bff" "clientAuth"

echo ""
echo "Done. Files in $OUT:"
ls -1 "$OUT"
echo ""
echo "Next steps:"
echo "  1. Verify: openssl verify -CAfile $OUT/ca.pem $OUT/api-cert.pem $OUT/bff-cert.pem"
echo "  2. Keep ca.key offline (remove from server after deploy if paranoid)"
echo "  3. These certs expire in 10 years — set a calendar reminder to rotate"
