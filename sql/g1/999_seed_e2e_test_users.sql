-- E2E test users — one per role/access scenario.
-- All use idp_issuer = 'dev-issuer:development'.
-- Login via:  GET /auth/dev-login?subject=<subject>
--
-- SCENARIO MAP:
--
--  Subject              Display Name          Tenant(s)          Role
--  -------------------  --------------------  -----------------  -------------------------
--  platform-admin       Platform Admin        ALL tenants        platform (global)
--  msp-admin            MSP Alpha Admin       msp-alpha + (a)    admin + delegated grant→a
--  msp-operator         MSP Operator          msp-alpha + (a)    operator + delegated grant→a
--  dev-admin            Dev Admin             tenant:dev         admin
--  dev-operator         Dev Operator          tenant:dev         operator
--  dev-viewer           Dev Viewer            tenant:dev         viewer
--  dev-auditor          Dev Auditor           tenant:dev         auditor
--  client-admin         Client A Admin        tenant:a           admin
--  client-viewer        Client A Viewer       tenant:a           viewer
--  multi-tenant         Multi-Tenant User     dev(operator)+a(viewer)  tests workspace switching

BEGIN;

-- ─── Fix existing principals: add display_name + email ──────────────────────

UPDATE g1.principals
SET    display_name = 'Platform Admin',
       email        = 'platform-admin@jlmirror.test'
WHERE  principal_id = 'dev-platform-admin';

UPDATE g1.principals
SET    display_name = 'MSP Alpha Admin',
       email        = 'msp-admin@msp-alpha.test'
WHERE  principal_id = 'dev-msp-admin';

-- Upgrade msp-admin membership to admin (was changed to custom:noc-reader in testing)
UPDATE g1.tenant_memberships
SET    role = 'admin'
WHERE  principal_id = 'dev-msp-admin'
  AND  tenant_id    = 'tenant:msp-alpha';

-- Reactivate org relationship so MSP overview can find it
UPDATE g1.organization_relationships
SET    state = 'active'
WHERE  relationship_id = 'rel:msp-provides-a';

-- Create fresh active delegated grant for msp-admin (old ones are revoked)
INSERT INTO g1.delegated_grants
    (grant_id, source_organization_id, target_tenant_id,
     principal_id, permissions, state, granted_by)
VALUES
    ('grant-msp-admin-a-v2', 'org:msp-alpha', 'tenant:a', 'dev-msp-admin',
     ARRAY['tenant:read','monitoring:read','monitoring:operate',
           'alerting:read','alerting:operate','observability:read'],
     'active', 'seed-e2e')
ON CONFLICT DO NOTHING;

-- ─── 1. dev-admin — Tenant Admin for tenant:dev ─────────────────────────────

INSERT INTO g1.principals
    (principal_id, kind, credential_generation,
     idp_subject_ref, idp_issuer, display_name, email)
VALUES
    ('principal.e2e-dev-admin', 'human_browser_session',
     'cred-gen-e2e-dev-admin',
     'dev-admin', 'dev-issuer:development',
     'Dev Admin', 'dev-admin@tenant-dev.test')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-dev-admin', 'tenant:dev', 'principal.e2e-dev-admin', 'admin')
ON CONFLICT DO NOTHING;

-- ─── 2. dev-operator — Operator for tenant:dev ──────────────────────────────

INSERT INTO g1.principals
    (principal_id, kind, credential_generation,
     idp_subject_ref, idp_issuer, display_name, email)
VALUES
    ('principal.e2e-dev-operator', 'human_browser_session',
     'cred-gen-e2e-dev-operator',
     'dev-operator', 'dev-issuer:development',
     'Dev Operator', 'dev-operator@tenant-dev.test')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-dev-operator', 'tenant:dev', 'principal.e2e-dev-operator', 'operator')
ON CONFLICT DO NOTHING;

-- ─── 3. dev-viewer — Viewer for tenant:dev ──────────────────────────────────

INSERT INTO g1.principals
    (principal_id, kind, credential_generation,
     idp_subject_ref, idp_issuer, display_name, email)
