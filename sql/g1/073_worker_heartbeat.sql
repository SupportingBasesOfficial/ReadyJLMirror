-- G1 073 — worker heartbeat table
-- Workers UPSERT here after each successful tick.
-- Platform /health reads last_seen_at to detect stuck/dead workers.

CREATE TABLE IF NOT EXISTS g1.worker_heartbeat (
    worker_name     TEXT        PRIMARY KEY,
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_tick_items INTEGER     NOT NULL DEFAULT 0,
    started_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- jlmirror_worker writes heartbeats; jlmirror_app reads them
GRANT SELECT, INSERT, UPDATE ON g1.worker_heartbeat TO jlmirror_worker;
GRANT SELECT ON g1.worker_heartbeat TO jlmirror_app;
