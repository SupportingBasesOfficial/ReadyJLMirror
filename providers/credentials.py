"""Credential resolver — abstract secret boundary.

Resolution order (chained):

1. **OpenBao KV v2** (when ``BAO_ADDR`` + ``BAO_TOKEN`` set):
   ``secret/data/jlmirror/credentials`` holds ``<binding-ref>:
   <token>`` keys; resolved live with a short cache so rotation
   propagates without a remount.
2. **Mounted secrets directory** (`CREDENTIALS_DIR`, default
   ``/run/secrets``): ``<dir>/<binding-ref>.token`` — the
   Kubernetes/docker-secrets pattern; works against a real secrets
   backend that syncs files (Vault Agent, OpenBao injector, CSI).
3. **Environment variables** (development fallback):
   ``ZABBIX_CRED_<REF>`` where REF is the ref uppercased with
   non-alphanumerics as ``_``.

The raw token exists only in memory — never persisted by the
resolver, never logged. A missing credential raises
``CredentialResolutionError`` so the worker emits
``credential.unavailable`` evidence instead of failing silently.

Onboarding dual-writes: the token goes to OpenBao when configured
(authoritative store) and to the mounted directory (worker
fallback). Only the binding ref reaches PostgreSQL.
"""

from __future__ import annotations

import os
import re
from pathlib import Path

from jlmirror_monitoring.validation_worker import (
    CredentialResolutionError,
    ResolvedZabbixCredential,
)

_ENV_RE = re.compile(r"[^A-Za-z0-9]")
_REF_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")


class FileSecretsResolver:
    """Mounted-secrets-directory credential resolver.

    Reads ``<CREDENTIALS_DIR>/<credential_binding_ref>.token``.
    The binding ref is validated against a strict charset — the
    filesystem is never allowed to resolve path traversal.
    """

    def __init__(self, secrets_dir: str | Path | None = None) -> None:
        self._dir = Path(
            secrets_dir
            or os.environ.get("CREDENTIALS_DIR", "/run/secrets")
        )

    def resolve_zabbix_api_token(
        self, credential_binding_ref: str
    ) -> ResolvedZabbixCredential:
        if not _REF_SAFE.match(credential_binding_ref):
            raise CredentialResolutionError(
                "credential binding ref is not a safe file component"
            )
        path = self._dir / f"{credential_binding_ref}.token"
        try:
            token = path.read_text(encoding="utf-8").strip()
        except (OSError, ValueError):
            token = ""
        if not token:
            raise CredentialResolutionError(
                f"credential unavailable for binding ref ({path} unreadable)"
            )
        return ResolvedZabbixCredential(
            api_token=token,
            credential_generation_ref=f"cred-gen-file:{path.name}",
        )


def write_binding_token(
    credential_binding_ref: str,
    token: str,
    secrets_dir: str | Path | None = None,
) -> Path:
    """Persist a provider token into the secrets store.

    Used by the API when a tenant supplies the token at onboarding
    instead of pre-seeding the file. The token is written atomically
    (temp file + rename) with 0600 permissions; it is never logged
    and never reaches the database — only the binding ref is stored.
    """
    if not _REF_SAFE.match(credential_binding_ref):
        raise CredentialResolutionError(
            "credential binding ref is not a safe file component"
        )
    token = token.strip()
    if not token:
        raise CredentialResolutionError("credential token is empty")
    directory = Path(
        secrets_dir or os.environ.get("CREDENTIALS_DIR", "/run/secrets")
    )
    directory.mkdir(parents=True, exist_ok=True)
    target = directory / f"{credential_binding_ref}.token"
    tmp = directory / f".{credential_binding_ref}.{os.getpid()}.tmp"
    tmp.write_text(token + "\n", encoding="utf-8")
    tmp.chmod(0o600)
    os.replace(tmp, target)
    return target


