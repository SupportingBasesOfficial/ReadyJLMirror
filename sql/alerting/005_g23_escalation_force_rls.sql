-- Migration 005: adicionar FORCE ROW LEVEL SECURITY nas tabelas G23 de escalation.
--
-- Migration 004 ativou ENABLE RLS mas omitiu FORCE, o que permite que o owner
-- da tabela (jlmirror_owner) leia registros cross-tenant sem passar pela policy.
-- Todas as outras tabelas de alerting já usam ENABLE + FORCE (001, 002).
-- Idempotente — FORCE em tabela que já tem ENABLE não falha.

BEGIN;

ALTER TABLE alerting.escalation_policy FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.escalation_step   FORCE ROW LEVEL SECURITY;
ALTER TABLE alerting.alert_escalation  FORCE ROW LEVEL SECURITY;

COMMIT;
