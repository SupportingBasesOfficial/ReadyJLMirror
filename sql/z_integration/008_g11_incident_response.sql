BEGIN;

CREATE SCHEMA IF NOT EXISTS incident_response;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g11_ir_executor') THEN
    CREATE ROLE jlmirror_g11_ir_executor
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g11_ir_app_invoker') THEN
    CREATE ROLE jlmirror_g11_ir_app_invoker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='jlmirror_g11_ir_worker_invoker') THEN
    CREATE ROLE jlmirror_g11_ir_worker_invoker
      NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END;
$$;

DO $$
DECLARE v_role RECORD;
BEGIN
  FOR v_role IN SELECT * FROM pg_roles
    WHERE rolname IN ('jlmirror_g11_ir_executor','jlmirror_g11_ir_app_invoker','jlmirror_g11_ir_worker_invoker')
  LOOP
    IF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreatedb OR v_role.rolcreaterole
       OR v_role.rolinherit OR v_role.rolreplication OR v_role.rolbypassrls THEN
      RAISE EXCEPTION 'g11.role_unsafe:%',v_role.rolname;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_auth_members
      WHERE roleid=v_role.oid OR member=v_role.oid
    ) THEN
      RAISE EXCEPTION 'g11.role_unsafe_membership:%',v_role.rolname;
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
  FROM pg_roles WHERE rolname='jlmirror_g11_ir_executor';

  SELECT format('class=%s,objid=%s,dbid=%s',d.classid::regclass::TEXT,d.objid,d.dbid)
    INTO v_unexpected
    FROM pg_shdepend d
   WHERE d.refclassid='pg_authid'::regclass
     AND d.refobjid=v_executor_oid
     AND d.deptype='o'
   ORDER BY d.dbid,d.classid,d.objid
   LIMIT 1;

  IF v_unexpected IS NOT NULL THEN
    RAISE EXCEPTION 'g11.executor_unexpected_owned_object:%',v_unexpected;
  END IF;
END;
$$;

GRANT USAGE ON SCHEMA incident_response TO jlmirror_g11_ir_executor;
GRANT USAGE ON SCHEMA incident_response TO jlmirror_g11_ir_app_invoker,jlmirror_g11_ir_worker_invoker;
REVOKE CREATE ON SCHEMA incident_response FROM jlmirror_g11_ir_executor,jlmirror_g11_ir_app_invoker,jlmirror_g11_ir_worker_invoker;

-- Per-tenant incident response policy (one row per tenant, upserted)
CREATE TABLE incident_response.policy (
  tenant_id          TEXT NOT NULL PRIMARY KEY,
  severity_threshold TEXT NOT NULL DEFAULT 'HIGH'
                         CHECK (severity_threshold IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  auto_open_ticket   BOOLEAN NOT NULL DEFAULT FALSE,
  manual_override_only BOOLEAN NOT NULL DEFAULT FALSE,
  notify_channels    JSONB NOT NULL DEFAULT '[]',
  automation_triggers JSONB NOT NULL DEFAULT '[]',
  updated_by         TEXT NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp()
);

-- Inbound application error events
CREATE TABLE incident_response.application_error_event (
  tenant_id           TEXT NOT NULL,
  event_id            TEXT NOT NULL,
  application_id      TEXT NOT NULL,
  error_code          TEXT NOT NULL,
  error_message       TEXT NOT NULL,
  occurred_at         TIMESTAMPTZ NOT NULL,
  source_principal_id TEXT NOT NULL,
  principal_id        TEXT,
  operation           TEXT,
  session_context     TEXT,
  severity_hint       TEXT CHECK (severity_hint IN ('LOW','MEDIUM','HIGH','CRITICAL')),
  raw_payload         JSONB,
  status              TEXT NOT NULL DEFAULT 'received'
                          CHECK (status IN ('received','processing','processed','failed')),
  logical_action_id   TEXT NOT NULL,
  received_at         TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  PRIMARY KEY (tenant_id, event_id),
  UNIQUE (tenant_id, logical_action_id)
);
CREATE INDEX application_error_event_tenant_received
  ON incident_response.application_error_event (tenant_id, received_at DESC);

-- 1-minute-bucket deduplication (5-minute TTL)
CREATE TABLE incident_response.dedupe_entry (
  tenant_id      TEXT NOT NULL,
  application_id TEXT NOT NULL,
  error_code     TEXT NOT NULL,
  bucket_ts      TIMESTAMPTZ NOT NULL,
  event_id       TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, application_id, error_code, bucket_ts)
);
CREATE INDEX dedupe_entry_expires ON incident_response.dedupe_entry (expires_at);

