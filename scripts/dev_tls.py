"""Generate a self-signed TLS certificate for local development.

Writes secrets/tls/{cert.pem,key.pem} — gitignored, mounted at
/run/secrets in compose. The BFF picks them up automatically when
SECRETS_DIR/tls/cert.pem exists (or via TLS_CERT_FILE/TLS_KEY_FILE).

Usage: python -m scripts.dev_tls
"""

from __future__ import annotations

import datetime
import ipaddress
import os
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID

OUT = Path(os.environ.get("SECRETS_DIR", "secrets")) / "tls"


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "JLMirror Dev"),
    ])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name).issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(minutes=5))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.DNSName("*.localhost"),
                x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                x509.IPAddress(ipaddress.IPv6Address("::1")),
            ]),
            critical=False,
        )
        .add_extension(
            x509.BasicConstraints(ca=False, path_length=None),
            critical=True,
        )
        .sign(key, hashes.SHA256())
    )

    (OUT / "key.pem").write_bytes(
        key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        )
    )
    (OUT / "cert.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (OUT / "key.pem").chmod(0o600)
    print(f"dev TLS written to {OUT}/ (cert.pem, key.pem)")
    print("BFF will serve https://localhost:8443 when TLS_CERT_FILE/"
          "TLS_KEY_FILE are set or the files exist under SECRETS_DIR/tls")


if __name__ == "__main__":
    main()
