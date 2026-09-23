"""Suite isolation — tests run against `tenant:test`, never the
development tenant. Set before any shared.config import so the
settings singleton picks it up (dev-login/JIT provisioning lands
in the test tenant too)."""

import os

os.environ["DEV_TENANT_ID"] = "tenant:test"
# Dev docker database — suite defaults so tests are self-contained.
# DB_USER/DB_PASSWORD intentionally unset: the API app pool uses the
# least-privilege jlmirror_app default, while test-owned connections
# use jlmirror_owner explicitly (RLS bypass for worker-path asserts).
os.environ.setdefault("DB_HOST", "localhost")
os.environ.setdefault("DB_PORT", "5434")
os.environ.setdefault("DB_NAME", "jlmirror")


def pytest_sessionfinish(session, exitstatus):
    """Purge fixture rows leaked into the dev database.

    Tests share the development DB; left behind, `tenant:test`
    sources get scheduled by the worker forever. A failed purge
    must never fail the suite — the DB may simply be absent.
    """
    try:
        from scripts.purge_test_tenant import purge
        counts = purge()
        if counts:
            print(f"\nfixture purge: {sum(counts.values())} rows")
    except Exception as exc:  # noqa: BLE001 — best-effort cleanup
        print(f"\nfixture purge skipped: {exc}")
