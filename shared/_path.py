"""Path bootstrap — adds the ProjectJLMirror submodule src/ to sys.path.

This ensures the jlmirror_* domain packages are importable without
requiring a separate install step. The submodule's src/ directory
contains pure-Python domain primitives with no external dependencies.
"""

from __future__ import annotations

import sys
from pathlib import Path

_VENDOR_SRC = Path(__file__).resolve().parent.parent / "vendor" / "ProjectJLMirror" / "src"

if str(_VENDOR_SRC) not in sys.path:
    sys.path.insert(0, str(_VENDOR_SRC))
