"""In-process SLO probe (ADR-017) — request latency observations by
endpoint class, in a bounded ring buffer.

No metrics backend in dev: this keeps per-endpoint latency
distribution (count, error rate, p50/p95/p99 over the last N
requests) in-process so /api/v1/observability/slo can surface it.
Production replaces this with the governed metrics stack; the
observation points stay the same.
"""

from __future__ import annotations

import threading
import time
from collections import defaultdict, deque

_WINDOW = 512
_lock = threading.Lock()
_samples: dict[str, deque] = defaultdict(
    lambda: deque(maxlen=_WINDOW))


def record(path: str, method: str, status: int,
           duration_s: float) -> None:
    key = f"{method} {_classify(path)}"
    with _lock:
        _samples[key].append((duration_s, status))


def _classify(path: str) -> str:
    """Normalize path params so the histogram doesn't explode."""
    parts = path.split("/")
    out = []
    for p in parts:
        if p.startswith(("mon-src_", "mon-op_", "alt_", "alt-tr_",
                         "mon-prob_", "mon-res_", "mon-def_")):
            out.append("{id}")
        else:
            out.append(p)
    return "/".join(out)


def snapshot() -> dict:
    with _lock:
        data = {k: list(v) for k, v in _samples.items()}
    result = {}
    for key, samples in sorted(data.items()):
        durs = sorted(d for d, _ in samples)
        n = len(durs)
        errors = sum(1 for _, s in samples if s >= 500)
        result[key] = {
            "requests": n,
            "error_rate": round(errors / n, 4) if n else 0,
            "p50_ms": round(durs[int(n * 0.50)] * 1000, 1),
            "p95_ms": round(durs[int(min(n - 1, n * 0.95))] * 1000, 1),
            "p99_ms": round(durs[int(min(n - 1, n * 0.99))] * 1000, 1),
        }
    return result


class SloMiddleware:
    """ASGI middleware — wraps every request and records latency."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = time.perf_counter()
        status_code = 500

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message["status"]
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        finally:
            record(scope["path"], scope["method"], status_code,
                   time.perf_counter() - started)
