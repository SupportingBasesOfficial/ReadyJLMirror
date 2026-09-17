"""Database connection pool and tenant context helpers.

The pool is lazily initialized on first use. In development mode the
application starts even if the database is unavailable (endpoints that
need the DB will return 503). In production, startup fails if the DB
is unreachable.

Tenant context for RLS is set per-transaction via `set_tenant_context`.

On Windows, psycopg's async pool requires the selector event loop
policy. This is set automatically at import time.
"""

from __future__ import annotations

import asyncio
import logging
import sys
from contextlib import asynccontextmanager
from typing import AsyncIterator

from psycopg import AsyncConnection, AsyncCursor
from psycopg_pool import AsyncConnectionPool

from shared.config import settings

# Fix psycopg async compatibility on Windows
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())

logger = logging.getLogger(__name__)

_pool: AsyncConnectionPool | None = None


async def init_pool() -> AsyncConnectionPool:
    """Initialize the connection pool. Safe to call once at startup."""
    global _pool
    if _pool is not None:
        return _pool
    _pool = AsyncConnectionPool(
        conninfo=settings.db_dsn,
        min_size=settings.db_pool_min,
        max_size=settings.db_pool_max,
        open=False,
    )
    await _pool.open(wait=True)
    logger.info("Database pool initialized: %s:%s/%s", settings.db_host, settings.db_port, settings.db_name)
    return _pool


async def close_pool() -> None:
    """Close the connection pool. Safe to call at shutdown."""
    global _pool
    if _pool is not None:
        await _pool.close()
        _pool = None
        logger.info("Database pool closed")


def get_pool() -> AsyncConnectionPool | None:
    """Return the current pool (or None if not initialized)."""
    return _pool


async def check_db_ready() -> bool:
    """Return True if the database accepts connections."""
    pool = get_pool()
    if pool is None:
        return False
    try:
        async with pool.connection() as conn:
            await conn.execute("SELECT 1")
        return True
    except Exception:
        logger.warning("Database readiness check failed", exc_info=True)
        return False


async def set_tenant_context(cursor: AsyncCursor, tenant_id: str) -> None:
    """Set the tenant context for RLS on the current transaction.

    Must be called inside a transaction before any tenant-scoped query —
    monitoring.* tables are FORCE RLS for the app role.
    """
    await cursor.execute(
        "SELECT set_config('jlmirror.tenant_id', %s, true)", (tenant_id,)
    )


@asynccontextmanager
async def db_tenant_connection(tenant_id: str) -> AsyncIterator[AsyncConnection]:
    """Yield a pooled connection with the tenant GUC set session-wide.

    The app role is FORCE RLS on monitoring.* tables, so every
    tenant-scoped statement must run under `jlmirror.tenant_id`. The GUC
    is set at session level (survives the internal commits that repo
    helpers perform) and reset before the connection returns to the
    pool so no tenant leaks across requests.
    """
    pool = get_pool()
    if pool is None:
        raise RuntimeError("Database pool is not initialized")
    async with pool.connection() as conn:
        await conn.execute(
            "SELECT set_config('jlmirror.tenant_id', %s, false)",
            (tenant_id,),
        )
        try:
            yield conn
        finally:
            try:
                await conn.execute(
                    "SELECT set_config('jlmirror.tenant_id', '', false)")
            except Exception:
                pass


@asynccontextmanager
async def db_connection() -> AsyncIterator[AsyncConnection]:
    """Yield a connection from the pool. Raises if the pool is not initialized."""
    pool = get_pool()
    if pool is None:
        raise RuntimeError("Database pool is not initialized")
    async with pool.connection() as conn:
        yield conn
