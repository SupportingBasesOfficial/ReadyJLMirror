-- History item pagination: claim_metric_history derives its target set
-- from all active in-scope definitions, but the domain bounds a single
-- op to 512 targets. Real sources carry thousands of items, so the op
-- needs a deterministic continuation cursor. claim selects
-- provider_external_ref > history_item_cursor (bounded page); on
-- successful completion the repository enqueues the next op carrying
-- the max processed ref as its cursor, chaining until the window's
-- item space is exhausted. Lexical ordering on provider_external_ref
-- makes pages stable and resumable within a window.

ALTER TABLE monitoring.monitoring_sync_operation
    ADD COLUMN IF NOT EXISTS history_item_cursor text NOT NULL DEFAULT '';
