BEGIN;

CREATE SCHEMA IF NOT EXISTS itsm;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g10_itsm_executor') THEN
    CREATE ROLE jlmirror_g10_itsm_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g10_itsm_app_invoker') THEN
    CREATE ROLE jlmirror_g10_itsm_app_invoker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g10_itsm_worker_invoker') THEN
    CREATE ROLE jlmirror_g10_itsm_worker_invoker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

DO $$
DECLARE v_role RECORD;
BEGIN
  FOR v_role IN SELECT * FROM pg_roles
    WHERE rolname IN ('jlmirror_g10_itsm_executor','jlmirror_g10_itsm_app_invoker','jlmirror_g10_itsm_worker_invoker')
  LOOP
    IF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreatedb OR v_role.rolcreaterole
       OR v_role.rolinherit OR v_role.rolreplication OR v_role.rolbypassrls THEN
      RAISE EXCEPTION 'g10.role_unsafe:%',v_role.rolname;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members
      WHERE roleid=v_role.oid OR member=v_role.oid
    ) THEN
      RAISE EXCEPTION 'g10.role_unsafe_membership:%',v_role.rolname;
    END IF;
  END LOOP;
END;
$$;

DO $$
DECLARE
  v_executor_oid OID;
  v_unexpected TEXT;
BEGIN
  SELECT oid INTO v_executor_oid
  FROM pg_roles WHERE rolname='jlmirror_g10_itsm_executor';

  SELECT format('class=%s,objid=%s,dbid=%s',d.classid::regclass::TEXT,d.objid,d.dbid)
    INTO v_unexpected
    FROM pg_shdepend d
   WHERE d.refclassid='pg_authid'::regclass
     AND d.refobjid=v_executor_oid
     AND d.deptype='o'
   ORDER BY d.dbid,d.classid,d.objid
   LIMIT 1;

  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'g10.executor_unexpected_owned_object:%',v_unexpected;
  END IF;
END;
$$;

DO $$
DECLARE
  v_row RECORD;
  v_oid OID;
BEGIN
  FOR v_row IN
    SELECT signature FROM (VALUES
      ('itsm.g10_reject_immutable_mutation()'),
      ('itsm.g10_validate_authority(text,text,jsonb)'),
      ('itsm.g10_create_incident(text,text,text,text,text,text,jsonb)'),
      ('itsm.g10_transition_incident(text,text,text,text,text,jsonb)'),
      ('itsm.g10_assign_incident(text,text,text,text,text,jsonb)'),
      ('itsm.g10_add_comment(text,text,text,text,text,jsonb)'),
      ('itsm.g10_next_sync_candidate(text)'),
      ('itsm.g10_claim_sync(text,text,text,integer)'),
      ('itsm.g10_complete_sync(text,text,text,text,text,jsonb,text)'),
      ('itsm.g10_schedule_sync_retry(text,text)'),
      ('itsm.g10_reconcile_sync(text,text)'),
      ('itsm.g10_get_incident(text,text)'),
      ('itsm.g10_list_alert_incidents(text,text)')
    ) AS x(signature)
  LOOP
    v_oid:=to_regprocedure(v_row.signature);
    IF v_oid IS NULL THEN CONTINUE; END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_proc p,
           LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=v_oid AND a.privilege_type='EXECUTE'
        AND (a.grantee=0 OR a.grantee<>p.proowner)
    ) THEN
      RAISE EXCEPTION 'g10.existing_function_acl_unsafe:%',v_row.signature;
    END IF;
  END LOOP;
END;
$$;

GRANT USAGE ON SCHEMA itsm,alerting TO jlmirror_g10_itsm_executor;
GRANT USAGE ON SCHEMA itsm TO jlmirror_g10_itsm_app_invoker,jlmirror_g10_itsm_worker_invoker;
REVOKE CREATE ON SCHEMA itsm,alerting FROM jlmirror_g10_itsm_executor,jlmirror_g10_itsm_app_invoker,jlmirror_g10_itsm_worker_invoker;

CREATE TABLE itsm.incident (
  tenant_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  alert_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NULL,
  lifecycle_state TEXT NOT NULL CHECK (lifecycle_state IN ('open','in_progress','resolved','closed')),
  logical_action_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  created_by_principal_id TEXT NOT NULL,
  authority_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id,incident_id),
  UNIQUE (tenant_id,logical_action_id),
  FOREIGN KEY (tenant_id,alert_id) REFERENCES alerting.alert(tenant_id,alert_id),
  CHECK (tenant_id<>'' AND alert_id<>'' AND title<>'' AND length(title)<=240),
  CHECK (description IS NULL OR length(description)<=8000),
  CHECK (logical_action_id<>'' AND content_hash<>'' AND created_by_principal_id<>''),
  CHECK (jsonb_typeof(authority_snapshot)='object')
);

