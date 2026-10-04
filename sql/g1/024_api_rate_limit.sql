-- G27 API key rate limit table — cross-replica sliding window counter.
-- Each row tracks request counts for a (key_digest, minute-window) pair.
-- The UPSERT in api/main.py is the authoritative counter; old rows are
-- pruned lazily by the same query when accumulated count exceeds a threshold.

CREATE TABLE IF NOT EXISTS g1.api_rate_limit (
    key_digest   text    NOT NULL,
    window_min   bigint  NOT NULL,  -- unix epoch // 60
    req_count    integer NOT NULL DEFAULT 0,
    PRIMARY KEY (key_digest, window_min)
);

-- Index for cleanup query (delete WHERE window_min < current - 5)
CREATE INDEX IF NOT EXISTS api_rate_limit_window_idx
    ON g1.api_rate_limit (window_min);

GRANT SELECT, INSERT, UPDATE, DELETE
    ON g1.api_rate_limit TO jlmirror_app;
