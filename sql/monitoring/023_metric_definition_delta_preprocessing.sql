-- G-zbx: has_delta_preprocessing flag on metric_definition
-- Tracks whether Zabbix preprocessing steps 9 (Simple change) or 10 (Change
-- per second) are configured for this item. When true the value is a delta
-- (difference between consecutive Zabbix readings) and may be negative —
-- this is correct Zabbix behaviour, not a data error. The UI uses this flag
-- to show an explanatory tooltip on affected metric cards.

BEGIN;

ALTER TABLE monitoring.metric_definition
    ADD COLUMN IF NOT EXISTS has_delta_preprocessing BOOLEAN NOT NULL DEFAULT FALSE;

COMMIT;
