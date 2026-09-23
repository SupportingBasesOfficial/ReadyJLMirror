# OpenBao dev server — persistent file storage + static auto-unseal.
#
# Replaces `server -dev` (in-memory) so onboarded credentials survive
# restarts. The static seal key is a committed DEV constant — same
# posture as the dev DB password and BAO_DEV_ROOT_TOKEN_ID it replaces.
# Production uses a real seal (KMS/HSM) and managed storage.

storage "raft" {
  path    = "/openbao/raft"
  node_id = "dev-node-1"
}

listener "tcp" {
  address     = "0.0.0.0:8200"
  tls_disable = true
}

seal "static" {
  current_key_id = "dev-static-1"
  current_key    = "file:///openbao/keys/unseal.key"
}

api_addr     = "http://openbao:8200"
cluster_addr = "http://openbao:8201"

ui            = true
disable_mlock = true
