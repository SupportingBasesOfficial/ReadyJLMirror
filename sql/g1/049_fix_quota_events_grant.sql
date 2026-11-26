-- 049: corrigir grant em g1.quota_events para incluir jlmirror_app.
-- A migration 045 concedeu acesso apenas ao jlmirror_owner;
-- o app usa jlmirror_app e falhava silenciosamente ao inserir eventos.
-- Idempotente — GRANT não falha se já existir.

GRANT SELECT, INSERT, UPDATE ON g1.quota_events TO jlmirror_app;
