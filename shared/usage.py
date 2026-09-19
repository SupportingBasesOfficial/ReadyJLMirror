"""Usage metering — commercial attribution (contract §12).

Every billable record is traceable to: consuming tenant,
beneficiary organization, covering contract/entitlement, and
billing-responsible account. Records insert in the SAME
transaction as the work they meter — atomic, auditable.

Attribution resolution (§10): beneficiary = tenant's organization;
covering contract = active contract on an account owned by that
organization OR holding an active entitlement assigned to it;
billing account = the contract's account (the payer — which may
differ from the beneficiary, e.g. MSP Alpha pays for Customer A).
"""

from __future__ import annotations

import secrets


def record_sync_usage(conn, *, tenant_id: str,
                      sync_operation_id: str,
                      operation_kind: str) -> str | None:
    """Meter one completed sync operation. Returns usage_id."""
    cur = conn.execute(
        """
        SELECT t.organization_id, o.created_at
          FROM g1.tenants t
          JOIN monitoring.monitoring_sync_operation o
            ON o.tenant_id = t.tenant_id
           AND o.monitoring_sync_operation_id = %s
         WHERE t.tenant_id = %s
        """, (sync_operation_id, tenant_id))
    row = cur.fetchone()
    if row is None:
        return None
    beneficiary, window_start = row

    contract_id = account_id = None
    if beneficiary:
        cur = conn.execute(
            """
            SELECT c.contract_id, c.account_id
              FROM g1.contracts c
              JOIN g1.commercial_accounts a
                ON a.account_id = c.account_id
             WHERE c.state = 'active'
               AND (a.organization_id = %s
                    OR EXISTS (
                        SELECT 1 FROM g1.entitlements e
                         WHERE e.contract_id = c.contract_id
                           AND e.assigned_organization_id = %s
                           AND e.state = 'active'))
             ORDER BY c.effective_from DESC
             LIMIT 1
            """, (beneficiary, beneficiary))
        cov = cur.fetchone()
        if cov:
            contract_id, account_id = cov

    usage_id = f"usage_{secrets.token_urlsafe(12)}"
    conn.execute(
        """
        INSERT INTO g1.usage_meters
            (usage_id, tenant_id, beneficiary_organization_id,
             contract_id, billing_account_id, meter, quantity,
             window_start, window_end)
        VALUES (%s, %s, %s, %s, %s, %s, 1, %s,
                transaction_timestamp())
        """,
        (usage_id, tenant_id, beneficiary, contract_id,
         account_id, f"sync.operation.{operation_kind}",
         window_start))
    return usage_id
