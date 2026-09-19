-- Worker grants for usage metering: the worker resolves commercial
-- attribution (contracts/accounts/entitlements) and inserts meter
-- rows inside the operation-completion transaction.

BEGIN;

GRANT SELECT ON g1.contracts TO jlmirror_worker;
GRANT SELECT ON g1.commercial_accounts TO jlmirror_worker;
GRANT SELECT ON g1.entitlements TO jlmirror_worker;
GRANT SELECT, INSERT ON g1.usage_meters TO jlmirror_worker;
GRANT SELECT, INSERT ON g1.display_tokens TO jlmirror_worker;

COMMIT;
