-- Dev seed for the organization/access layer — makes the delegated
-- MSP scenario usable out of the box:
--
--   org:platform   -> us (JLMirror operator)
--   org:msp-alpha  -> a company managing customers
--   org:customer-a -> one of MSP Alpha's customers (owns tenant:a)
--
--   dev-platform-admin (kind=platform_admin_principal) — global view.
--   dev-msp-admin (human) — membership only in the MSP home tenant,
--   plus a delegated grant over tenant:a (customer A's tenant).
--
-- The delegation is explicit: MSP admin can operate tenant:a but has
-- NO authority over tenant:dev or any other tenant.

BEGIN;

INSERT INTO g1.organizations (organization_id, display_name)
VALUES ('org:platform', 'JLMirror Platform Operator'),
       ('org:msp-alpha', 'MSP Alpha (dev)'),
       ('org:customer-a', 'Customer A (dev)')
ON CONFLICT DO NOTHING;

UPDATE g1.tenants SET organization_id = 'org:platform'
 WHERE tenant_id = 'tenant:dev' AND organization_id IS NULL;

INSERT INTO g1.tenants
    (tenant_id, display_name, state, isolation_class, cell_id,
     organization_id)
VALUES ('tenant:msp-alpha', 'MSP Alpha Home (dev)', 'active',
        'pooled', 'cell:dev-1', 'org:msp-alpha'),
       ('tenant:a', 'Customer A (dev)', 'active',
        'pooled', 'cell:dev-1', 'org:customer-a')
ON CONFLICT DO NOTHING;

INSERT INTO g1.organization_relationships
    (relationship_id, family, source_organization_id,
     target_organization_id)
VALUES
    ('rel:msp-provides-a', 'provides_monitoring_service_for',
     'org:msp-alpha', 'org:customer-a'),
    ('rel:msp-delegated-a', 'delegated_administration_for',
     'org:msp-alpha', 'org:customer-a')
ON CONFLICT DO NOTHING;

-- Platform admin (global, privileged) — dev-login subject:
-- 'platform-admin'
INSERT INTO g1.principals
    (principal_id, kind, credential_generation, idp_subject_ref,
     idp_issuer)
VALUES ('dev-platform-admin', 'platform_admin_principal',
        'credential-gen-platform-1', 'platform-admin',
        'dev-issuer:development')
ON CONFLICT DO NOTHING;

-- MSP admin (ordinary human principal) — dev-login subject:
-- 'msp-admin'. Membership ONLY in the MSP home tenant.
INSERT INTO g1.principals
    (principal_id, kind, credential_generation, idp_subject_ref,
     idp_issuer)
VALUES ('dev-msp-admin', 'human_browser_session',
        'credential-gen-msp-1', 'msp-admin',
        'dev-issuer:development')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships
    (membership_id, tenant_id, principal_id, role)
VALUES ('mem-msp-admin-home', 'tenant:msp-alpha', 'dev-msp-admin',
        'operator')
ON CONFLICT DO NOTHING;

-- The delegated grant: MSP admin can operate Customer A's tenant —
-- the "ramification" created under the MSP relationship.
INSERT INTO g1.delegated_grants
    (grant_id, source_organization_id, target_tenant_id,
     principal_id, permissions, granted_by)
VALUES ('grant-msp-admin-a', 'org:msp-alpha', 'tenant:a',
        'dev-msp-admin',
        ARRAY['tenant:read', 'monitoring:read', 'monitoring:operate',
              'alerting:read', 'observability:read'],
        'dev-seed')
ON CONFLICT DO NOTHING;

COMMIT;