CREATE TABLE itsm.incident_transition (
  tenant_id TEXT NOT NULL,
  incident_transition_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  logical_action_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  authority_snapshot JSONB NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id,incident_transition_id),
  UNIQUE (tenant_id,incident_id,logical_action_id),
  FOREIGN KEY (tenant_id,incident_id) REFERENCES itsm.incident(tenant_id,incident_id),
  CHECK (from_state IN ('open','in_progress','resolved','closed')),
  CHECK (to_state IN ('open','in_progress','resolved','closed')),
  CHECK ((from_state,to_state) IN (('open','in_progress'),('open','resolved'),('in_progress','resolved'),('resolved','closed'))),
  CHECK (actor_principal_id<>'' AND logical_action_id<>''),
  CHECK (jsonb_typeof(authority_snapshot)='object')
);

CREATE TABLE itsm.incident_assignment (
  tenant_id TEXT NOT NULL,
  incident_assignment_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  assignee_principal_id TEXT NOT NULL,
  assigned_by_principal_id TEXT NOT NULL,
  logical_action_id TEXT NOT NULL,
  authority_snapshot JSONB NOT NULL,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  effective_until TIMESTAMPTZ NULL,
  PRIMARY KEY (tenant_id,incident_assignment_id),
  UNIQUE (tenant_id,incident_id,logical_action_id),
  FOREIGN KEY (tenant_id,incident_id) REFERENCES itsm.incident(tenant_id,incident_id),
  CHECK (assignee_principal_id<>'' AND assigned_by_principal_id<>'' AND logical_action_id<>''),
  CHECK (jsonb_typeof(authority_snapshot)='object'),
  CHECK (effective_until IS NULL OR effective_until>=effective_from)
);
CREATE UNIQUE INDEX g10_one_current_assignee
ON itsm.incident_assignment(tenant_id,incident_id) WHERE effective_until IS NULL;

CREATE TABLE itsm.incident_comment (
  tenant_id TEXT NOT NULL,
  incident_comment_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  body TEXT NOT NULL,
  logical_action_id TEXT NOT NULL,
  actor_principal_id TEXT NOT NULL,
  authority_snapshot JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id,incident_comment_id),
  UNIQUE (tenant_id,incident_id,logical_action_id),
  FOREIGN KEY (tenant_id,incident_id) REFERENCES itsm.incident(tenant_id,incident_id),
  CHECK (body<>'' AND length(body)<=4000),
  CHECK (logical_action_id<>'' AND actor_principal_id<>''),
  CHECK (jsonb_typeof(authority_snapshot)='object')
);

CREATE TABLE itsm.incident_provider_link (
  tenant_id TEXT NOT NULL,
  provider_link_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  adapter_instance_ref TEXT NOT NULL,
  provider_ticket_ref TEXT NOT NULL,
  provider_evidence JSONB NOT NULL,
  linked_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id,provider_link_id),
  UNIQUE (tenant_id,incident_id),
  UNIQUE (tenant_id,adapter_instance_ref,provider_ticket_ref),
  FOREIGN KEY (tenant_id,incident_id) REFERENCES itsm.incident(tenant_id,incident_id),
  CHECK (adapter_instance_ref<>'' AND provider_ticket_ref<>''),
  CHECK (jsonb_typeof(provider_evidence)='object')
);

CREATE TABLE itsm.incident_sync_outbox (
  tenant_id TEXT NOT NULL,
  sync_outbox_id TEXT NOT NULL,
  incident_id TEXT NOT NULL,
  sync_state TEXT NOT NULL CHECK (sync_state IN ('pending','dispatching','linked','failed','unknown','reconciliation_required')),
  attempt_number INTEGER NOT NULL DEFAULT 1 CHECK (attempt_number BETWEEN 1 AND 3),
  adapter_instance_ref TEXT NOT NULL,
  sync_identity TEXT NOT NULL,
  executor_id TEXT NULL,
  claim_expires_at TIMESTAMPTZ NULL,
  available_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  last_failure_class TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id,sync_outbox_id),
  UNIQUE (tenant_id,incident_id,attempt_number),
  FOREIGN KEY (tenant_id,incident_id) REFERENCES itsm.incident(tenant_id,incident_id),
  CHECK (adapter_instance_ref<>'' AND sync_identity<>''),
  CHECK (
    (sync_state='dispatching' AND executor_id IS NOT NULL AND claim_expires_at IS NOT NULL)
    OR
    (sync_state<>'dispatching' AND claim_expires_at IS NULL)
  )
);

ALTER TABLE itsm.incident ENABLE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident FORCE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_transition ENABLE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_transition FORCE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_assignment ENABLE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_assignment FORCE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_comment ENABLE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_comment FORCE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_provider_link ENABLE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_provider_link FORCE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_sync_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE itsm.incident_sync_outbox FORCE ROW LEVEL SECURITY;

