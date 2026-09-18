"""Generate a dev CA and TLS certificates for local development.

Layout written under SECRETS_DIR/tls (default secrets/tls),
gitignored, mounted at /run/secrets in compose:

    ca.pem                     dev root CA (trust anchor)
    cert.pem, key.pem          generic localhost server cert (BFF HTTPS)
    api-cert.pem, api-key.pem  API server cert  (CN=api)
    bff-cert.pem, bff-key.pem  BFF client cert  (CN=bff) — mTLS identity

The API requires a client certificate when API_MTLS=1; the BFF
presents bff-*.pem. Production: the same trust model comes from
SPIRE/SPIFFE or the platform CA — only issuance differs.

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
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

OUT = Path(os.environ.get("SECRETS_DIR", "secrets")) / "tls"

_NOW = datetime.datetime.now(datetime.timezone.utc)
_VALID = (lambda t: (_NOW - datetime.timedelta(minutes=5),
                     _NOW + datetime.timedelta(days=825)))


def _key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)


def _write_key(path: Path, key) -> None:
    path.write_bytes(key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.TraditionalOpenSSL,
        serialization.NoEncryption()))
    path.chmod(0o600)


def _write_cert(path: Path, cert: x509.Certificate) -> None:
    path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _name(cn: str, org: str = "JLMirror Dev") -> x509.Name:
    return x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, cn),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, org),
    ])


def _issue(*, subject_cn: str, san_names, san_ips, issuer_name,
           issuer_key, pub_key, is_ca: bool, eku) -> x509.Certificate:
    nvb, nva = _VALID(0)
    b = (
        x509.CertificateBuilder()
        .subject_name(_name(subject_cn)).issuer_name(issuer_name)
        .public_key(pub_key)
        .serial_number(x509.random_serial_number())
        .not_valid_before(nvb).not_valid_after(nva)
        .add_extension(
            x509.BasicConstraints(ca=is_ca, path_length=0 if is_ca else None),
            critical=True)
        .add_extension(
            x509.KeyUsage(
                digital_signature=True, key_encipherment=True,
                key_cert_sign=is_ca, crl_sign=is_ca,
                content_commitment=False, data_encipherment=False,
                key_agreement=False, encipher_only=False,
                decipher_only=False),
            critical=True)
    )
    sans = [x509.DNSName(n) for n in san_names] + \
        [x509.IPAddress(i) for i in san_ips]
    if sans:
        b = b.add_extension(
            x509.SubjectAlternativeName(sans), critical=False)
    if eku:
        b = b.add_extension(
            x509.ExtendedKeyUsage(eku), critical=False)
    return b.sign(issuer_key, hashes.SHA256())


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    server_eku = [ExtendedKeyUsageOID.SERVER_AUTH]
    client_eku = [ExtendedKeyUsageOID.CLIENT_AUTH]

    ca_key = _key()
    ca_cert = _issue(
        subject_cn="JLMirror Dev CA", san_names=[], san_ips=[],
        issuer_name=_name("JLMirror Dev CA"), issuer_key=ca_key,
        pub_key=ca_key.public_key(), is_ca=True, eku=None)
    _write_key(OUT / "ca-key.pem", ca_key)
    _write_cert(OUT / "ca.pem", ca_cert)

    # Generic localhost server cert (BFF https)
    srv_key = _key()
    _write_key(OUT / "key.pem", srv_key)
    _write_cert(OUT / "cert.pem", _issue(
        subject_cn="localhost", issuer_name=ca_cert.subject,
        issuer_key=ca_key, pub_key=srv_key.public_key(), is_ca=False,
        eku=server_eku,
        san_names=["localhost", "*.localhost"],
        san_ips=[ipaddress.IPv4Address("127.0.0.1"),
                 ipaddress.IPv6Address("::1")]))

    # API server cert (CN=api — inside the compose network)
    api_key = _key()
    _write_key(OUT / "api-key.pem", api_key)
    _write_cert(OUT / "api-cert.pem", _issue(
        subject_cn="api", issuer_name=ca_cert.subject,
        issuer_key=ca_key, pub_key=api_key.public_key(), is_ca=False,
        eku=server_eku,
        san_names=["api", "localhost"],
        san_ips=[ipaddress.IPv4Address("127.0.0.1")]))

    # BFF client cert (mTLS identity toward the API)
    bff_key = _key()
    _write_key(OUT / "bff-key.pem", bff_key)
    _write_cert(OUT / "bff-cert.pem", _issue(
        subject_cn="bff", issuer_name=ca_cert.subject,
        issuer_key=ca_key, pub_key=bff_key.public_key(), is_ca=False,
        eku=client_eku, san_names=["bff"], san_ips=[]))

    print(f"dev CA + certs written to {OUT}/")
    print("  BFF https : TLS_CERT_FILE/TLS_KEY_FILE -> cert.pem,key.pem")
    print("  API mTLS  : API_MTLS=1 + API_TLS_* -> api-*, ca.pem")
    print("  BFF client: BFF_CLIENT_CERT/BFF_CLIENT_KEY -> bff-*, "
          "API_CA_FILE -> ca.pem")


if __name__ == "__main__":
    main()
