"""Suite isolation — tests run against `tenant:test`, never the
development tenant. Set before any shared.config import so the
settings singleton picks it up (dev-login/JIT provisioning lands
in the test tenant too)."""

import os

os.environ["DEV_TENANT_ID"] = "tenant:test"
