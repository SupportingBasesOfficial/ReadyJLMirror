"""Credential resolver — abstract secret boundary.

Resolution order (chained):

1. **Mounted secrets directory** (`CREDENTIALS_DIR`, default
   ``/run/secrets``): ``<dir>/<binding-ref>.token`` — the
   Kubernetes/docker-secrets pattern; works against a real secrets
   backend that syncs files (Vault Agent, OpenBao injector, CSI).
2. **Environment variables** (development fallback):
   ``ZABBIX_CRED_<REF>`` where REF is the ref uppercased with
   non-alphanumerics as ``_``.

The raw token exists only in memory — never persisted by the
resolver, never logged. A missing credential raises
``CredentialResolutionError`` so the worker emits
``credential.unavailable`` evidence instead of failing silently.

Production: OpenBao/Vault Agent injecting the same mounted files
keeps this interface unchanged — only the sync mechanism differs.
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
        self._resolvers = resolvers or (
            FileSecretsResolver(), EnvCredentialResolver())

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
