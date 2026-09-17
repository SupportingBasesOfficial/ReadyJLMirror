"""Provider adapters — external system boundaries.

Each adapter implements a domain Protocol port. Provider-native
identities and payloads never become platform truth — adapters
translate at this boundary only.
"""

from shared import _path  # noqa: F401 — side effect: adds vendor src to sys.path
