-- G13 FinOps — dev commercial seed.
-- Creates a dev commercial account, contract, and entitlements for the
-- platform org so that the FinOps API has data to read on first boot.

BEGIN;

INSERT INTO g1.commercial_accounts (account_id, organization_id, state)
VALUES ('acct:platform-dev', 'org:platform', 'active')
ON CONFLICT DO NOTHING;

INSERT INTO g1.contracts
    (contract_id, account_id, plan_ref, state, effective_from)
VALUES ('contract:platform-dev', 'acct:platform-dev',
        'enterprise-dev', 'active', now())
ON CONFLICT DO NOTHING;

INSERT INTO g1.entitlements
    (entitlement_id, contract_id, capability, assigned_organization_id, state)
VALUES
    ('ent:monitoring-dev', 'contract:platform-dev',
     'monitoring', 'org:platform', 'active'),
    ('ent:alerting-dev', 'contract:platform-dev',
     'alerting', 'org:platform', 'active'),
    ('ent:itsm-dev', 'contract:platform-dev',
     'itsm', 'org:platform', 'active'),
    ('ent:aiops-dev', 'contract:platform-dev',
     'aiops', 'org:platform', 'active')
ON CONFLICT DO NOTHING;

COMMIT;
