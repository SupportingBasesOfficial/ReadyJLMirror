"""ADR-017 chaos matrix — fault injection per dependency against the
declared failure modes.

Stops one dependency at a time, verifies the declared readiness
behavior, restores it, and reports PASS/FAIL per scenario. Runs
against the live compose stack — destructive to availability only
seconds at a time; every scenario restores the container.

Usage: python -m scripts.chaos_matrix
"""

from __future__ import annotations

import subprocess
import sys
import time

import httpx

BFF = "http://localhost:8080"
API = "http://api:8000"          # reached via the bff container
PROJECT = "readyjlmirror"


def _docker(*args: str) -> None:
    subprocess.run(["docker", *args], check=True,
                   capture_output=True, text=True)


def _api_ready() -> dict:
    """API readiness as seen through the compose network."""
    r = subprocess.run(
        ["docker", "exec", f"{PROJECT}-bff-1", "python", "-c",
         "import httpx,json; "
         "r=httpx.get('http://api:8000/health/ready',timeout=5); "
         "print(json.dumps({'code':r.status_code,**r.json()}))"],
        capture_output=True, text=True)
    if r.returncode != 0:
        return {"code": 0, "status": "unreachable"}
    import json
    return json.loads(r.stdout.strip())


def _bff_ready() -> dict:
    try:
        r = httpx.get(f"{BFF}/health/ready", timeout=5)
        return {"code": r.status_code, **r.json()}
    except Exception:
        return {"code": 0, "status": "unreachable"}


def _stop(name: str) -> None:
    _docker("stop", f"{PROJECT}-{name}-1")


def _start(name: str) -> None:
    _docker("start", f"{PROJECT}-{name}-1")


def _wait_ready(probe=_bff_ready, status="ready", timeout=90) -> None:
    """After restoring a dependency, wait until the stack reports the
    expected baseline before the next injection — cold postgres
    recovery is not a fixed number of seconds."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if probe().get("status") == status:
            return
        time.sleep(3)


def _scenario(title, kill, expected, restore, settle):
    """Inject -> wait -> assert -> restore -> report."""
    print(f"\n=== {title} ===")
    kill()
    time.sleep(settle)
    got = {}
    try:
        got["api"] = _api_ready()
        got["bff"] = _bff_ready()
        results = {}
        for probe, (exp_code, exp_status) in expected.items():
            actual = got.get(probe, {})
            ok = (actual.get("code") == exp_code
                  and actual.get("status") == exp_status)
            results[probe] = ok
            print(f"  {probe}: {actual.get('status')} "
                  f"({actual.get('code')}) "
                  f"— expected {exp_status}/{exp_code} "
                  f"-> {'PASS' if ok else 'FAIL'}")
        return all(results.values())
    finally:
        restore()


def main() -> int:
    results = {}

    # 1. Database down — fail closed, both surfaces.
    results["db_down"] = _scenario(
        "DATABASE DOWN — authoritative dependency, fail closed",
        kill=lambda: _stop("db"),
        expected={"api": (503, "not_ready"),
                  "bff": (503, "not_ready")},
        restore=lambda: _start("db"),
        settle=8)
    _wait_ready()

    # 2. API down — BFF shell/auth still serve, data degraded.
    results["api_down"] = _scenario(
        "API DOWN — bff degrades, shell+auth still serve",
        kill=lambda: _stop("api"),
        expected={"bff": (200, "degraded")},
        restore=lambda: _start("api"),
        settle=6)
    _wait_ready()

    # 3. Worker down — API stays ready but reports stale workers.
    results["worker_down"] = _scenario(
        "WORKER DOWN — api reports degraded (stale heartbeat)",
        kill=lambda: _stop("worker"),
        expected={"api": (200, "degraded"),
                  "bff": (200, "ready")},
        restore=lambda: _start("worker"),
        settle=25)   # heartbeat threshold: poll*4 = 20s
    _wait_ready()

    # 4. Keycloak down — durable sessions still authorize; only new
    #    logins break. Readiness stays ready (IdP is not a data
    #    dependency for bound sessions).
    results["keycloak_down"] = _scenario(
        "KEYCLOAK DOWN — bound sessions keep working (durable auth)",
        kill=lambda: _stop("keycloak"),
        expected={"bff": (200, "ready")},
        restore=lambda: _start("keycloak"),
        settle=6)
    _wait_ready()

    passed = sum(results.values())
    print(f"\nchaos matrix: {passed}/{len(results)} scenarios PASS")
    for name, ok in results.items():
        print(f"  {name}: {'PASS' if ok else 'FAIL'}")
    return 0 if passed == len(results) else 1


if __name__ == "__main__":
    sys.exit(main())
