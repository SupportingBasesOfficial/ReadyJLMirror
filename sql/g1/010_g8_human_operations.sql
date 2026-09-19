-- G8 human operations — adapted from canonical
-- sql/human_operations/001_human_operations.sql (same six relations
-- and invariants; mutations inside tenant-scoped transactions in
-- application code under the alerting:operate permission gate,
-- each carrying an immutable authority snapshot).

BEGIN;

CREATE SCHEMA IF NOT EXISTS human_operations;

-- Resource responsibility: multiple concurrent principals;
-- identity/content immutable; ending is terminal closure.
CREATE TABLE human_operations.resource_responsibility_assignment (
    tenant_id TEXT NOT NULL,
    responsibility_assignment_id TEXT NOT NULL,
    monitoring_resource_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    responsibility_role TEXT NOT NULL CHECK (
        responsibility_role IN ('technical_responsible',
            'service_owner','operator','customer_responsible')),
    assignment_source TEXT NOT NULL
        CHECK (assignment_source IN ('manual','configured')),
    logical_action_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    assigned_by_principal_id TEXT NOT NULL,
    authority_snapshot JSONB NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    effective_until TIMESTAMPTZ NULL,
    ended_by_principal_id TEXT NULL,
    end_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, responsibility_assignment_id),
    UNIQUE (tenant_id, logical_action_id),
    FOREIGN KEY (tenant_id, monitoring_resource_id)
        REFERENCES monitoring.monitoring_resource
            (tenant_id, monitoring_resource_id),
    CHECK (jsonb_typeof(authority_snapshot)='object'),
    CHECK (
      (effective_until IS NULL AND ended_by_principal_id IS NULL
       AND end_reason IS NULL)
      OR
      (effective_until IS NOT NULL AND ended_by_principal_id
       IS NOT NULL AND end_reason IS NOT NULL))
);

-- Alert action: exactly one current owner per alert; reassignment
-- atomically closes the prior assignment.
CREATE TABLE human_operations.alert_action_assignment (
    tenant_id TEXT NOT NULL,
    action_assignment_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    owner_principal_id TEXT NOT NULL,
    action_kind TEXT NOT NULL CHECK (
        action_kind IN ('investigate_alert','acknowledge_alert',
            'review_alert','customer_review_required')),
    logical_action_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    assigned_by_principal_id TEXT NOT NULL,
    authority_snapshot JSONB NOT NULL,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    effective_until TIMESTAMPTZ NULL,
    ended_by_principal_id TEXT NULL,
    end_reason TEXT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, action_assignment_id),
    UNIQUE (tenant_id, logical_action_id),
    FOREIGN KEY (tenant_id, alert_id)
        REFERENCES alerting.alert(tenant_id, alert_id),
    CHECK (jsonb_typeof(authority_snapshot)='object'),
    CHECK (
      (effective_until IS NULL AND ended_by_principal_id IS NULL
       AND end_reason IS NULL)
      OR
      (effective_until IS NOT NULL AND ended_by_principal_id
       IS NOT NULL AND end_reason IS NOT NULL))
);
CREATE UNIQUE INDEX human_ops_one_current_action_owner
ON human_operations.alert_action_assignment(tenant_id, alert_id)
WHERE effective_until IS NULL;

-- ACK: append-only actor/time evidence; never mutates lifecycle.
CREATE TABLE human_operations.alert_acknowledgement (
    tenant_id TEXT NOT NULL,
    acknowledgement_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    principal_id TEXT NOT NULL,
    logical_action_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    authority_snapshot JSONB NOT NULL,
    note TEXT NULL CHECK (note IS NULL OR length(note) <= 1024),
    acknowledged_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, acknowledgement_id),
    UNIQUE (tenant_id, logical_action_id),
    FOREIGN KEY (tenant_id, alert_id)
        REFERENCES alerting.alert(tenant_id, alert_id),
    CHECK (jsonb_typeof(authority_snapshot)='object')
);

