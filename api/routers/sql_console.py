import asyncio
import re
import time
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from shared.auth import _require_operate
from shared.db import db_connection
from shared.audit import record_audit_event

router = APIRouter(prefix="/sql-console", tags=["sql-console"])

_MAX_ROWS = 500
_TIMEOUT_SECONDS = 10

# Patterns that are never allowed regardless of phrasing.
_DENY_PATTERNS = re.compile(
    r"^\s*(insert|update|delete|drop|truncate|alter|create|grant|revoke"
    r"|copy|vacuum|analyze|cluster|reindex|comment|notify|listen|unlisten"
    r"|set\s+role|set\s+session|set\s+local|execute|call|do)\b",
    re.IGNORECASE,
)


def _validate_query(sql: str) -> None:
    """Raise 400 if the SQL is not a plain SELECT / WITH...SELECT."""
    stripped = sql.strip().rstrip(";")
    if _DENY_PATTERNS.match(stripped):
        raise HTTPException(400, "Apenas consultas SELECT são permitidas")
    # Must start with SELECT or WITH (for CTEs that resolve to SELECT)
    if not re.match(r"^\s*(select|with)\b", stripped, re.IGNORECASE):
        raise HTTPException(400, "A consulta deve começar com SELECT ou WITH")


def _inject_limit(sql: str) -> str:
    """Append LIMIT if the query has none, to cap result size."""
    stripped = sql.strip().rstrip(";")
    if not re.search(r"\blimit\b", stripped, re.IGNORECASE):
        return f"{stripped}\nLIMIT {_MAX_ROWS}"
    return stripped


class ExecuteRequest(BaseModel):
    query: str


# ── Execute ───────────────────────────────────────────────────────────────────

@router.post("/execute")
async def execute_query(request: Request, body: ExecuteRequest):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    actor = ctx["user_id"]

    query = body.query.strip()
    if not query:
        raise HTTPException(400, "query vazia")

    _validate_query(query)
    safe_query = _inject_limit(query)

    t0 = time.monotonic()
    status = "completed"
    error_message: Optional[str] = None
    rows: list = []
    columns: list = []

    try:
        async with db_connection() as conn:
            # Read-only transaction + statement timeout
            await conn.execute(f"SET LOCAL statement_timeout = '{_TIMEOUT_SECONDS * 1000}'")
            await conn.execute("SET LOCAL TRANSACTION READ ONLY")

            result = await asyncio.wait_for(
                conn.fetch(safe_query),
                timeout=_TIMEOUT_SECONDS + 1,
            )

            if result:
                columns = list(result[0].keys())
                rows = [list(r.values()) for r in result]

    except asyncio.TimeoutError:
        status = "failed"
        error_message = f"Timeout: consulta excedeu {_TIMEOUT_SECONDS}s"
    except Exception as exc:
        status = "failed"
        error_message = str(exc)

    duration_ms = int((time.monotonic() - t0) * 1000)
    row_count = len(rows) if status == "completed" else None

    async with db_connection() as conn:
        hist = await conn.fetchrow(
            """
            INSERT INTO g1.sql_console_history
                (tenant_id, query_text, status, duration_ms, row_count,
                 error_message, executed_by)
            VALUES ($1,$2,$3,$4,$5,$6,$7)
            RETURNING id, executed_at
            """,
            tid, query, status, duration_ms, row_count, error_message, actor,
        )
        await record_audit_event(conn, tid, actor, "sql_console.execute", hist["id"],
                                 {"status": status, "duration_ms": duration_ms})

    return {
        "id": str(hist["id"]),
        "executed_at": hist["executed_at"].isoformat(),
        "status": status,
        "duration_ms": duration_ms,
        "row_count": row_count,
        "error_message": error_message,
        "columns": columns,
        "rows": rows,
    }


# ── History ───────────────────────────────────────────────────────────────────

@router.get("/history")
async def list_history(request: Request, limit: int = 50):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT h.id, h.query_text, h.status, h.duration_ms, h.row_count,
                   h.error_message, h.executed_at, u.full_name AS executed_by_name
            FROM g1.sql_console_history h
            LEFT JOIN g1.user_account u ON u.id = h.executed_by
            WHERE h.tenant_id = $1
            ORDER BY h.executed_at DESC
            LIMIT $2
            """,
            tid, limit,
        )
    return [dict(r) for r in rows]


@router.delete("/history/{history_id}", status_code=204)
async def delete_history(request: Request, history_id: UUID):
    ctx = _require_operate(request)
    tid = ctx["tenant_id"]
    async with db_connection() as conn:
        result = await conn.execute(
            "DELETE FROM g1.sql_console_history WHERE id=$1 AND tenant_id=$2",
            history_id, tid,
        )
    if result == "DELETE 0":
        raise HTTPException(404, "histórico não encontrado")


# ── Schema inspection ─────────────────────────────────────────────────────────

@router.get("/tables")
async def list_tables(request: Request, schema: str = "g1"):
    _require_operate(request)
    if not re.match(r"^[a-z_][a-z0-9_]*$", schema):
        raise HTTPException(400, "schema inválido")
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT table_name, table_type
            FROM information_schema.tables
            WHERE table_schema = $1
            ORDER BY table_name
            """,
            schema,
        )
    return [dict(r) for r in rows]


@router.get("/tables/{schema}/{table}/columns")
async def list_columns(request: Request, schema: str, table: str):
    _require_operate(request)
    if not re.match(r"^[a-z_][a-z0-9_]*$", schema):
        raise HTTPException(400, "schema inválido")
    if not re.match(r"^[a-z_][a-z0-9_]*$", table):
        raise HTTPException(400, "table inválida")
    async with db_connection() as conn:
        rows = await conn.fetch(
            """
            SELECT column_name, data_type, is_nullable, column_default
            FROM information_schema.columns
            WHERE table_schema = $1 AND table_name = $2
            ORDER BY ordinal_position
            """,
            schema, table,
        )
    return [dict(r) for r in rows]
