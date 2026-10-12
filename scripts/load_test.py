"""Async load test for ReadyJLMirror — G14 Production Release Gate.

Usage:
    python -m scripts.load_test [--url URL] [--users N] [--duration S] [--token TOKEN]

Exit 0  if error_rate < 1% AND p99 < 2000 ms.
Exit 1  otherwise.

Errors are counted as: network exception OR HTTP 5xx.
4xx responses (e.g. 401 without a session) are expected and not errors.
"""
from __future__ import annotations

import argparse
import asyncio
import sys
import time
from collections import defaultdict
from dataclasses import dataclass

import httpx

# Endpoints in round-robin order (one rotation = one full pass per virtual user).
# Paths are verified against bff/main.py + api/routers:
#   /health               → BFF liveness (no auth)
#   /api/v1/alerting/alerts      → BFF → API alerting router
#   /api/v1/monitoring/sources   → BFF → API monitoring router
#   /api/v1/infra/assets         → BFF → API infra router
_ENDPOINTS: list[tuple[str, str]] = [
    ("GET", "/health"),
    ("GET", "/api/v1/alerting/alerts"),
    ("GET", "/api/v1/monitoring/sources"),
    ("GET", "/api/v1/infra/assets"),
]


@dataclass
class _Sample:
    path: str
    latency_ms: float
    status: int
    error: bool


async def _run_user(
    client: httpx.AsyncClient,
    base_url: str,
    stop_at: float,
    bucket: list[_Sample],
    start_idx: int,
) -> None:
    idx = start_idx
    n = len(_ENDPOINTS)
    while time.monotonic() < stop_at:
        method, path = _ENDPOINTS[idx % n]
        url = base_url + path
        t0 = time.monotonic()
        status = 0
        error = False
        try:
            r = await client.request(method, url)
            status = r.status_code
            error = status >= 500
        except Exception:
            error = True
        bucket.append(_Sample(path, (time.monotonic() - t0) * 1000, status, error))
        idx += 1
        await asyncio.sleep(0)  # cooperative yield


def _pct(data: list[float], p: float) -> float:
    if not data:
        return 0.0
    s = sorted(data)
    k = (len(s) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def _report(samples: list[_Sample], elapsed: float) -> tuple[float, float]:
    """Print summary table; return (error_rate_pct, p99_ms)."""
    total = len(samples)
    if total == 0:
        print("No samples collected.")
        return 100.0, float("inf")

    errors = sum(1 for s in samples if s.error)
    error_rate = errors / total * 100
    all_lat = [s.latency_ms for s in samples]
    rps = total / elapsed if elapsed > 0 else 0

    print(f"\n{'=' * 60}")
    print("  LOAD TEST RESULTS")
    print(f"{'=' * 60}")
    print(f"  Requests total : {total}")
    print(f"  Requests/sec   : {rps:.1f}")
    print(f"  Error rate     : {error_rate:.2f}%")
    print(f"  p50 latency    : {_pct(all_lat, 50):.1f} ms")
    print(f"  p95 latency    : {_pct(all_lat, 95):.1f} ms")
    print(f"  p99 latency    : {_pct(all_lat, 99):.1f} ms")
    print(f"{'=' * 60}")

    by_path: dict[str, list[_Sample]] = defaultdict(list)
    for s in samples:
        by_path[s.path].append(s)

    print(f"\n  {'Endpoint':<38} {'Reqs':>5} {'Err%':>5} {'p50':>7} {'p95':>7} {'p99':>7}")
    print(f"  {'-' * 73}")
    for _, path in _ENDPOINTS:
        ep = by_path.get(path, [])
        if not ep:
            continue
        lat = [s.latency_ms for s in ep]
        errs = sum(1 for s in ep if s.error)
        print(
            f"  {path:<38} {len(ep):>5} {errs / len(ep) * 100:>4.1f}%"
            f" {_pct(lat, 50):>6.0f} {_pct(lat, 95):>6.0f} {_pct(lat, 99):>6.0f}"
        )
    print()
    return error_rate, _pct(all_lat, 99)


async def main() -> int:
    ap = argparse.ArgumentParser(description="ReadyJLMirror async load test")
    ap.add_argument("--url", default="http://localhost:8080", help="Base URL")
    ap.add_argument("--users", type=int, default=20, help="Concurrent virtual users")
    ap.add_argument("--duration", type=int, default=60, help="Test duration (seconds)")
    ap.add_argument("--token", default=None, help="Bearer token for authenticated endpoints")
    args = ap.parse_args()

    base_url = args.url.rstrip("/")
    headers: dict[str, str] = {}
    if args.token:
        headers["Authorization"] = f"Bearer {args.token}"

    print(f"Target  : {base_url}")
    print(f"Users   : {args.users}")
    print(f"Duration: {args.duration}s")

    limits = httpx.Limits(max_connections=args.users + 4, max_keepalive_connections=args.users)
    async with httpx.AsyncClient(
        headers=headers, timeout=10.0, verify=False, limits=limits
    ) as client:
        print("Warming up (2 s)…")
        await asyncio.sleep(2)

        samples: list[_Sample] = []
        stop_at = time.monotonic() + args.duration
        t_start = time.monotonic()
        await asyncio.gather(
            *[
                asyncio.create_task(_run_user(client, base_url, stop_at, samples, i))
                for i in range(args.users)
            ]
        )
        elapsed = time.monotonic() - t_start

    error_rate, p99 = _report(samples, elapsed)

    passed = error_rate < 1.0 and p99 < 2000.0
    verdict = "PASS" if passed else "FAIL"
    print(f"{verdict}: error_rate={error_rate:.2f}% p99={p99:.0f}ms "
          f"(thresholds: <1% / <2000ms)")
    return 0 if passed else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
