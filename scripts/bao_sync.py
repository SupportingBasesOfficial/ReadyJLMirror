"""OpenBao -> mounted secrets sync (dev secrets backend).

Materializes secrets from OpenBao KV v2 into the local `secrets/`
directory — the exact layout every service already resolves
(shared.config._secret + providers.credentials.FileSecretsResolver).
This is what Vault Agent / the OpenBao injector does in production;
here a script performs the same materialization step.

    docker compose --profile secrets up -d openbao
    python -m scripts.bao_sync --seed     # dev: seed + sync
    python -m scripts.bao_sync            # just sync

KV layout: secret/data/jlmirror/{db_password,bff_internal_secret,
keycloak_client_secret} and secret/data/jlmirror/credentials/
{binding-ref}_token per provider binding ref.

Env: BAO_ADDR (default http://localhost:8200), BAO_TOKEN.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

BAO_ADDR = os.environ.get("BAO_ADDR", "http://localhost:8200").rstrip("/")
BAO_TOKEN = os.environ.get("BAO_TOKEN", "dev-root-token")
OUT = Path(os.environ.get("SECRETS_DIR", "secrets"))

# Dev bootstrap values — equal to the current env fallbacks so the
# seeded vault reproduces the same clone-and-run defaults.
SEED = {
    "jlmirror": {
        "db_password": "jlmirror_dev",
        "bff_internal_secret": "dev-internal-secret-change-me",
        "keycloak_client_secret": "dev-bff-secret-change-me",
    },
    "jlmirror/credentials": {
        "cred-binding-1": "dev-token",
    },
}


def _req(method: str, path: str, body: dict | None = None) -> dict:
    req = urllib.request.Request(
        f"{BAO_ADDR}/v1/{path}",
        method=method,
        data=json.dumps(body).encode() if body else None,
        headers={"X-Vault-Token": BAO_TOKEN,
                 "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as exc:
        raise RuntimeError(
            f"bao {method} {path}: HTTP {exc.code} {exc.read()[:200]}") from exc


def _put(path: str, data: dict) -> None:
    _req("POST", f"secret/data/{path}", {"data": data})


def _get(path: str) -> dict:
    return _req("GET", f"secret/data/{path}")["data"]["data"]


def _write(name: str, value: str) -> None:
    p = OUT / name
    p.write_text(str(value).strip() + "\n", encoding="utf-8")
    try:
        p.chmod(0o600)
    except OSError:
        pass
    print(f"  wrote {p}")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--seed", action="store_true",
                    help="write dev seed values first")
    args = ap.parse_args()
    OUT.mkdir(parents=True, exist_ok=True)

    if args.seed:
        for path, data in SEED.items():
            _put(path, data)
            print(f"seeded secret/{path}: {sorted(data)}")

    print(f"syncing from {BAO_ADDR} -> {OUT}/")
    core = _get("jlmirror")
    for key in ("db_password", "bff_internal_secret",
                "keycloak_client_secret"):
        if key in core:
            _write(key, core[key])

    creds = _get("jlmirror/credentials")
    for ref, token in creds.items():
        _write(f"{ref}.token", token)

    print("done — services resolve these files on next start")


if __name__ == "__main__":
    sys.exit(main())
