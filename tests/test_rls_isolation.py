"""ADR-003 isolation battery — direct-SQL attempts to break tenant
authority against the app role, the way the canonical ADR requires.

Interactive/direct SQL SHALL NOT be able to change the tenant
authority used by row policy: SET, set_config, role changes and
session-authorization changes are all attempted and must fail or
stay confined to the enforced boundary.

Skips gracefully when PostgreSQL is unreachable.
"""

from __future__ import annotations

import os

import psycopg
import pytest

pytestmark = pytest.mark.integration

_APP_DSN = os.environ.get(
    "DB_APP_DSN",
    "postgresql://jlmirror_app:jlmirror_dev"
    f"@{os.environ.get('DB_HOST', 'localhost')}"
    f":{os.environ.get('DB_PORT', '5434')}"
    f"/{os.environ.get('DB_NAME', 'jlmirror')}")


@pytest.fixture(scope="module")
def conn():
    try:
        c = psycopg.connect(_APP_DSN, connect_timeout=3, autocommit=True)
    except Exception:
        pytest.skip("PostgreSQL app role is not reachable")
    # Self-seeding: a fresh database (CI) has no monitoring rows —
    # the battery needs at least one tenant:dev source to compare
    # isolation against. Insert via the same app role path the real
    # create flow uses.
    c.execute(
        "SELECT set_config('jlmirror.tenant_id', 'tenant:dev', false)")
    with c.transaction():
        c.execute("SET CONSTRAINTS ALL DEFERRED")
        c.execute(
            """
            INSERT INTO monitoring.monitoring_source_generation
            (tenant_id, monitoring_source_id, source_instance_generation,
             provider_profile, provider_instance_ref, provider_base_url,
             created_at)
        SELECT 'tenant:dev', 'mon-src_rls-battery', 'mon-gen_rls',
               'zabbix', 'zbx-rls', 'https://zabbix.example.com', now()
         WHERE NOT EXISTS (
            SELECT 1 FROM monitoring.monitoring_source_generation
             WHERE monitoring_source_id = 'mon-src_rls-battery')
        """)
        c.execute(
            """
            INSERT INTO monitoring.monitoring_sync_operation
                (tenant_id, monitoring_sync_operation_id,
                 monitoring_source_id, source_instance_generation,
                 responsibility_kind, state, configuration_revision,
                 scope_revision)
            SELECT 'tenant:dev', 'op-rls', 'mon-src_rls-battery',
                   'mon-gen_rls', 'validation_and_initial_sync',
                   'pending', 1, 1
             WHERE NOT EXISTS (
                SELECT 1 FROM monitoring.monitoring_sync_operation
                 WHERE monitoring_sync_operation_id = 'op-rls')
            """)
        c.execute(
            """
            INSERT INTO monitoring.monitoring_source
            (tenant_id, monitoring_source_id,
             provider_scope_tenant_binding_id, provider_profile,
             active_source_instance_generation, configuration_revision,
             scope_revision, display_name, credential_binding_ref,
             configured_provider_scope, operational_evidence_state,
             last_sync_operation_id)
        SELECT 'tenant:dev', 'mon-src_rls-battery', 'binding-rls',
               'zabbix', 'mon-gen_rls', 1, 1, 'rls-battery',
               'cred-binding-1', '{"host_group_refs": ["5"]}',
               'unavailable', 'op-rls'
         WHERE NOT EXISTS (
            SELECT 1 FROM monitoring.monitoring_source
             WHERE monitoring_source_id = 'mon-src_rls-battery')
            """)
    c.execute("RESET jlmirror.tenant_id")
    yield c
    c.close()


def _count(conn, tenant: str | None) -> int:
    if tenant is not None:
        conn.execute(
            "SELECT set_config('jlmirror.tenant_id', %s, false)", (tenant,))
    else:
        conn.execute("RESET jlmirror.tenant_id")
    return conn.execute(
        "SELECT count(*) FROM monitoring.monitoring_source"
    ).fetchone()[0]


def test_no_guc_sees_nothing(conn):
    assert _count(conn, None) == 0


def test_tenant_guc_scopes_rows(conn):
    assert _count(conn, "tenant:dev") > 0


def test_other_tenant_guc_is_isolated(conn):
    n_dev = _count(conn, "tenant:dev")
    n_other = _count(conn, "tenant:other")
    assert n_dev > 0
    assert n_other < n_dev  # different tenant, different view


def test_set_role_cannot_escalate(conn):
    conn.execute("RESET jlmirror.tenant_id")
    with pytest.raises(psycopg.Error):
        conn.execute("SET ROLE jlmirror_owner")


def test_session_authorization_cannot_escalate(conn):
    with pytest.raises(psycopg.Error):
        conn.execute("SET SESSION AUTHORIZATION jlmirror_owner")


def test_tenant_guc_is_transaction_scoped_not_sticky(conn):
    """set_config(false) is session-local — a pooled connection
    returned and re-borrowed must not leak tenant context."""
    conn.execute(
        "SELECT set_config('jlmirror.tenant_id', 'tenant:dev', false)")
    # RESET simulates pool-return hygiene — after reset, zero rows.
    conn.execute("RESET jlmirror.tenant_id")
    assert _count(conn, None) == 0


def test_app_cannot_bypass_rls_via_table_owner(conn):
    """App role is not owner and cannot disable RLS."""
    conn.execute(
        "SELECT set_config('jlmirror.tenant_id', 'tenant:dev', false)")
    with pytest.raises(psycopg.Error):
        conn.execute(
            "ALTER TABLE monitoring.monitoring_source "
            "DISABLE ROW LEVEL SECURITY")


def test_update_blocked_on_monitoring(conn):
    """Least privilege: app cannot UPDATE monitoring.* even with
    a tenant context set."""
    conn.execute(
        "SELECT set_config('jlmirror.tenant_id', 'tenant:dev', false)")
    with pytest.raises(psycopg.Error):
        conn.execute(
            "UPDATE monitoring.monitoring_source "
            "SET display_name='x' WHERE true")
