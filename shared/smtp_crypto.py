"""Application-layer encryption for SMTP passwords stored in DB.

Uses Fernet (AES-128-CBC + HMAC-SHA256) from the cryptography package.
Key is a URL-safe base64-encoded 32-byte value in SMTP_PASSWORD_ENC_KEY.

When no key is configured (dev default), encrypt() is a no-op and
decrypt() returns the stored value unchanged.
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
    key = getattr(settings, "smtp_password_enc_key", "")
    if not key:
        _fernet = None
        return None
    try:
        from cryptography.fernet import Fernet  # noqa: PLC0415
        _fernet = Fernet(key.encode())
        return _fernet
    except Exception as exc:
        logger.error(
            "smtp_crypto: failed to initialise Fernet — SMTP password encryption disabled: %s",
            exc,
        )
        _fernet = None
        return None


def encrypt_password(plaintext: str) -> tuple[str, bool]:
    """Encrypt an SMTP password if encryption is enabled.

    Returns (stored_value, was_encrypted).
    If encryption is disabled, returns the original string unchanged with False.
    """
    f = _get_fernet()
    if f is None:
        return plaintext, False
    encrypted = f.encrypt(plaintext.encode())
    return base64.urlsafe_b64encode(encrypted).decode(), True


def decrypt_password(stored_value: str, encrypted: bool) -> str:
    """Return the plaintext SMTP password.

    If encrypted=False, returns stored_value unchanged.
    Raises ValueError if decryption fails (bad key or corrupted data).
    """
    if not encrypted:
        return stored_value
    f = _get_fernet()
    if f is None:
        raise ValueError(
            "SMTP password is marked as encrypted but SMTP_PASSWORD_ENC_KEY "
            "is not configured — cannot decrypt"
        )
    try:
        raw = base64.urlsafe_b64decode(stored_value.encode())
        return f.decrypt(raw).decode()
    except Exception as exc:
        raise ValueError(f"SMTP password decryption failed: {exc}") from exc
