"""Pytest configuration — ensures vendor src is on the path."""

import sys
from pathlib import Path

_VENDOR_SRC = Path(__file__).resolve().parent / "vendor" / "ProjectJLMirror" / "src"
if str(_VENDOR_SRC) not in sys.path:
    sys.path.insert(0, str(_VENDOR_SRC))
