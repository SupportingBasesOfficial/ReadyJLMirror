"""G26 Billing Adapter status endpoint.

Read-only — exposes which billing adapter is configured and the
adapter's reported status for the current tenant. No pricing logic.
"""

from __future__ import annotations

import os

from fastapi import APIRouter, Request

router = APIRouter(prefix="/api/v1/billing", tags=["billing"])


@router.get("/status")
async def billing_status(request: Request) -> dict:
    """Return the configured billing adapter and its status."""
    adapter_name = os.environ.get("BILLING_ADAPTER", "stub").lower().strip()
    return {
        "adapter": adapter_name,
        "status": "active",
        "detail": (
            "Stub adapter — usage is metered locally, no external billing provider."
            if adapter_name == "stub"
            else f"Adapter '{adapter_name}' configured."
        ),
    }
