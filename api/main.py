"""Internal API service.

Receives traffic only through the BFF, which attaches signed authority
context headers. The API verifies the HMAC signature and timestamp
freshness, then re-checks durable session/tenant currentness against
PostgreSQL before serving protected reads.

Trust model (development): shared-secret HMAC between BFF and API.
Production: workload identity (SPIFFE/SPIRE) per D3 candidates — this
module is the single seam to replace.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from shared.config import settings
from shared.db import check_db_ready, close_pool, db_connection, init_pool
from api.routers import authority, async_ops, monitoring, observability, release

logger = logging.getLogger(__name__)
logging.basicConfig(level=settings.log_level)

_CONTEXT_MAX_SKEW_SECONDS = 60


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    if settings.is_production:
        await init_pool()
        if not await check_db_ready():
            raise RuntimeError("database is not ready in production mode")
    else:
        try:
            await init_pool()
        except Exception:
            logger.warning("API: database pool init failed; running without DB")
    yield
    await close_pool()


app = FastAPI(title="ReadyJLMirror API", version="0.1.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Trusted-BFF context verification
# ---------------------------------------------------------------------------


def _expected_signature(principal_id: str, tenant_id: str,
                        session_digest: str, ts: str) -> str:
    payload = f"{principal_id}|{tenant_id}|{session_digest}|{ts}"
    return hmac.new(
        settings.bff_internal_secret.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()


def _verify_bff_context(request: Request) -> Optional[dict]:
    """Verify signed BFF context headers. Returns context or None."""
    principal_id = request.headers.get("X-JLMirror-Principal-Id")
    session_digest = request.headers.get("X-JLMirror-Session-Digest")
    session_generation = request.headers.get("X-JLMirror-Session-Generation")
    tenant_id = request.headers.get("X-JLMirror-Tenant-Id", "")
    ts = request.headers.get("X-JLMirror-Context-Ts")
    sig = request.headers.get("X-JLMirror-Context-Sig")

    if not all([principal_id, session_digest, session_generation, ts, sig]):
        return None
    try:
        if abs(time.time() - int(ts)) > _CONTEXT_MAX_SKEW_SECONDS:
            return None
    except ValueError:
        return None
    expected = _expected_signature(principal_id, tenant_id, session_digest, ts)
    if not hmac.compare_digest(expected, sig):
        return None
    return {
        "principal_id": principal_id,
        "session_digest": session_digest,
        "session_generation": session_generation,
        "tenant_id": tenant_id or None,
    }


async def _session_current(ctx: dict) -> bool:
    """Re-check durable session currentness — signed headers alone are
    never sufficient authority for protected reads."""
    try:
        async with db_connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute(
                    """
                    SELECT 1 FROM g1.browser_sessions s
                    JOIN g1.principals p USING (principal_id)
                     WHERE s.handle_digest = %s
                       AND s.session_generation = %s
                       AND s.principal_id = %s
                       AND s.retired = FALSE
                       AND s.expires_at > now()
                       AND p.active = TRUE
                    """,
                    (ctx["session_digest"], ctx["session_generation"],
                     ctx["principal_id"]),
                )
                return await cur.fetchone() is not None
    except RuntimeError:
        return False  # DB unavailable — fail closed


@app.middleware("http")
async def verify_context(request: Request, call_next):
    """Enforce signed+current context on all /api/v1/ routes.

    Unprotected: /health, /docs, /openapi.json and the dev sandbox
    routers (kept for local exploration only).
    """
    path = request.url.path
    if not path.startswith("/api/v1/"):
        return await call_next(request)

    # Dev sandbox routes stay open for local exploration in development
    sandbox_prefixes = (
        "/api/v1/auth/", "/api/v1/fence/", "/api/v1/monitoring/",
        "/api/v1/async/", "/api/v1/observability/", "/api/v1/release/",
    )
    if settings.is_development and path.startswith(sandbox_prefixes):
        return await call_next(request)

    ctx = _verify_bff_context(request)
    if ctx is None:
        return JSONResponse({"state": "unauthenticated"},
                            status_code=status.HTTP_401_UNAUTHORIZED)
    if not await _session_current(ctx):
        return JSONResponse({"state": "forbidden"},
                            status_code=status.HTTP_403_FORBIDDEN)

    request.state.jlmirror_context = ctx
    return await call_next(request)


# ---------------------------------------------------------------------------
# G1 protected endpoints
# ---------------------------------------------------------------------------


@app.get("/api/v1/me", tags=["g1"])
async def whoami(request: Request) -> dict:
    """Current authenticated principal + bound tenant context."""
    ctx = request.state.jlmirror_context
    return {
        "principal_id": ctx["principal_id"],
        "tenant_id": ctx["tenant_id"],
        "environment": settings.environment,
    }


# ---------------------------------------------------------------------------
# Routers (dev sandbox — domain package exposure)
# ---------------------------------------------------------------------------

app.include_router(authority.router)
app.include_router(monitoring.router)
app.include_router(async_ops.router)
app.include_router(observability.router)
app.include_router(release.router)


@app.get("/health", tags=["health"])
async def health_liveness() -> dict:
    return {"status": "ok", "environment": settings.environment}


@app.get("/", tags=["root"])
async def root() -> dict:
    """Service metadata."""
    return {
        "service": "ReadyJLMirror",
        "version": "0.1.0",
        "environment": settings.environment,
        "api_version": settings.api_version,
    }


@app.get("/health/ready", tags=["health"])
async def health_readiness() -> JSONResponse:
    db_ready = await check_db_ready()
    status_code = status.HTTP_200_OK if db_ready else status.HTTP_503_SERVICE_UNAVAILABLE
    return JSONResponse(
        status_code=status_code,
        content={
            "status": "ready" if db_ready else "not_ready",
            "database": db_ready,
            "environment": settings.environment,
        },
    )


def run() -> None:
    import uvicorn

    uvicorn.run(
        "api.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.is_development,
    )
