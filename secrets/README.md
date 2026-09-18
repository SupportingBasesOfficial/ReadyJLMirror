# Mounted credentials directory

The credential resolver reads `<binding-ref>.token` files here —
the Kubernetes/docker-secrets pattern.

Dev: drop a file named after the binding ref you onboard, e.g.

    secrets/cred-binding-1.token   →   credential_binding_ref "cred-binding-1"

File contents: the Zabbix API token, single line.

Production: a secrets backend (Vault/OpenBao Agent, CSI driver)
injects the same layout — the resolver interface is unchanged.

`*.token` files are gitignored; this README is the only tracked file.

## Service secrets (shared.config `_secret`)

Mounted files also override env vars for service secrets — file names:

    db_password_<db_user>   e.g. db_password_jlmirror_app
    db_password             generic fallback
    bff_internal_secret     BFF -> API HMAC key
    keycloak_client_secret  OIDC client secret

Env vars (DB_PASSWORD, BFF_INTERNAL_SECRET, KEYCLOAK_CLIENT_SECRET)
remain the development fallback when no file is present.
