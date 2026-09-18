"""Application configuration loaded from environment variables.

All values have safe development defaults so the application can start
without a populated .env file. Production deployments must override
the secrets and connection strings explicitly.

Secrets (db_password, bff_internal_secret, keycloak_client_secret)
resolve through `_secret`: mounted file > env var > dev default.
`SECRETS_DIR` (default /run/secrets) follows the docker-secrets
pattern — injectable by Vault/OpenBao agents without code changes.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal


def _env(key: str, default: str) -> str:
    return os.environ.get(key, default)


def _secret(*file_names: str, env_name: str, default: str) -> str:
    """Resolve a secret: mounted file > env var > dev default.

    Multiple file names are tried in order (e.g. a per-role
    `db_password_jlmirror_app` before a generic `db_password`).
    """
    secrets_dir = os.environ.get("SECRETS_DIR", "/run/secrets")
    for file_name in file_names:
        try:
            value = (Path(secrets_dir) / file_name).read_text(
                encoding="utf-8").strip()
            if value:
                return value
        except (OSError, ValueError):
            pass
    return _env(env_name, default)


@dataclass(frozen=True)
class Settings:
    """Runtime configuration for the ReadyJLMirror application."""

    environment: str = field(default_factory=lambda: _env("APP_ENVIRONMENT", "development"))
    log_level: str = field(default_factory=lambda: _env("LOG_LEVEL", "INFO"))

    # Database
    db_host: str = field(default_factory=lambda: _env("DB_HOST", "localhost"))
    db_port: int = field(default_factory=lambda: int(_env("DB_PORT", "5432")))
    db_name: str = field(default_factory=lambda: _env("DB_NAME", "jlmirror"))
    db_user: str = field(default_factory=lambda: _env("DB_USER", "jlmirror_app"))
    db_password: str = field(
        default_factory=lambda: _secret(
            f"db_password_{_env('DB_USER', 'jlmirror_app')}", "db_password",
            env_name="DB_PASSWORD", default="jlmirror_dev")
    )
    db_schema: str = field(default_factory=lambda: _env("DB_SCHEMA", "public"))
    db_pool_min: int = field(default_factory=lambda: int(_env("DB_POOL_MIN", "2")))
    db_pool_max: int = field(default_factory=lambda: int(_env("DB_POOL_MAX", "10")))

    # API
    api_host: str = field(default_factory=lambda: _env("API_HOST", "0.0.0.0"))
    api_port: int = field(default_factory=lambda: int(_env("API_PORT", "8000")))
    api_version: str = field(default_factory=lambda: _env("API_VERSION", "v1"))

    # BFF (G1 identity + tenant + protected shell)
    bff_host: str = field(default_factory=lambda: _env("BFF_HOST", "0.0.0.0"))
    bff_port: int = field(default_factory=lambda: _env("BFF_PORT", "8080"))
    bff_public_url: str = field(default_factory=lambda: _env("BFF_PUBLIC_URL", "http://localhost:8080"))
    api_internal_url: str = field(default_factory=lambda: _env("API_INTERNAL_URL", "http://localhost:8000"))

    # Internal trust: BFF -> API signed context (dev HMAC; production = SPIRE/mTLS)
    bff_internal_secret: str = field(
        default_factory=lambda: _secret(
            "bff_internal_secret",
            env_name="BFF_INTERNAL_SECRET",
            default="dev-internal-secret-change-me")
    )

    # Keycloak / OIDC (IR-D-001 candidate: Keycloak 26.7.x)
    keycloak_internal_url: str = field(
        default_factory=lambda: _env("KEYCLOAK_INTERNAL_URL", "http://localhost:8180")
    )
    keycloak_public_url: str = field(
        default_factory=lambda: _env("KEYCLOAK_PUBLIC_URL", "http://localhost:8180")
    )
    keycloak_realm: str = field(default_factory=lambda: _env("KEYCLOAK_REALM", "jlmirror"))
    keycloak_client_id: str = field(default_factory=lambda: _env("KEYCLOAK_CLIENT_ID", "jlmirror-bff"))
    keycloak_client_secret: str = field(
        default_factory=lambda: _secret(
            "keycloak_client_secret",
            env_name="KEYCLOAK_CLIENT_SECRET",
            default="dev-bff-secret-change-me")
    )

    # Session policy
    session_lifetime_hours: int = field(
        default_factory=lambda: int(_env("SESSION_LIFETIME_HOURS", "8"))
    )
    cookie_secure: bool = field(
        default_factory=lambda: _env("COOKIE_SECURE", "false").lower() == "true"
    )

    # Dev-only auth bypass: simulates the OIDC callback without Keycloak.
    # MUST be false in production. Only honored when environment=development.
    dev_auth_bypass: bool = field(
        default_factory=lambda: _env("DEV_AUTH_BYPASS", "false").lower() == "true"
    )

    # Authority (development adapter)
    dev_principal_id: str = field(default_factory=lambda: _env("DEV_PRINCIPAL_ID", "dev-local-user"))
    dev_tenant_id: str = field(default_factory=lambda: _env("DEV_TENANT_ID", "tenant:dev"))
    dev_credential_generation: str = field(
        default_factory=lambda: _env("DEV_CREDENTIAL_GENERATION", "credential-gen-dev-1")
    )

    # Worker
    worker_poll_interval_seconds: int = field(
        default_factory=lambda: int(_env("WORKER_POLL_INTERVAL_SECONDS", "5"))
    )
    worker_outbox_batch_size: int = field(
        default_factory=lambda: int(_env("WORKER_OUTBOX_BATCH_SIZE", "10"))
    )

    @property
    def db_dsn(self) -> str:
        return (
            f"postgresql://{self.db_user}:{self.db_password}"
            f"@{self.db_host}:{self.db_port}/{self.db_name}"
        )

    @property
    def is_development(self) -> bool:
        return self.environment == "development"

    @property
    def is_production(self) -> bool:
        return self.environment == "production"


settings = Settings()


def get_settings() -> Settings:
    """Return the current settings instance (for FastAPI dependency injection)."""
    return settings


EnvironmentClass = Literal["development", "staging", "production"]
