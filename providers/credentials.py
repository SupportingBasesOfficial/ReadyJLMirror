"""Credential resolver — abstract secret boundary.

Development: resolves `credential_binding_ref` to in-memory token
material from environment variables (`ZABBIX_CRED_<REF>` where REF is
the ref uppercased with non-alphanumerics as `_`). The raw token exists
only in memory — never persisted, never logged.

Production: OpenBao Transit (D3 candidate) or the accepted secret
manager, behind this same port.
"""

from __future__ import annotations

import os
import re

from jlmirror_monitoring.validation_worker import (
    CredentialResolutionError,
    ResolvedZabbixCredential,
)

_ENV_RE = re.compile(r"[^A-Za-z0-9]")


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
