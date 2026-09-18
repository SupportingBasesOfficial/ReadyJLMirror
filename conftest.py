"""Pytest configuration — ensures vendor src is on the path."""

import os
import sys
from pathlib import Path

# Test environment defaults must precede any shared.config import — the
# settings singleton reads env once at first import.
os.environ.setdefault("APP_ENVIRONMENT", "development")
os.environ.setdefault("DEV_AUTH_BYPASS", "true")
# Fake provider hosts are unresolvable/offline — skip the DNS screen in
# unit tests (the screen itself is covered by dedicated tests).
os.environ.setdefault("EGRESS_ALLOW_PRIVATE_IPS", "true")
os.environ.setdefault(
    "EGRESS_ALLOW_HOSTS", "zabbix.example.com,example.com,localhost")

_VENDOR_SRC = Path(__file__).resolve().parent / "vendor" / "ProjectJLMirror" / "src"
if str(_VENDOR_SRC) not in sys.path:
    sys.path.insert(0, str(_VENDOR_SRC))
