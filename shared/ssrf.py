"""SSRF protection for outbound HTTP calls (webhooks, integrations).

Rejects URLs that resolve to private/internal/loopback addresses, so that
a tenant admin cannot configure a webhook that reaches internal services.
"""

from __future__ import annotations

import ipaddress
import socket
from urllib.parse import urlparse

_BLOCKED_NETWORKS = [
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
]


def _addr_blocked(addr_str: str) -> bool:
    try:
        addr = ipaddress.ip_address(addr_str)
        if addr.is_private or addr.is_loopback or addr.is_link_local or addr.is_reserved:
            return True
        return any(addr in net for net in _BLOCKED_NETWORKS)
    except ValueError:
        return True


def validate_outbound_url(url: str) -> str | None:
    """Return None if the URL is safe, or an error string if it should be rejected.

    Checks:
    - Must be https://
    - Must have a resolvable hostname
    - Hostname must not resolve to any private/internal address (all A/AAAA records)
    """
    if not url or not url.startswith("https://"):
        return "URL must start with https://"

    parsed = urlparse(url)
    hostname = parsed.hostname
    if not hostname:
        return "URL has no hostname"

    if hostname.lower() in ("localhost", "metadata.google.internal",
                             "169.254.169.254", "fd00::ec2", "[::]"):
        return f"hostname '{hostname}' is not allowed"

    try:
        infos = socket.getaddrinfo(hostname, parsed.port or 443)
    except socket.gaierror as exc:
        return f"hostname '{hostname}' could not be resolved: {exc}"

    for info in infos:
        addr_str = info[4][0]
        if _addr_blocked(addr_str):
            return f"hostname '{hostname}' resolves to a private/internal address"

    return None
