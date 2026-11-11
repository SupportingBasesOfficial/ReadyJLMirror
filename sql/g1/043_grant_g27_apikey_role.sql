-- G27 API Key invoker role was missing GRANT USAGE ON SCHEMA g1 from 013_g27_api_keys.sql.
-- After SET LOCAL ROLE jlmirror_g27_apikey_app_invoker, calling g1.g27_create_api_key
-- fails with InsufficientPrivilege. This migration adds the missing grant.
GRANT USAGE ON SCHEMA g1 TO jlmirror_g27_apikey_app_invoker;
