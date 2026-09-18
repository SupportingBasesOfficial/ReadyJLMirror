"""DNS pinning — closes the resolve/screen TOCTOU gap.

The egress admission resolves the provider hostname ONCE, screens
the returned addresses, and pins the admitted URL to a chosen IP.
The Zabbix transport then connects to that IP directly (Host
header + sni_hostname extension keep TLS identity bound to the
original hostname) — no second DNS resolution exists for a rebind
attack to exploit.

In-process registry keyed by the admitted api_url: the canonical
AdmittedProviderEndpoint is frozen (api_url + decision ref), so the
pin travels beside it inside the worker process.
"""

from __future__ import annotations

import threading

_lock = threading.Lock()
_pins: dict[str, tuple[str, str]] = {}   # api_url -> (host, ip)


def pin(api_url: str, host: str, ip: str) -> None:
    with _lock:
        _pins[api_url] = (host, ip)


def get(api_url: str) -> tuple[str, str] | None:
    with _lock:
        return _pins.get(api_url)


def clear() -> None:
    with _lock:
        _pins.clear()