-- Response action outbox (open_ticket / notify / automation)
CREATE TABLE incident_response.action_request (
  request_id      TEXT NOT NULL PRIMARY KEY,
  tenant_id       TEXT NOT NULL,
  event_id        TEXT NOT NULL,
  action_kind     TEXT NOT NULL CHECK (action_kind IN ('open_ticket','notify','automation')),
  status          TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','dispatching','linked','failed','skipped','unknown')),
  attempts        INTEGER NOT NULL DEFAULT 0,
  claimed_by      TEXT,
  claim_expires_at TIMESTAMPTZ,
  result_state    TEXT,
  provider_ref    TEXT,
  failure_class   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp(),
  FOREIGN KEY (tenant_id, event_id)
    REFERENCES incident_response.application_error_event (tenant_id, event_id)
);
CREATE INDEX action_request_pending
  ON incident_response.action_request (tenant_id, created_at)
  WHERE status = 'pending';

ALTER TABLE incident_response.policy
  OWNER TO jlmirror_g11_ir_executor;
ALTER TABLE incident_response.application_error_event
  OWNER TO jlmirror_g11_ir_executor;
ALTER TABLE incident_response.dedupe_entry
  OWNER TO jlmirror_g11_ir_executor;
ALTER TABLE incident_response.action_request
  OWNER TO jlmirror_g11_ir_executor;

-- ─── SECURITY DEFINER functions ───────────────────────────────────────────────

