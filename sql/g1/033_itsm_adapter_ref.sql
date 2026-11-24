-- Migration 033: ITSM adapter instance ref per tenant.
-- Allows each tenant to configure which ITSM adapter (e.g. Jira, ServiceNow)
-- g10_create_incident uses when creating the outbox sync entry.
-- NULL = ITSM not configured for the tenant (create_incident raises g10.itsm_adapter_not_configured).

ALTER TABLE g1.tenant_settings
    ADD COLUMN IF NOT EXISTS itsm_adapter_instance_ref TEXT
        CHECK (itsm_adapter_instance_ref IS NULL OR itsm_adapter_instance_ref <> '');
