# Mounted credentials directory

The credential resolver reads `<binding-ref>.token` files here —
the Kubernetes/docker-secrets pattern.

Dev: drop a file named after the binding ref you onboard, e.g.

    secrets/cred-binding-1.token   →   credential_binding_ref "cred-binding-1"

File contents: the Zabbix API token, single line.

Production: a secrets backend (Vault/OpenBao Agent, CSI driver)
injects the same layout — the resolver interface is unchanged.

`*.token` files are gitignored; this README is the only tracked file.
