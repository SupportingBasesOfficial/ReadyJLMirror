"""Outbound admission — fail-closed egress boundary.

Development: admits `https://` endpoints targeting `/api_jsonrpc.php`
with an optional host allowlist via `EGRESS_ALLOW_HOSTS` (comma-separated).
Production: the governed egress policy engine (DNS/IP/protocol/redirect
enforcement) behind this same port.
"""

from __future__ import annotations

import os
import secrets
from urllib.parse import urlparse

from jlmirror_monitoring.source import ZabbixProviderConfiguration
from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
    EgressAdmissionError,
)


class DevOutboundAdmission:
    """Development egress admission — https + optional host allowlist."""

    def admit_zabbix_api(
        self, provider_configuration: ZabbixProviderConfiguration
    ) -> AdmittedProviderEndpoint:
        base = provider_configuration.base_url.rstrip("/")
        parsed = urlparse(base)
        if parsed.scheme != "https":
            raise EgressAdmissionError("provider base_url must use https")

        allow_hosts = {
            h.strip().lower()
            for h in os.environ.get("EGRESS_ALLOW_HOSTS", "").split(",")
            if h.strip()
        }
        if allow_hosts and parsed.hostname and parsed.hostname.lower() not in allow_hosts:
            raise EgressAdmissionError(
                f"host {parsed.hostname} not in EGRESS_ALLOW_HOSTS"
            )

        api_url = base + "/api_jsonrpc.php"
        return AdmittedProviderEndpoint(
            api_url=api_url,
            egress_decision_ref=f"egress-dev-{secrets.token_urlsafe(8)}",
        )
