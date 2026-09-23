-- Resource host-group membership: the inventory snapshot already
-- carries each host's Zabbix groups (ref + name) but the canonical
-- resource dropped them, so nothing could slice by group. Persist the
-- membership as snapshot-authoritative JSON on the resource — each
-- completed inventory replaces it wholesale, matching presence/scope
-- semantics. Shape: [{"ref": "19", "name": "JL/Servers"}, ...].

ALTER TABLE monitoring.monitoring_resource
    ADD COLUMN IF NOT EXISTS host_groups jsonb NOT NULL DEFAULT '[]'::jsonb;