VALUES
    ('principal.e2e-dev-viewer', 'human_browser_session',
     'cred-gen-e2e-dev-viewer',
     'dev-viewer', 'dev-issuer:development',
     'Dev Viewer', 'dev-viewer@tenant-dev.test')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-dev-viewer', 'tenant:dev', 'principal.e2e-dev-viewer', 'viewer')
ON CONFLICT DO NOTHING;

-- ─── 4. dev-auditor — Auditor for tenant:dev ────────────────────────────────

INSERT INTO g1.principals
    (principal_id, kind, credential_generation,
     idp_subject_ref, idp_issuer, display_name, email)
VALUES
    ('principal.e2e-dev-auditor', 'human_browser_session',
     'cred-gen-e2e-dev-auditor',
     'dev-auditor', 'dev-issuer:development',
     'Dev Auditor', 'dev-auditor@tenant-dev.test')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-dev-auditor', 'tenant:dev', 'principal.e2e-dev-auditor', 'auditor')
ON CONFLICT DO NOTHING;

-- ─── 5. msp-operator — Operator in msp-alpha + delegated grant to tenant:a ──

INSERT INTO g1.principals
    (principal_id, kind, credential_generation,
     idp_subject_ref, idp_issuer, display_name, email)
VALUES
    ('principal.e2e-msp-operator', 'human_browser_session',
     'cred-gen-e2e-msp-operator',
     'msp-operator', 'dev-issuer:development',
     'MSP Operator', 'msp-operator@msp-alpha.test')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-msp-operator-home', 'tenant:msp-alpha', 'principal.e2e-msp-operator', 'operator')
ON CONFLICT DO NOTHING;

INSERT INTO g1.delegated_grants
    (grant_id, source_organization_id, target_tenant_id,
     principal_id, permissions, state, granted_by)
VALUES
    ('grant-e2e-msp-operator-a', 'org:msp-alpha', 'tenant:a', 'principal.e2e-msp-operator',
     ARRAY['tenant:read','monitoring:read','monitoring:operate',
           'alerting:read','alerting:operate','observability:read'],
     'active', 'seed-e2e')
ON CONFLICT DO NOTHING;

-- ─── 6. client-admin — Admin in tenant:a (the MSP client) ───────────────────

INSERT INTO g1.principals
    (principal_id, kind, credential_generation,
     idp_subject_ref, idp_issuer, display_name, email)
VALUES
    ('principal.e2e-client-admin', 'human_browser_session',
     'cred-gen-e2e-client-admin',
     'client-admin', 'dev-issuer:development',
     'Client A Admin', 'admin@customer-a.test')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-client-admin-a', 'tenant:a', 'principal.e2e-client-admin', 'admin')
ON CONFLICT DO NOTHING;

-- ─── 7. client-viewer — Viewer in tenant:a ──────────────────────────────────

INSERT INTO g1.principals
    (principal_id, kind, credential_generation,
     idp_subject_ref, idp_issuer, display_name, email)
VALUES
    ('principal.e2e-client-viewer', 'human_browser_session',
     'cred-gen-e2e-client-viewer',
     'client-viewer', 'dev-issuer:development',
     'Client A Viewer', 'viewer@customer-a.test')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-client-viewer-a', 'tenant:a', 'principal.e2e-client-viewer', 'viewer')
ON CONFLICT DO NOTHING;

-- ─── 8. multi-tenant — Operator in tenant:dev + Viewer in tenant:a ──────────
--         Tests workspace selection and cross-tenant switching

INSERT INTO g1.principals
    (principal_id, kind, credential_generation,
     idp_subject_ref, idp_issuer, display_name, email)
VALUES
    ('principal.e2e-multi-tenant', 'human_browser_session',
     'cred-gen-e2e-multi-tenant',
     'multi-tenant', 'dev-issuer:development',
     'Multi-Tenant User', 'multi@jlmirror.test')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-multi-dev', 'tenant:dev', 'principal.e2e-multi-tenant', 'operator')
ON CONFLICT DO NOTHING;

INSERT INTO g1.tenant_memberships (membership_id, tenant_id, principal_id, role)
VALUES ('mem-e2e-multi-a', 'tenant:a', 'principal.e2e-multi-tenant', 'viewer')
ON CONFLICT DO NOTHING;

COMMIT;
