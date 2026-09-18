-- Dev Zabbix provider profile: the real Zabbix server keeps its own
-- database (separate from jlmirror). Created at bootstrap so the
-- `zabbix` compose profile works on a fresh clone.
SELECT 'CREATE DATABASE zabbix OWNER jlmirror_owner'
 WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'zabbix')\gexec
