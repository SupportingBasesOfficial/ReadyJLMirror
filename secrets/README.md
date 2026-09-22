# Mounted credentials directories

Two mounted paths, different trust levels:

## `secrets/` — infrastructure secrets (read-only everywhere)

db_password, bff_internal_secret, TLS certs. Never written by the
application. Managed by the operator / secrets backend.

## `secrets-tokens/` — provider credential bindings

The credential resolver reads `<binding-ref>.token` files here —
the Kubernetes/docker-secrets pattern.

Dev: drop a file named after the binding ref you onboard, e.g.

    secrets-tokens/cred-binding-1.token   →   credential_binding_ref "cred-binding-1"

File contents: the provider API token, single line.

**Or let the UI write it**: the onboarding form accepts an optional
`api_token` — the API writes it here atomically (0600) before the
source is created. The token transits once (TLS in prod), is never
logged, and never reaches the database.

Mounting: the API mounts this dir read-write (it is the only writer);
the worker mounts it read-only. Infra secrets in `secrets/` stay
read-only for both.

Production: a secrets backend (Vault/OpenBao Agent, CSI driver)
injects the same files — the resolver path is unchanged.
