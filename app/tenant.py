"""Development tenant context helpers.

Builds a valid TenantContext for development mode without requiring
the full control-plane admission chain (placement authority, principal
authority, etc.). Production deployments must replace this with the
real `construct_tenant_context` flow from `jlmirror_authority`.
"""

from __future__ import annotations

from datetime import datetime, timezone

from jlmirror_authority.model import (
    EnvironmentClass,
    Principal,
    PrincipalKind,
    TenantContext,
)

from app.auth import fence_store


def make_dev_tenant_context(
    tenant_id: str,
    principal_id: str,
    credential_generation: str,
) -> TenantContext:
    """Build a development TenantContext with safe defaults.

    The fence scope is bootstrapped on first use for the tenant.
    """
    fence_scope_id = f"fence:{tenant_id}"
    if fence_store.current(fence_scope_id) is None:
        fence_store.bootstrap(fence_scope_id, "gen-dev-1")
    current_fence = fence_store.current(fence_scope_id)
    assert current_fence is not None

    return TenantContext(
        tenant_id=tenant_id,
        principal_id=principal_id,
        principal_kind=PrincipalKind.HUMAN_BROWSER_SESSION,
        principal_credential_generation=credential_generation,
        cell_id="cell:dev-1",
        placement_version="placement:dev-1",
        runtime_generation="runtime-gen-dev-1",
        runtime_profile_id="runtime.api@1",
        runtime_isolation_class="isolation.pooled@1",
        configuration_generation="config-gen-dev-1",
        workload_credential_generation="workload-cred-dev-1",
        network_policy_generation="net-policy-dev-1",
        environment_class=EnvironmentClass.DEVELOPMENT,
        isolation_class="pooled",
        fence_scope_id=fence_scope_id,
        fence_epoch=current_fence.current_fence_epoch,
        constructed_at=datetime.now(timezone.utc),
    )
