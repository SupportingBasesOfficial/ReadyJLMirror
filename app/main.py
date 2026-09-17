"""FastAPI application entry point.

The application exposes:
- Health endpoints (liveness + readiness)
- API routers for all 5 domain packages
- OpenAPI docs at /docs

In development mode, the database pool is lazily initialized and the
app starts even if the DB is unavailable. In production, startup fails
if the DB is unreachable.
"""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI, status
from fastapi.responses import JSONResponse

from app.config import settings
from app.db import check_db_ready, close_pool, init_pool
from app.routers import authority, async_ops, monitoring, observability, release

logger = logging.getLogger(__name__)
logging.basicConfig(level=settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Application lifespan: init pool on startup, close on shutdown."""
    if settings.is_production:
        await init_pool()
        if not await check_db_ready():
            raise RuntimeError("database is not ready in production mode")
    else:
        # Development: try to init, but don't fail if DB is unavailable
        try:
            await init_pool()
        except Exception:
            logger.warning("Database pool initialization failed; running without DB")
    yield
    await close_pool()


app = FastAPI(
    title="ReadyJLMirror",
    description="Runnable JLMirror application stack",
    version="0.1.0",
    lifespan=lifespan,
)

# Register routers
app.include_router(authority.router)
app.include_router(monitoring.router)
app.include_router(async_ops.router)
app.include_router(observability.router)
app.include_router(release.router)


@app.get("/health", tags=["health"])
async def health_liveness() -> dict:
    """Liveness probe — always returns 200 if the process is alive."""
    return {"status": "ok", "environment": settings.environment}


@app.get("/health/ready", tags=["health"])
async def health_readiness() -> JSONResponse:
    """Readiness probe — checks database connectivity."""
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


@app.get("/", tags=["root"])
async def root() -> dict:
    """Service metadata."""
    return {
        "service": "ReadyJLMirror",
        "version": "0.1.0",
        "environment": settings.environment,
        "api_version": settings.api_version,
        "docs": "/docs",
    }


def run() -> None:
    """Run the application with uvicorn (entry point for the console script)."""
    import uvicorn

    uvicorn.run(
        "app.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.is_development,
    )