class BaoCredentialResolver:
    """OpenBao KV v2 credential resolver (runtime injection).

    Reads ``secret/data/jlmirror/credentials`` and picks
    ``<credential_binding_ref>`` from the versioned KV document —
    the same layout ``scripts.bao_sync`` materializes to files, but
    resolved live so rotation propagates without a remount.

    Enabled only when ``BAO_ADDR`` is set; the token comes from
    ``BAO_TOKEN`` or the ``$SECRETS_DIR/bao_token`` file. Responses
    are cached for ``BAO_CACHE_SECONDS`` (default 30s) so a poll
    burst does not hammer the vault — staleness beyond that is a
    rotation delay, not a correctness risk (old tokens still work
    until revoked at the provider).
    """

    def __init__(self, addr: str | None = None, token: str | None = None,
                 cache_seconds: float | None = None) -> None:
        import time as _time
        self._addr = (addr or os.environ.get("BAO_ADDR", "")).rstrip("/")
        self._token = token or os.environ.get("BAO_TOKEN") or self._read_token_file()
        self._cache_seconds = float(
            cache_seconds
            if cache_seconds is not None
            else os.environ.get("BAO_CACHE_SECONDS", "30"))
        self._time = _time
        self._cache: dict[str, tuple[float, ResolvedZabbixCredential]] = {}

    @staticmethod
    def _read_token_file() -> str | None:
        path = Path(os.environ.get("SECRETS_DIR", "/run/secrets")) / "bao_token"
        try:
            return path.read_text(encoding="utf-8").strip() or None
        except OSError:
            return None

    @property
    def available(self) -> bool:
        return bool(self._addr and self._token)

    def _fetch_document(self) -> dict:
        import urllib.error
        import urllib.request
        import json as _json
        req = urllib.request.Request(
            f"{self._addr}/v1/secret/data/jlmirror/credentials",
            headers={"X-Vault-Token": self._token})
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                body = _json.loads(resp.read() or b"{}")
        except (urllib.error.URLError, OSError, ValueError) as exc:
            raise CredentialResolutionError(
                f"credential unavailable (bao unreachable: {exc})"
            ) from exc
        return body.get("data", {}).get("data", {})

    def resolve_zabbix_api_token(
        self, credential_binding_ref: str
    ) -> ResolvedZabbixCredential:
        if not self.available:
            raise CredentialResolutionError(
                "credential unavailable (bao resolver not configured)")
        now = self._time.monotonic()
        hit = self._cache.get(credential_binding_ref)
        if hit and now - hit[0] < self._cache_seconds:
            return hit[1]
        document = self._fetch_document()
        token = str(document.get(credential_binding_ref, "")).strip()
        if not token:
            raise CredentialResolutionError(
                "credential unavailable for binding ref "
                "(not present in bao KV)")
        resolved = ResolvedZabbixCredential(
            api_token=token,
            credential_generation_ref=f"cred-gen-bao:{credential_binding_ref}")
        self._cache[credential_binding_ref] = (now, resolved)
        return resolved

    def store_zabbix_api_token(
        self, credential_binding_ref: str, token: str
    ) -> None:
        """Merge a provider token into the KV credentials document.

        KV v2 has no per-key patch — the document is read, the ref
        merged in, and the whole document written back. Used by
        onboarding so the token lands in the authoritative store
        (not just the mounted-file fallback). Invalidates the local
        cache entry so the next resolve sees the new token.
        """
        if not self.available:
            raise CredentialResolutionError(
                "credential store unavailable (bao not configured)")
        if not _REF_SAFE.match(credential_binding_ref):
            raise CredentialResolutionError(
                "credential binding ref is not a safe KV key")
        token = token.strip()
        if not token:
            raise CredentialResolutionError("credential token is empty")
        document = self._fetch_document()
        document[credential_binding_ref] = token
        self._put_document(document)
        self._cache.pop(credential_binding_ref, None)

    def _put_document(self, document: dict) -> None:
        import urllib.error
        import urllib.request
        import json as _json
        req = urllib.request.Request(
            f"{self._addr}/v1/secret/data/jlmirror/credentials",
            data=_json.dumps({"data": document}).encode("utf-8"),
            headers={"X-Vault-Token": self._token,
                     "Content-Type": "application/json"},
            method="POST")
        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                resp.read()
        except (urllib.error.URLError, OSError) as exc:
            raise CredentialResolutionError(
                f"credential store unavailable (bao write: {exc})"
            ) from exc


class EnvCredentialResolver:
    """Environment-variable credential resolver (development)."""

    def resolve_zabbix_api_token(
        self, credential_binding_ref: str
    ) -> ResolvedZabbixCredential:
        env_name = "ZABBIX_CRED_" + _ENV_RE.sub("_", credential_binding_ref).upper()
        token = os.environ.get(env_name)
        if not token:
            raise CredentialResolutionError(
                f"credential unavailable for binding ref (env {env_name} unset)"
            )
        return ResolvedZabbixCredential(
            api_token=token,
            credential_generation_ref=f"cred-gen-env:{env_name}",
        )


class ChainedCredentialResolver:
    """Try resolvers in order; first success wins.

    Mounted secrets take precedence over env vars — a deployed
    secrets backend silently upgrades resolution without code
    changes, and env remains a development fallback.
    """

    def __init__(self, *resolvers) -> None:
        if resolvers:
            self._resolvers = resolvers
            return
        # Default chain: OpenBao runtime first when configured, then
        # the mounted-secrets directory, then env as dev fallback.
        chain: list = []
        bao = BaoCredentialResolver()
        if bao.available:
            chain.append(bao)
        chain += [FileSecretsResolver(), EnvCredentialResolver()]
        self._resolvers = tuple(chain)

    def resolve_zabbix_api_token(
        self, credential_binding_ref: str
    ) -> ResolvedZabbixCredential:
        last_error: CredentialResolutionError | None = None
        for resolver in self._resolvers:
            try:
                return resolver.resolve_zabbix_api_token(
                    credential_binding_ref)
            except CredentialResolutionError as exc:
                last_error = exc
        raise last_error or CredentialResolutionError(
            "no credential resolvers configured")
