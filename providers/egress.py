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
   still bound to the allowlist). The host resolves ONCE here and
   the admitted IP is pinned — the transport connects to that IP
   with Host/SNI bound to the hostname (no connect-time re-resolve,
   so no DNS-rebinding TOCTOU).
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

        api_url = base + "/api_jsonrpc.php"
        private_mode = _env_flag("EGRESS_ALLOW_PRIVATE_IPS")
        try:
            ips = self._resolve(host)
        except EgressAdmissionError:
            if not private_mode:
                raise
            # Intranet mode already accepts the operator-declared
            # private target; an unresolvable-at-admission host is
            # admitted without a pin (same posture as before).
            ips = []
        if not private_mode:
            self._screen_ips(host, ips)
        # DNS pinning: the transport connects to the admitted IP
        # (Host/SNI keep the hostname identity) — no second lookup.
        if ips:
            from providers import pins
            pins.pin(api_url, host, ips[0])
        return AdmittedProviderEndpoint(
            api_url=api_url,
            egress_decision_ref=f"egress-dev-{secrets.token_urlsafe(8)}",
        )

    @staticmethod
    def _resolve(host: str) -> list[str]:
        """Resolve the host once — the single DNS point of truth."""
        # IP literals need no lookup.
        try:
            ipaddress.ip_address(host)
            return [host]
        except ValueError:
            pass
        try:
            infos = socket.getaddrinfo(host, None)
        except socket.gaierror as exc:
            raise EgressAdmissionError(
                f"host {host} does not resolve") from exc
        addrs = []
        for i in infos:
            ip = str(ipaddress.ip_address(i[4][0]))
            if ip not in addrs:
                addrs.append(ip)
        if not addrs:
            raise EgressAdmissionError(f"host {host} has no addresses")
        return addrs

    @staticmethod
    def _screen_ips(host: str, ips: list[str]) -> None:
        """Deny non-public destinations (SSRF) among the resolved set."""
        blocked = {
            ip for ip in ips
            if _blocked_ip(ipaddress.ip_address(ip))
        }
        if blocked:
            raise EgressAdmissionError(
                f"host {host} resolves to non-public address(es): "
                + ", ".join(sorted(blocked))
            )