-- Native visibility: requirement while alert is ACTIVE; receipt by
-- the exact required viewer (may be late evidence post-resolution).
CREATE TABLE human_operations.visibility_requirement (
    tenant_id TEXT NOT NULL,
    visibility_requirement_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    required_viewer_principal_id TEXT NOT NULL,
    viewer_side TEXT NOT NULL CHECK (viewer_side IN ('internal','customer')),
    capability_class TEXT NOT NULL
        CHECK (capability_class='platform_native_authenticated_view@1'),
    presentation_ref TEXT NOT NULL,
    logical_action_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    created_by_principal_id TEXT NOT NULL,
    authority_snapshot JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, visibility_requirement_id),
    UNIQUE (tenant_id, logical_action_id),
    FOREIGN KEY (tenant_id, alert_id)
        REFERENCES alerting.alert(tenant_id, alert_id),
    CHECK (jsonb_typeof(authority_snapshot)='object')
);

CREATE TABLE human_operations.visibility_receipt (
    tenant_id TEXT NOT NULL,
    visibility_receipt_id TEXT NOT NULL,
    visibility_requirement_id TEXT NOT NULL,
    viewer_principal_id TEXT NOT NULL,
    logical_action_id TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    authority_snapshot JSONB NOT NULL,
    session_evidence JSONB NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, visibility_receipt_id),
    UNIQUE (tenant_id, logical_action_id),
    FOREIGN KEY (tenant_id, visibility_requirement_id)
        REFERENCES human_operations.visibility_requirement
            (tenant_id, visibility_requirement_id),
    CHECK (jsonb_typeof(authority_snapshot)='object'),
    CHECK (jsonb_typeof(session_evidence)='object')
);

-- Derived current-action projection — rebuildable from history.
CREATE TABLE human_operations.current_action_projection (
    tenant_id TEXT NOT NULL,
    alert_id TEXT NOT NULL,
    action_assignment_id TEXT NULL,
    owner_principal_id TEXT NULL,
    current_action TEXT NOT NULL CHECK (
        current_action IN ('investigate_alert','acknowledge_alert',
            'review_alert','customer_review_required',
            'no_human_action_required')),
    projection_revision BIGINT NOT NULL CHECK (projection_revision>0),
    projected_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (tenant_id, alert_id),
    FOREIGN KEY (tenant_id, alert_id)
        REFERENCES alerting.alert(tenant_id, alert_id),
    CHECK (
      (current_action='no_human_action_required'
       AND action_assignment_id IS NULL AND owner_principal_id IS NULL)
      OR
      (current_action<>'no_human_action_required'
       AND action_assignment_id IS NOT NULL
       AND owner_principal_id IS NOT NULL))
);

ALTER TABLE human_operations.resource_responsibility_assignment
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.resource_responsibility_assignment
    FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.alert_action_assignment
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.alert_action_assignment
    FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.alert_acknowledgement
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.alert_acknowledgement
    FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.visibility_requirement
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.visibility_requirement
    FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.visibility_receipt
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.visibility_receipt
    FORCE ROW LEVEL SECURITY;
ALTER TABLE human_operations.current_action_projection
    ENABLE ROW LEVEL SECURITY;
ALTER TABLE human_operations.current_action_projection
    FORCE ROW LEVEL SECURITY;

DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY[
        'resource_responsibility_assignment',
        'alert_action_assignment','alert_acknowledgement',
        'visibility_requirement','visibility_receipt',
        'current_action_projection']
    LOOP
        EXECUTE format(
            'CREATE POLICY g8_%I_tenant ON human_operations.%I
             USING (tenant_id=NULLIF(current_setting(
                 ''jlmirror.tenant_id'',true),''''))
             WITH CHECK (tenant_id=NULLIF(current_setting(
                 ''jlmirror.tenant_id'',true),''''))', t, t);
    END LOOP;
END $$;

GRANT USAGE ON SCHEMA human_operations TO jlmirror_app;

GRANT SELECT, INSERT, UPDATE ON
    human_operations.resource_responsibility_assignment,
    human_operations.alert_action_assignment,
    human_operations.alert_acknowledgement,
    human_operations.visibility_requirement,
    human_operations.visibility_receipt,
    human_operations.current_action_projection
TO jlmirror_app;

COMMIT;
