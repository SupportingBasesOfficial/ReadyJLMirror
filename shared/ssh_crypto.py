"""Application-layer encryption for SSH private keys stored in DB.

Uses Fernet (AES-128-CBC + HMAC-SHA256) from the cryptography package.
Key is a URL-safe base64-encoded 32-byte value in AUTOMATION_CRED_ENC_KEY.

When no key is configured (dev default), encrypt() is a no-op and
is_encrypted() always returns False.
"""

from __future__ import annotations

import base64
import logging

from shared.config import settings

logger = logging.getLogger(__name__)

_fernet = None
_fernet_loaded = False


def _get_fernet():
    global _fernet, _fernet_loaded
    if _fernet_loaded:
        return _fernet
    _fernet_loaded = True
    key = getattr(settings, "automation_cred_enc_key", "")
    if not key:
        _fernet = None
        return None
    try:
        from cryptography.fernet import Fernet  # noqa: PLC0415
        _fernet = Fernet(key.encode())
        return _fernet
    except Exception as exc:
        logger.error("ssh_crypto: failed to initialise Fernet — SSH key encryption disabled: %s", exc)
        _fernet = None
        return None


def encryption_enabled() -> bool:
    """Return True if AUTOMATION_CRED_ENC_KEY is configured and valid."""
    return _get_fernet() is not None


def encrypt_key(plaintext_pem: str) -> tuple[str, bool]:
    """Encrypt a PEM private key if encryption is enabled.

    Returns (stored_value, was_encrypted).
    If encryption is disabled, returns the original string unchanged with False.
    """
    f = _get_fernet()
    if f is None:
        return plaintext_pem, False
    encrypted = f.encrypt(plaintext_pem.encode())
    return base64.urlsafe_b64encode(encrypted).decode(), True


def decrypt_key(stored_value: str, encrypted: bool) -> str:
    """Return the plaintext PEM key.

    If encrypted=False, returns stored_value unchanged.
    Raises ValueError if decryption fails (bad key or corrupted data).
    """
    if not encrypted:
        return stored_value
    f = _get_fernet()
    if f is None:
        raise ValueError(
            "SSH credential is marked as encrypted but AUTOMATION_CRED_ENC_KEY "
            "is not configured — cannot decrypt"
        )
    try:
        raw = base64.urlsafe_b64decode(stored_value.encode())
        return f.decrypt(raw).decode()
    except Exception as exc:
        raise ValueError(f"SSH key decryption failed: {exc}") from exc
