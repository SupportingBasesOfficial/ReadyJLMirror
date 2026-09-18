"""Outbound admission — fail-closed egress policy boundary.

Enforcement layers (all applied before any request leaves):

1. **Scheme** — https only (canonical provider config already
   requires it; re-verified here as a defense layer).
2. **Host allowlist** — `EGRESS_ALLOW_HOSTS` (comma-separated) is
   required; `EGRESS_ALLOW_ALL_HOSTS=true` exists only for local
   development and must never be set in deployed environments.
3. **DNS screen** — the hostname must resolve; every returned
   address is screened and private/loopback/link-local/
   multicast/reserved targets are denied unless
   `EGRESS_ALLOW_PRIVATE_IPS=true` (intranet Zabbix deployments,
   still bound to the allowlist). TOCTOU note: httpx re-resolves at
   connect time — true DNS pinning (resolve-once + connect-to-IP
   with Host/SNI) belongs to the production engine behind this port.
4. **No redirect following** — the Zabbix transport performs a
   single POST; redirects are not followed anywhere.

Production: the governed egress policy engine (per-tenant policy,
deny-by-default CIDR/DNS rules, audit logging) binds this same
`OutboundAdmission` port — only the decision engine differs.
"""

from __future__ import annotations

import ipaddress
import os
import secrets
import socket
from urllib.parse import urlparse

from jlmirror_monitoring.source import ZabbixProviderConfiguration
from jlmirror_monitoring.validation_worker import (
    AdmittedProviderEndpoint,
    EgressAdmissionError,
)


def _env_flag(name: str) -> bool:
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes")


def _env_hosts() -> set[str]:
    return {
        h.strip().lower()
        for h in os.environ.get("EGRESS_ALLOW_HOSTS", "").split(",")
        if h.strip()
    }


def _blocked_ip(ip: ipaddress.IPv4Address | ipaddress.IPv6Address) -> bool:
    return (
        ip.is_private or ip.is_loopback or ip.is_link_local
        or ip.is_multicast or ip.is_reserved or ip.is_unspecified
    )


class DevOutboundAdmission:
    """Fail-closed egress admission.

    Development defaults are safe: no allowlist and no explicit
    allow-all flag means every target is denied. Intranet providers
    require EGRESS_ALLOW_PRIVATE_IPS in addition to the allowlist.
    """

    def admit_zabbix_api(
        self, provider_configuration: ZabbixProviderConfiguration
    ) -> AdmittedProviderEndpoint:
        base = provider_configuration.base_url.rstrip("/")
        parsed = urlparse(base)
        if parsed.scheme != "https":
            raise EgressAdmissionError("provider base_url must use https")
        host = (parsed.hostname or "").lower()
        if not host:
            raise EgressAdmissionError("provider base_url requires a host")

        allow_hosts = _env_hosts()
        if not _env_flag("EGRESS_ALLOW_ALL_HOSTS"):
            if not allow_hosts:
                raise EgressAdmissionError(
                    "EGRESS_ALLOW_HOSTS required (or explicit "
                    "EGRESS_ALLOW_ALL_HOSTS for local dev)"
                )
            if host not in allow_hosts:
                raise EgressAdmissionError(
                    f"host {host} not in EGRESS_ALLOW_HOSTS"
                )

        if not _env_flag("EGRESS_ALLOW_PRIVATE_IPS"):
            self._screen_dns(host)

        api_url = base + "/api_jsonrpc.php"
        return AdmittedProviderEndpoint(
            api_url=api_url,
            egress_decision_ref=f"egress-dev-{secrets.token_urlsafe(8)}",
        )

    @staticmethod
    def _screen_dns(host: str) -> None:
        """Resolve the host and deny non-public destinations (SSRF)."""
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror as exc:
            raise EgressAdmissionError(
                f"host {host} does not resolve") from exc
        blocked = {
            str(ipaddress.ip_address(i[4][0])) for i in infos
            if _blocked_ip(ipaddress.ip_address(i[4][0]))
        }
        if blocked:
            raise EgressAdmissionError(
                f"host {host} resolves to non-public address(es): "
                + ", ".join(sorted(blocked))
            )