CREATE POLICY g10_incident_tenant ON itsm.incident
USING (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''))
WITH CHECK (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''));
CREATE POLICY g10_transition_tenant ON itsm.incident_transition
USING (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''))
WITH CHECK (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''));
CREATE POLICY g10_assignment_tenant ON itsm.incident_assignment
USING (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''))
WITH CHECK (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''));
CREATE POLICY g10_comment_tenant ON itsm.incident_comment
USING (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''))
WITH CHECK (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''));
CREATE POLICY g10_provider_link_tenant ON itsm.incident_provider_link
USING (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''))
WITH CHECK (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''));
CREATE POLICY g10_sync_outbox_tenant ON itsm.incident_sync_outbox
USING (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''))
WITH CHECK (tenant_id=NULLIF(current_setting('jlmirror.tenant_id',true),''));

REVOKE ALL ON
 itsm.incident,itsm.incident_transition,itsm.incident_assignment,
 itsm.incident_comment,itsm.incident_provider_link,itsm.incident_sync_outbox
FROM PUBLIC,jlmirror_g10_itsm_app_invoker,jlmirror_g10_itsm_worker_invoker;

GRANT SELECT,INSERT,UPDATE ON itsm.incident TO jlmirror_g10_itsm_executor;
GRANT SELECT,INSERT ON itsm.incident_transition TO jlmirror_g10_itsm_executor;
GRANT SELECT,INSERT,UPDATE ON itsm.incident_assignment TO jlmirror_g10_itsm_executor;
GRANT SELECT,INSERT ON itsm.incident_comment TO jlmirror_g10_itsm_executor;
GRANT SELECT,INSERT ON itsm.incident_provider_link TO jlmirror_g10_itsm_executor;
GRANT SELECT,INSERT,UPDATE ON itsm.incident_sync_outbox TO jlmirror_g10_itsm_executor;
GRANT SELECT ON alerting.alert TO jlmirror_g10_itsm_executor;

CREATE OR REPLACE FUNCTION itsm.g10_reject_immutable_mutation()
RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,itsm
AS $$
BEGIN
  RAISE EXCEPTION 'g10.immutable_fact';
END;
$$;

CREATE TRIGGER g10_transition_immutable
BEFORE UPDATE OR DELETE ON itsm.incident_transition
FOR EACH ROW EXECUTE FUNCTION itsm.g10_reject_immutable_mutation();

CREATE TRIGGER g10_comment_immutable
BEFORE UPDATE OR DELETE ON itsm.incident_comment
FOR EACH ROW EXECUTE FUNCTION itsm.g10_reject_immutable_mutation();

CREATE TRIGGER g10_provider_link_immutable
BEFORE UPDATE OR DELETE ON itsm.incident_provider_link
FOR EACH ROW EXECUTE FUNCTION itsm.g10_reject_immutable_mutation();

