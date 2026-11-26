-- G-APM: adiciona trace_id (correlation_id propagado pelo BFF) ao request log.
-- Permite busca de todos os spans de uma requisição pelo ID de correlação.

ALTER TABLE g1.apm_request_log
    ADD COLUMN IF NOT EXISTS trace_id TEXT;

CREATE INDEX IF NOT EXISTS apm_request_log_trace_id
    ON g1.apm_request_log (trace_id)
    WHERE trace_id IS NOT NULL;

GRANT SELECT, INSERT ON g1.apm_request_log TO jlmirror_app;
