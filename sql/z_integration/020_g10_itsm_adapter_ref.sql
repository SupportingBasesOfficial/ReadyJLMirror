-- 020: g10_create_incident — adapter_instance_ref dinâmico.
-- Lê itsm_adapter_instance_ref de g1.tenant_settings em vez de
-- hardcodar 'fixture-neutral@1'. Requer migration 033 já aplicada.

CREATE OR REPLACE FUNCTION itsm.g10_create_incident(
 p_tenant_id TEXT,p_alert_id TEXT,p_title TEXT,p_description TEXT,
 p_actor_principal_id TEXT,p_logical_action_id TEXT,p_authority_snapshot JSONB
) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER
SET search_path=pg_catalog,itsm,alerting,g1
AS $$
DECLARE
 v_id TEXT;v_hash TEXT;v_existing itsm.incident%ROWTYPE;v_outbox TEXT;
 v_adapter TEXT;
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

  SELECT itsm_adapter_instance_ref INTO v_adapter
    FROM g1.tenant_settings WHERE tenant_id=p_tenant_id;
  IF v_adapter IS NULL THEN
    RAISE EXCEPTION 'g10.itsm_adapter_not_configured';
  END IF;

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
    p_tenant_id,v_outbox,v_id,'pending',1,v_adapter,
    'g10-sync-identity:'||md5(p_tenant_id||chr(31)||v_id)
  );

  RETURN jsonb_build_object('incident_id',v_id,'duplicate',FALSE);
END;
$$;
