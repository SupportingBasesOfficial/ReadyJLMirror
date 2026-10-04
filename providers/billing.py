"""G26 Billing Adapter — interface and stub implementation.

The BillingAdapter is the seam between JLMirror usage metering and an
external billing provider (Stripe, Chargebee, etc.). The stub adapter
logs submissions without posting to any external service; it is the
default when BILLING_ADAPTER=stub (the env default).

BILLING_ADAPTER env values:
  stub   — log-only; no external calls (default, safe in all envs)
  (future) stripe, chargebee — real integrations added as needed

Usage: instantiate via billing_adapter() factory.
"""

from __future__ import annotations

import logging
import os
from abc import ABC, abstractmethod
from datetime import datetime, timezone

logger = logging.getLogger("providers.billing")


class BillingError(Exception):
    pass


class BillingAdapter(ABC):
    """Minimal billing surface — usage submission and account status."""

    @abstractmethod
    def submit_usage(
        self,
        *,
        tenant_id: str,
        meter: str,
        quantity: float,
        window_start: datetime,
        window_end: datetime,
        contract_id: str | None = None,
    ) -> dict:
        """Submit a usage record to the billing provider.

        Returns {"submitted": bool, "provider_ref": str | None}.
        Raises BillingError on unrecoverable failure.
        """

    @abstractmethod
    def billing_status(self, *, tenant_id: str) -> dict:
        """Return billing account status for the tenant.

        Returns {"adapter": str, "status": str, "detail": str | None}.
        """


class StubBilling(BillingAdapter):
    """Log-only stub — no external calls. Default for all environments
    unless BILLING_ADAPTER is changed to a real provider."""

    def submit_usage(
        self,
        *,
        tenant_id: str,
        meter: str,
        quantity: float,
        window_start: datetime,
        window_end: datetime,
        contract_id: str | None = None,
    ) -> dict:
        logger.info(
            "billing[stub] tenant=%s meter=%s qty=%s window=%s/%s contract=%s",
            tenant_id, meter, quantity,
            window_start.isoformat() if window_start else "?",
            window_end.isoformat() if window_end else "?",
            contract_id,
        )
        return {"submitted": True, "provider_ref": None}

    def billing_status(self, *, tenant_id: str) -> dict:
        return {
            "adapter": "stub",
            "status": "active",
            "detail": "Stub adapter — no real billing integration configured.",
        }


def billing_adapter() -> BillingAdapter:
    """Factory — returns adapter for the configured BILLING_ADAPTER env."""
    adapter_name = os.environ.get("BILLING_ADAPTER", "stub").lower().strip()
    if adapter_name == "stub":
        return StubBilling()
    raise BillingError(
        f"Unknown BILLING_ADAPTER '{adapter_name}'. "
        "Supported values: stub"
    )
