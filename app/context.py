"""Tenant context middleware and dependency injection.

The tenant context is derived from trusted headers (set by the BFF or
control plane in production). In development mode, a default tenant is
used. The tenant ID is never accepted from arbitrary request body fields
for protected operations.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated

from fastapi import Header, HTTPException, status

from app.config import settings


@dataclass(frozen=True)
class TenantContext:
    """The resolved tenant context for the current request."""

    tenant_id: str
    principal_id: str
    credential_generation: str
    runtime_binding: str = "runtime.api@1"


def get_tenant_context(
    x_tenant_id: Annotated[str | None, Header()] = None,
    x_principal_id: Annotated[str | None, Header()] = None,
    x_credential_generation: Annotated[str | None, Header()] = None,
) -> TenantContext:
    """Resolve the tenant context from trusted headers.

    In development mode, defaults are used when headers are absent.
    In production, all headers are required.
    """
    if settings.is_production:
        if not x_tenant_id or not x_principal_id or not x_credential_generation:
            raise HTTPException(
                status_code=status.HTTP_401_UNAUTHORIZED,
                detail="Tenant context headers are required in production",
            )
        return TenantContext(
            tenant_id=x_tenant_id,
            principal_id=x_principal_id,
            credential_generation=x_credential_generation,
        )

    return TenantContext(
        tenant_id=x_tenant_id or settings.dev_tenant_id,
        principal_id=x_principal_id or settings.dev_principal_id,
        credential_generation=x_credential_generation or settings.dev_credential_generation,
    )


TenantDep = Annotated[TenantContext, "depends on get_tenant_context"]