CREATE OR REPLACE FUNCTION itsm.g10_validate_authority(
 p_tenant_id TEXT,p_actor_principal_id TEXT,p_authority_snapshot JSONB
) RETURNS VOID
LANGUAGE plpgsql SECURITY INVOKER
SET search_path=pg_catalog,itsm
AS $$
BEGIN
  IF jsonb_typeof(p_authority_snapshot)<>'object'
     OR COALESCE((p_authority_snapshot->>'current')::BOOLEAN,FALSE) IS NOT TRUE
     OR p_authority_snapshot->>'tenant_id' IS DISTINCT FROM p_tenant_id
     OR p_authority_snapshot->>'principal_id' IS DISTINCT FROM p_actor_principal_id
     OR COALESCE(p_authority_snapshot->>'action','')=''
     OR COALESCE(p_authority_snapshot->>'policy_revision','')='' THEN
    RAISE EXCEPTION 'g10.current_authority_required';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_create_incident(
 p_tenant_id TEXT,p_alert_id TEXT,p_title TEXT,p_description TEXT,
 p_actor_principal_id TEXT,p_logical_action_id TEXT,p_authority_snapshot JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm,alerting
AS $$
DECLARE
 v_id TEXT;v_hash TEXT;v_existing itsm.incident%ROWTYPE;v_outbox TEXT;
BEGIN
  PERFORM itsm.g10_validate_authority(p_tenant_id,p_actor_principal_id,p_authority_snapshot);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id||chr(31)||p_logical_action_id,10));
  IF COALESCE(p_title,'')='' OR length(p_title)>240
     OR (p_description IS NOT NULL AND length(p_description)>8000)
     OR COALESCE(p_logical_action_id,'')='' THEN
    RAISE EXCEPTION 'g10.incident_input_invalid';
  END IF;
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  PERFORM 1 FROM alerting.alert
   WHERE tenant_id=p_tenant_id AND alert_id=p_alert_id AND lifecycle_state='active';
  IF NOT FOUND THEN RAISE EXCEPTION 'g10.active_alert_required'; END IF;

  v_hash:=md5(concat_ws(chr(31),p_alert_id,p_title,COALESCE(p_description,''),p_actor_principal_id));
  v_id:='g10-incident:'||md5(p_tenant_id||chr(31)||p_logical_action_id);

  SELECT * INTO v_existing FROM itsm.incident
   WHERE tenant_id=p_tenant_id AND logical_action_id=p_logical_action_id;
  IF FOUND THEN
    IF v_existing.content_hash<>v_hash THEN RAISE EXCEPTION 'g10.incident_equivalence_conflict'; END IF;
    RETURN jsonb_build_object('incident_id',v_existing.incident_id,'duplicate',TRUE);
  END IF;

  INSERT INTO itsm.incident(
    tenant_id,incident_id,alert_id,title,description,lifecycle_state,
    logical_action_id,content_hash,created_by_principal_id,authority_snapshot
  ) VALUES (
    p_tenant_id,v_id,p_alert_id,p_title,p_description,'open',
    p_logical_action_id,v_hash,p_actor_principal_id,p_authority_snapshot
  );

  v_outbox:='g10-sync:'||md5(p_tenant_id||chr(31)||v_id||chr(31)||'1');
  INSERT INTO itsm.incident_sync_outbox(
    tenant_id,sync_outbox_id,incident_id,sync_state,attempt_number,
    adapter_instance_ref,sync_identity
  ) VALUES (
    p_tenant_id,v_outbox,v_id,'pending',1,'fixture-neutral@1',
    'g10-sync-identity:'||md5(p_tenant_id||chr(31)||v_id)
  );

  RETURN jsonb_build_object('incident_id',v_id,'duplicate',FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_transition_incident(
 p_tenant_id TEXT,p_incident_id TEXT,p_target_state TEXT,
 p_actor_principal_id TEXT,p_logical_action_id TEXT,p_authority_snapshot JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE
 v_incident itsm.incident%ROWTYPE;
 v_transition_id TEXT;
 v_existing_transition itsm.incident_transition%ROWTYPE;
BEGIN
  PERFORM itsm.g10_validate_authority(p_tenant_id,p_actor_principal_id,p_authority_snapshot);
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id||chr(31)||p_incident_id,0));
  SELECT * INTO v_incident FROM itsm.incident
   WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'g10.incident_missing'; END IF;

  SELECT * INTO v_existing_transition
  FROM itsm.incident_transition
  WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
    AND logical_action_id=p_logical_action_id;
  IF FOUND THEN
    IF v_existing_transition.to_state IS DISTINCT FROM p_target_state THEN
      RAISE EXCEPTION 'g10.transition_equivalence_conflict';
    END IF;
    RETURN jsonb_build_object(
      'incident_id',p_incident_id,
      'state',v_existing_transition.to_state,
      'duplicate',TRUE
    );
  END IF;

  IF (v_incident.lifecycle_state,p_target_state) NOT IN (
    ('open','in_progress'),('open','resolved'),('in_progress','resolved'),('resolved','closed')
  ) THEN RAISE EXCEPTION 'g10.transition_not_authorized'; END IF;

  v_transition_id:='g10-transition:'||md5(p_tenant_id||chr(31)||p_incident_id||chr(31)||p_logical_action_id);
  INSERT INTO itsm.incident_transition(
    tenant_id,incident_transition_id,incident_id,from_state,to_state,
    logical_action_id,actor_principal_id,authority_snapshot
  ) VALUES (
    p_tenant_id,v_transition_id,p_incident_id,v_incident.lifecycle_state,p_target_state,
    p_logical_action_id,p_actor_principal_id,p_authority_snapshot
  );
  UPDATE itsm.incident SET lifecycle_state=p_target_state,updated_at=transaction_timestamp()
   WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id;
  RETURN jsonb_build_object('incident_id',p_incident_id,'state',p_target_state,'duplicate',FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_assign_incident(
 p_tenant_id TEXT,p_incident_id TEXT,p_assignee_principal_id TEXT,
 p_actor_principal_id TEXT,p_logical_action_id TEXT,p_authority_snapshot JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE v_id TEXT;v_existing itsm.incident_assignment%ROWTYPE;
BEGIN
  PERFORM itsm.g10_validate_authority(p_tenant_id,p_actor_principal_id,p_authority_snapshot);
  IF COALESCE(p_assignee_principal_id,'')='' OR COALESCE(p_logical_action_id,'')='' THEN
    RAISE EXCEPTION 'g10.assignment_input_invalid';
  END IF;
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id||chr(31)||p_incident_id,1));
  PERFORM 1 FROM itsm.incident WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'g10.incident_missing'; END IF;

  SELECT * INTO v_existing FROM itsm.incident_assignment
   WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
     AND logical_action_id=p_logical_action_id;
  IF FOUND THEN
    IF v_existing.assignee_principal_id<>p_assignee_principal_id THEN
      RAISE EXCEPTION 'g10.assignment_equivalence_conflict';
    END IF;
    RETURN jsonb_build_object('incident_assignment_id',v_existing.incident_assignment_id,'duplicate',TRUE);
  END IF;

  UPDATE itsm.incident_assignment SET effective_until=transaction_timestamp()
   WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id AND effective_until IS NULL;

  v_id:='g10-assignment:'||md5(p_tenant_id||chr(31)||p_incident_id||chr(31)||p_logical_action_id);
  INSERT INTO itsm.incident_assignment(
    tenant_id,incident_assignment_id,incident_id,assignee_principal_id,
    assigned_by_principal_id,logical_action_id,authority_snapshot
  ) VALUES (
    p_tenant_id,v_id,p_incident_id,p_assignee_principal_id,
    p_actor_principal_id,p_logical_action_id,p_authority_snapshot
  );
  RETURN jsonb_build_object('incident_assignment_id',v_id,'duplicate',FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_add_comment(
 p_tenant_id TEXT,p_incident_id TEXT,p_body TEXT,
 p_actor_principal_id TEXT,p_logical_action_id TEXT,p_authority_snapshot JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE v_id TEXT;v_existing itsm.incident_comment%ROWTYPE;
BEGIN
  PERFORM itsm.g10_validate_authority(p_tenant_id,p_actor_principal_id,p_authority_snapshot);
  IF COALESCE(p_body,'')='' OR length(p_body)>4000 OR COALESCE(p_logical_action_id,'')='' THEN
    RAISE EXCEPTION 'g10.comment_input_invalid';
  END IF;
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  PERFORM 1 FROM itsm.incident WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'g10.incident_missing'; END IF;

  SELECT * INTO v_existing FROM itsm.incident_comment
   WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
     AND logical_action_id=p_logical_action_id;
  IF FOUND THEN
    IF v_existing.body<>p_body THEN RAISE EXCEPTION 'g10.comment_equivalence_conflict'; END IF;
    RETURN jsonb_build_object('incident_comment_id',v_existing.incident_comment_id,'duplicate',TRUE);
  END IF;

  v_id:='g10-comment:'||md5(p_tenant_id||chr(31)||p_incident_id||chr(31)||p_logical_action_id);
  INSERT INTO itsm.incident_comment(
    tenant_id,incident_comment_id,incident_id,body,logical_action_id,
    actor_principal_id,authority_snapshot
  ) VALUES (
    p_tenant_id,v_id,p_incident_id,p_body,p_logical_action_id,
    p_actor_principal_id,p_authority_snapshot
  );
  RETURN jsonb_build_object('incident_comment_id',v_id,'duplicate',FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_next_sync_candidate(p_tenant_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE v_result JSONB;
BEGIN
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  SELECT to_jsonb(x) INTO v_result FROM (
    SELECT o.sync_outbox_id,o.incident_id,o.attempt_number,o.adapter_instance_ref,o.sync_identity,
           i.alert_id,i.title,i.description,i.lifecycle_state
    FROM itsm.incident_sync_outbox o
    JOIN itsm.incident i ON i.tenant_id=o.tenant_id AND i.incident_id=o.incident_id
    WHERE o.tenant_id=p_tenant_id
      AND (
        (o.sync_state='pending' AND o.available_at<=transaction_timestamp())
        OR
        (o.sync_state='dispatching' AND o.claim_expires_at<=transaction_timestamp())
      )
    ORDER BY
      CASE WHEN o.sync_state='dispatching' THEN 0 ELSE 1 END,
      o.available_at,o.created_at
    LIMIT 1
  ) x;
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_claim_sync(
 p_tenant_id TEXT,p_outbox_id TEXT,p_executor_id TEXT,p_claim_seconds INTEGER
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE v_outbox itsm.incident_sync_outbox%ROWTYPE;
BEGIN
  IF COALESCE(p_executor_id,'')='' OR p_claim_seconds<1 OR p_claim_seconds>300 THEN
    RAISE EXCEPTION 'g10.sync_claim_input_invalid';
  END IF;
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  SELECT * INTO v_outbox FROM itsm.incident_sync_outbox
   WHERE tenant_id=p_tenant_id AND sync_outbox_id=p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'g10.sync_outbox_missing'; END IF;

  IF v_outbox.sync_state='dispatching' AND v_outbox.claim_expires_at<=transaction_timestamp() THEN
    UPDATE itsm.incident_sync_outbox
      SET sync_state='reconciliation_required',executor_id=NULL,claim_expires_at=NULL,updated_at=transaction_timestamp()
    WHERE tenant_id=p_tenant_id AND sync_outbox_id=p_outbox_id;
    RETURN jsonb_build_object('state','reconciliation_required','duplicate',FALSE);
  END IF;

  IF v_outbox.sync_state<>'pending' THEN
    RETURN jsonb_build_object('state',v_outbox.sync_state,'duplicate',TRUE);
  END IF;

  UPDATE itsm.incident_sync_outbox
    SET sync_state='dispatching',executor_id=p_executor_id,
        claim_expires_at=transaction_timestamp()+make_interval(secs=>p_claim_seconds),
        updated_at=transaction_timestamp()
  WHERE tenant_id=p_tenant_id AND sync_outbox_id=p_outbox_id;
  RETURN jsonb_build_object('state','dispatching','duplicate',FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_complete_sync(
 p_tenant_id TEXT,p_outbox_id TEXT,p_executor_id TEXT,p_result_state TEXT,
 p_provider_ticket_ref TEXT,p_provider_evidence JSONB,p_failure_class TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE v_outbox itsm.incident_sync_outbox%ROWTYPE;v_link_id TEXT;
BEGIN
  IF p_result_state NOT IN ('linked','failed','unknown') THEN
    RAISE EXCEPTION 'g10.sync_result_invalid';
  END IF;
  IF jsonb_typeof(p_provider_evidence)<>'object' THEN
    RAISE EXCEPTION 'g10.provider_evidence_invalid';
  END IF;
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  SELECT * INTO v_outbox FROM itsm.incident_sync_outbox
   WHERE tenant_id=p_tenant_id AND sync_outbox_id=p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'g10.sync_outbox_missing'; END IF;

  IF v_outbox.sync_state IN ('linked','failed','unknown') THEN
    IF v_outbox.sync_state IS DISTINCT FROM p_result_state
       OR v_outbox.last_failure_class IS DISTINCT FROM p_failure_class THEN
      RAISE EXCEPTION 'g10.sync_completion_equivalence_conflict';
    END IF;
    IF p_result_state='linked' AND NOT EXISTS (
      SELECT 1 FROM itsm.incident_provider_link
      WHERE tenant_id=p_tenant_id AND incident_id=v_outbox.incident_id
        AND provider_ticket_ref=p_provider_ticket_ref
    ) THEN
      RAISE EXCEPTION 'g10.sync_completion_equivalence_conflict';
    END IF;
    RETURN jsonb_build_object('state',v_outbox.sync_state,'duplicate',TRUE);
  END IF;
  IF v_outbox.sync_state<>'dispatching' OR v_outbox.executor_id<>p_executor_id
     OR v_outbox.claim_expires_at<=transaction_timestamp() THEN
    RAISE EXCEPTION 'g10.sync_claim_lost';
  END IF;

  IF p_result_state='linked' THEN
    IF COALESCE(p_provider_ticket_ref,'')='' THEN RAISE EXCEPTION 'g10.provider_ticket_ref_required'; END IF;
    v_link_id:='g10-provider-link:'||md5(p_tenant_id||chr(31)||v_outbox.incident_id);
    IF EXISTS (
      SELECT 1 FROM itsm.incident_provider_link
      WHERE tenant_id=p_tenant_id AND incident_id=v_outbox.incident_id
    ) THEN
      IF NOT EXISTS (
        SELECT 1 FROM itsm.incident_provider_link
        WHERE tenant_id=p_tenant_id AND incident_id=v_outbox.incident_id
          AND adapter_instance_ref=v_outbox.adapter_instance_ref
          AND provider_ticket_ref=p_provider_ticket_ref
      ) THEN
        RAISE EXCEPTION 'g10.provider_link_equivalence_conflict';
      END IF;
    ELSE
      INSERT INTO itsm.incident_provider_link(
        tenant_id,provider_link_id,incident_id,adapter_instance_ref,
        provider_ticket_ref,provider_evidence
      ) VALUES (
        p_tenant_id,v_link_id,v_outbox.incident_id,v_outbox.adapter_instance_ref,
        p_provider_ticket_ref,p_provider_evidence
      );
    END IF;
  END IF;

  UPDATE itsm.incident_sync_outbox
    SET sync_state=p_result_state,executor_id=NULL,claim_expires_at=NULL,
        last_failure_class=p_failure_class,updated_at=transaction_timestamp()
  WHERE tenant_id=p_tenant_id AND sync_outbox_id=p_outbox_id;

  RETURN jsonb_build_object('state',p_result_state,'duplicate',FALSE);
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_schedule_sync_retry(
 p_tenant_id TEXT,p_incident_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE
  v_last itsm.incident_sync_outbox%ROWTYPE;
  v_next_id TEXT;
BEGIN
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  PERFORM pg_advisory_xact_lock(hashtextextended(p_tenant_id||chr(31)||p_incident_id,2));

  SELECT * INTO v_last FROM itsm.incident_sync_outbox
   WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
   ORDER BY attempt_number DESC LIMIT 1;
  IF NOT FOUND THEN RAISE EXCEPTION 'g10.sync_outbox_missing'; END IF;

  IF EXISTS (
    SELECT 1 FROM itsm.incident_provider_link
    WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
  ) THEN
    RETURN jsonb_build_object('scheduled',FALSE,'reason','provider_already_linked');
  END IF;

  IF v_last.sync_state NOT IN ('failed','unknown') THEN
    RETURN jsonb_build_object('scheduled',FALSE,'reason','retry_not_required');
  END IF;

  IF v_last.attempt_number>=3 THEN
    RETURN jsonb_build_object('scheduled',FALSE,'reason','retry_budget_exhausted');
  END IF;

  v_next_id:='g10-sync:'||md5(
    p_tenant_id||chr(31)||p_incident_id||chr(31)||(v_last.attempt_number+1)::TEXT
  );

  INSERT INTO itsm.incident_sync_outbox(
    tenant_id,sync_outbox_id,incident_id,sync_state,attempt_number,
    adapter_instance_ref,sync_identity,available_at
  ) VALUES (
    p_tenant_id,v_next_id,p_incident_id,'pending',v_last.attempt_number+1,
    v_last.adapter_instance_ref,v_last.sync_identity,
    transaction_timestamp()+make_interval(secs=>LEAST(300,5*(2^v_last.attempt_number)::INTEGER))
  )
  ON CONFLICT (tenant_id,incident_id,attempt_number) DO NOTHING;

  RETURN jsonb_build_object(
    'scheduled',TRUE,'sync_outbox_id',v_next_id,'attempt_number',v_last.attempt_number+1
  );
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_reconcile_sync(
 p_tenant_id TEXT,p_outbox_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE v_outbox itsm.incident_sync_outbox%ROWTYPE;
BEGIN
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  SELECT * INTO v_outbox FROM itsm.incident_sync_outbox
   WHERE tenant_id=p_tenant_id AND sync_outbox_id=p_outbox_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'g10.sync_outbox_missing'; END IF;
  IF v_outbox.sync_state<>'reconciliation_required' THEN
    RETURN jsonb_build_object('reconciled',FALSE,'state',v_outbox.sync_state);
  END IF;
  UPDATE itsm.incident_sync_outbox
    SET sync_state='unknown',last_failure_class='lease_expired_outcome_unknown',
        updated_at=transaction_timestamp()
  WHERE tenant_id=p_tenant_id AND sync_outbox_id=p_outbox_id;
  RETURN jsonb_build_object('reconciled',TRUE,'state','unknown');
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_get_incident(
 p_tenant_id TEXT,p_incident_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm,alerting
AS $$
DECLARE v_incident JSONB;v_transitions JSONB;v_assignments JSONB;v_comments JSONB;v_sync JSONB;v_alert JSONB;
BEGIN
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  SELECT to_jsonb(x) INTO v_incident FROM (
    SELECT incident_id,alert_id,title,description,lifecycle_state,created_at,updated_at
    FROM itsm.incident WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
  ) x;
  IF v_incident IS NULL THEN RAISE EXCEPTION 'g10.incident_missing'; END IF;

  SELECT to_jsonb(x) INTO v_alert FROM (
    SELECT alert_id,lifecycle_state,opened_at,resolved_at
    FROM alerting.alert WHERE tenant_id=p_tenant_id AND alert_id=v_incident->>'alert_id'
  ) x;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY occurred_at),'[]'::jsonb) INTO v_transitions FROM (
    SELECT incident_transition_id,from_state,to_state,actor_principal_id,occurred_at
    FROM itsm.incident_transition WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
  ) x;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY effective_from),'[]'::jsonb) INTO v_assignments FROM (
    SELECT incident_assignment_id,assignee_principal_id,assigned_by_principal_id,effective_from,effective_until
    FROM itsm.incident_assignment WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
  ) x;

  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY created_at),'[]'::jsonb) INTO v_comments FROM (
    SELECT incident_comment_id,body,actor_principal_id,created_at
    FROM itsm.incident_comment WHERE tenant_id=p_tenant_id AND incident_id=p_incident_id
  ) x;

  SELECT to_jsonb(x) INTO v_sync FROM (
    SELECT o.sync_state,o.attempt_number,o.adapter_instance_ref,o.last_failure_class,
           l.provider_ticket_ref,l.linked_at
    FROM itsm.incident_sync_outbox o
    LEFT JOIN itsm.incident_provider_link l
      ON l.tenant_id=o.tenant_id AND l.incident_id=o.incident_id
    WHERE o.tenant_id=p_tenant_id AND o.incident_id=p_incident_id
    ORDER BY o.attempt_number DESC LIMIT 1
  ) x;

  RETURN v_incident||jsonb_build_object(
    'alert_summary',COALESCE(v_alert,'{}'::jsonb),
    'transitions',v_transitions,'assignments',v_assignments,
    'comments',v_comments,'provider_sync',COALESCE(v_sync,'{}'::jsonb)
  );
END;
$$;

CREATE OR REPLACE FUNCTION itsm.g10_list_alert_incidents(
 p_tenant_id TEXT,p_alert_id TEXT
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm
AS $$
DECLARE v_result JSONB;
BEGIN
  PERFORM set_config('jlmirror.tenant_id',p_tenant_id,true);
  SELECT COALESCE(jsonb_agg(to_jsonb(x) ORDER BY created_at DESC),'[]'::jsonb) INTO v_result FROM (
    SELECT incident_id,alert_id,title,lifecycle_state,created_at,updated_at
    FROM itsm.incident WHERE tenant_id=p_tenant_id AND alert_id=p_alert_id
  ) x;
  RETURN v_result;
END;
$$;

ALTER FUNCTION itsm.g10_reject_immutable_mutation() OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_validate_authority(TEXT,TEXT,JSONB) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_create_incident(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_transition_incident(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_assign_incident(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_add_comment(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_next_sync_candidate(TEXT) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_claim_sync(TEXT,TEXT,TEXT,INTEGER) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_complete_sync(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_schedule_sync_retry(TEXT,TEXT) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_reconcile_sync(TEXT,TEXT) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_get_incident(TEXT,TEXT) OWNER TO jlmirror_g10_itsm_executor;
ALTER FUNCTION itsm.g10_list_alert_incidents(TEXT,TEXT) OWNER TO jlmirror_g10_itsm_executor;

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA itsm FROM PUBLIC;

GRANT EXECUTE ON FUNCTION itsm.g10_create_incident(TEXT,TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) TO jlmirror_g10_itsm_app_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_transition_incident(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) TO jlmirror_g10_itsm_app_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_assign_incident(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) TO jlmirror_g10_itsm_app_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_add_comment(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB) TO jlmirror_g10_itsm_app_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_get_incident(TEXT,TEXT) TO jlmirror_g10_itsm_app_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_list_alert_incidents(TEXT,TEXT) TO jlmirror_g10_itsm_app_invoker;

GRANT EXECUTE ON FUNCTION itsm.g10_next_sync_candidate(TEXT) TO jlmirror_g10_itsm_worker_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_claim_sync(TEXT,TEXT,TEXT,INTEGER) TO jlmirror_g10_itsm_worker_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_complete_sync(TEXT,TEXT,TEXT,TEXT,TEXT,JSONB,TEXT) TO jlmirror_g10_itsm_worker_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_schedule_sync_retry(TEXT,TEXT) TO jlmirror_g10_itsm_worker_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_reconcile_sync(TEXT,TEXT) TO jlmirror_g10_itsm_worker_invoker;
GRANT EXECUTE ON FUNCTION itsm.g10_get_incident(TEXT,TEXT) TO jlmirror_g10_itsm_worker_invoker;

DO $$
DECLARE
  v_executor OID;
  v_app OID;
  v_worker OID;
  v_row RECORD;
  v_oid OID;
BEGIN
  SELECT oid INTO v_executor FROM pg_roles WHERE rolname='jlmirror_g10_itsm_executor';
  SELECT oid INTO v_app FROM pg_roles WHERE rolname='jlmirror_g10_itsm_app_invoker';
  SELECT oid INTO v_worker FROM pg_roles WHERE rolname='jlmirror_g10_itsm_worker_invoker';

  FOR v_row IN
    SELECT signature,exposure FROM (VALUES
      ('itsm.g10_reject_immutable_mutation()','internal'),
      ('itsm.g10_validate_authority(text,text,jsonb)','internal'),
      ('itsm.g10_create_incident(text,text,text,text,text,text,jsonb)','app'),
      ('itsm.g10_transition_incident(text,text,text,text,text,jsonb)','app'),
      ('itsm.g10_assign_incident(text,text,text,text,text,jsonb)','app'),
      ('itsm.g10_add_comment(text,text,text,text,text,jsonb)','app'),
      ('itsm.g10_next_sync_candidate(text)','worker'),
      ('itsm.g10_claim_sync(text,text,text,integer)','worker'),
      ('itsm.g10_complete_sync(text,text,text,text,text,jsonb,text)','worker'),
      ('itsm.g10_schedule_sync_retry(text,text)','worker'),
      ('itsm.g10_reconcile_sync(text,text)','worker'),
      ('itsm.g10_get_incident(text,text)','shared_read'),
      ('itsm.g10_list_alert_incidents(text,text)','app')
    ) AS x(signature,exposure)
  LOOP
    v_oid:=to_regprocedure(v_row.signature);
    IF v_oid IS NULL THEN
      RAISE EXCEPTION 'g10.function_missing:%',v_row.signature;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid=v_oid AND p.proowner<>v_executor) THEN
      RAISE EXCEPTION 'g10.function_owner_unsafe:%',v_row.signature;
    END IF;
    IF v_row.exposure<>'internal' AND EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.oid=v_oid AND p.prosecdef IS NOT TRUE
    ) THEN
      RAISE EXCEPTION 'g10.exposed_function_not_security_definer:%',v_row.signature;
    END IF;
    IF EXISTS (
      SELECT 1
      FROM pg_proc p,
           LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.oid=v_oid AND a.privilege_type='EXECUTE'
        AND (
          a.grantee=0 OR a.is_grantable
          OR (v_row.exposure='internal' AND a.grantee<>p.proowner)
          OR (v_row.exposure='app' AND a.grantee NOT IN (p.proowner,v_app))
          OR (v_row.exposure='worker' AND a.grantee NOT IN (p.proowner,v_worker))
          OR (v_row.exposure='shared_read' AND a.grantee NOT IN (p.proowner,v_app,v_worker))
        )
    ) THEN
      RAISE EXCEPTION 'g10.function_acl_unsafe:%',v_row.signature;
    END IF;
  END LOOP;
END;
$$;

COMMIT;