CREATE OR REPLACE FUNCTION incident_response.g11_get_policy(p_tenant TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_row RECORD;
BEGIN
  SELECT * INTO v_row FROM incident_response.policy WHERE tenant_id=p_tenant;
  IF NOT FOUND THEN
    RETURN jsonb_build_object(
      'tenant_id', p_tenant,
      'severity_threshold', 'HIGH',
      'auto_open_ticket', FALSE,
      'manual_override_only', FALSE,
      'notify_channels', '[]'::jsonb,
      'automation_triggers', '[]'::jsonb
    );
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_upsert_policy(
  p_tenant TEXT, p_severity_threshold TEXT, p_auto_open_ticket BOOLEAN,
  p_manual_override_only BOOLEAN, p_notify_channels JSONB,
  p_automation_triggers JSONB, p_actor TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_row RECORD;
BEGIN
  IF p_severity_threshold NOT IN ('LOW','MEDIUM','HIGH','CRITICAL') THEN
    RAISE EXCEPTION 'g11.policy_invalid_severity:%', p_severity_threshold;
  END IF;
  INSERT INTO incident_response.policy
    (tenant_id, severity_threshold, auto_open_ticket, manual_override_only,
     notify_channels, automation_triggers, updated_by, updated_at)
  VALUES
    (p_tenant, p_severity_threshold, p_auto_open_ticket, p_manual_override_only,
     p_notify_channels, p_automation_triggers, p_actor, transaction_timestamp())
  ON CONFLICT (tenant_id) DO UPDATE SET
    severity_threshold   = EXCLUDED.severity_threshold,
    auto_open_ticket     = EXCLUDED.auto_open_ticket,
    manual_override_only = EXCLUDED.manual_override_only,
    notify_channels      = EXCLUDED.notify_channels,
    automation_triggers  = EXCLUDED.automation_triggers,
    updated_by           = EXCLUDED.updated_by,
    updated_at           = EXCLUDED.updated_at;
  SELECT * INTO v_row FROM incident_response.policy WHERE tenant_id=p_tenant;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_claim_dedupe(
  p_tenant TEXT, p_app_id TEXT, p_error_code TEXT, p_bucket_ts TIMESTAMPTZ,
  p_event_id TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_found INTEGER;
BEGIN
  DELETE FROM incident_response.dedupe_entry WHERE expires_at < transaction_timestamp();
  INSERT INTO incident_response.dedupe_entry
    (tenant_id, application_id, error_code, bucket_ts, event_id, expires_at)
  VALUES
    (p_tenant, p_app_id, p_error_code, p_bucket_ts, p_event_id,
     transaction_timestamp() + INTERVAL '5 minutes')
  ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_found = ROW_COUNT;
  RETURN v_found > 0;
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_store_event(
  p_event_id TEXT, p_tenant TEXT, p_app_id TEXT, p_error_code TEXT,
  p_error_message TEXT, p_occurred_at TIMESTAMPTZ, p_source_principal TEXT,
  p_principal_id TEXT, p_operation TEXT, p_session_context TEXT,
  p_severity_hint TEXT, p_raw_payload JSONB, p_logical_action_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
BEGIN
  INSERT INTO incident_response.application_error_event
    (tenant_id, event_id, application_id, error_code, error_message,
     occurred_at, source_principal_id, principal_id, operation,
     session_context, severity_hint, raw_payload, logical_action_id)
  VALUES
    (p_tenant, p_event_id, p_app_id, p_error_code, p_error_message,
     p_occurred_at, p_source_principal, p_principal_id, p_operation,
     p_session_context, p_severity_hint, p_raw_payload, p_logical_action_id);
  RETURN jsonb_build_object('event_id', p_event_id, 'status', 'received');
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_enqueue_action(
  p_tenant TEXT, p_event_id TEXT, p_action_kind TEXT, p_request_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
BEGIN
  INSERT INTO incident_response.action_request
    (request_id, tenant_id, event_id, action_kind)
  VALUES (p_request_id, p_tenant, p_event_id, p_action_kind);
  RETURN jsonb_build_object(
    'request_id', p_request_id, 'action_kind', p_action_kind, 'status', 'pending');
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_list_events(p_tenant TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
BEGIN
  RETURN (
    SELECT COALESCE(jsonb_agg(to_jsonb(e) ORDER BY e.received_at DESC),'[]'::jsonb)
    FROM incident_response.application_error_event e
    WHERE e.tenant_id=p_tenant
  );
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_get_event(p_tenant TEXT, p_event_id TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_row RECORD;
BEGIN
  SELECT * INTO v_row
  FROM incident_response.application_error_event
  WHERE tenant_id=p_tenant AND event_id=p_event_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'g11.event_missing:%', p_event_id;
  END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_next_pending_action(p_tenant TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
DECLARE v_row RECORD;
BEGIN
  SELECT a.*, e.error_code, e.error_message, e.severity_hint,
         e.application_id, e.occurred_at
    INTO v_row
    FROM incident_response.action_request a
    JOIN incident_response.application_error_event e
      ON e.tenant_id=a.tenant_id AND e.event_id=a.event_id
   WHERE a.tenant_id=p_tenant AND a.status='pending'
   ORDER BY a.created_at
   LIMIT 1
   FOR UPDATE OF a SKIP LOCKED;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN to_jsonb(v_row);
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_claim_action(
  p_tenant TEXT, p_request_id TEXT, p_executor TEXT, p_claim_seconds INTEGER)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
BEGIN
  UPDATE incident_response.action_request SET
    status           = 'dispatching',
    claimed_by       = p_executor,
    claim_expires_at = transaction_timestamp() + (p_claim_seconds || ' seconds')::INTERVAL,
    attempts         = attempts + 1,
    updated_at       = transaction_timestamp()
  WHERE tenant_id=p_tenant AND request_id=p_request_id AND status='pending';
  RETURN jsonb_build_object('status','dispatching','request_id',p_request_id);
END;
$$;

CREATE OR REPLACE FUNCTION incident_response.g11_complete_action(
  p_tenant TEXT, p_request_id TEXT, p_executor TEXT,
  p_result_state TEXT, p_provider_ref TEXT, p_failure_class TEXT)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = incident_response, pg_temp
AS $$
BEGIN
  UPDATE incident_response.action_request SET
    status        = p_result_state,
    result_state  = p_result_state,
    provider_ref  = p_provider_ref,
    failure_class = p_failure_class,
    updated_at    = transaction_timestamp()
  WHERE tenant_id=p_tenant AND request_id=p_request_id;
  -- Mark event processed when all its actions are settled
  UPDATE incident_response.application_error_event SET
    status     = 'processed',
    updated_at = transaction_timestamp()  -- column added below if missing
  WHERE tenant_id=p_tenant
    AND event_id = (SELECT event_id FROM incident_response.action_request
                    WHERE request_id=p_request_id)
    AND NOT EXISTS (
      SELECT 1 FROM incident_response.action_request
       WHERE tenant_id=p_tenant
         AND event_id = (SELECT event_id FROM incident_response.action_request
                          WHERE request_id=p_request_id)
         AND status IN ('pending','dispatching')
    );
  RETURN jsonb_build_object('status',p_result_state,'request_id',p_request_id);
END;
$$;

-- Add updated_at to application_error_event (used by g11_complete_action)
ALTER TABLE incident_response.application_error_event
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT transaction_timestamp();

-- Grant EXECUTE on all SECURITY DEFINER functions to invoker roles
DO $$
DECLARE v_fn TEXT;
BEGIN
  FOR v_fn IN
    SELECT routine_schema||'.'||routine_name
    FROM information_schema.routines
    WHERE routine_schema='incident_response'
      AND routine_type='FUNCTION'
  LOOP
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO jlmirror_g11_ir_app_invoker,jlmirror_g11_ir_worker_invoker', v_fn);
    EXECUTE format('REVOKE EXECUTE ON FUNCTION %s FROM PUBLIC', v_fn);
  END LOOP;
END;
$$;

COMMIT;
