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
import json
import logging
import os
import re
import time
from contextlib import asynccontextmanager
from typing import AsyncIterator, Optional

from fastapi import FastAPI, Request, status
from fastapi.responses import JSONResponse

from shared import access, slo as _slo
from shared.config import settings
from shared.db import check_db_ready, close_pool, db_connection, init_pool
from shared import telemetry
from api.routers import (
    alerting,
    authority,
    async_ops,
    human_ops,
    monitoring,
    notifications,
    observability,
    platform,
    release,
    tenant,
)

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
                        session_digest: str, ts: str,
                        correlation_id: str = "") -> str:
    payload = (f"{principal_id}|{tenant_id}|{session_digest}"
               f"|{ts}|{correlation_id}")
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
    correlation_id = request.headers.get("X-JLMirror-Correlation-Id", "")
    sig = request.headers.get("X-JLMirror-Context-Sig")

    if not all([principal_id, session_digest, session_generation, ts, sig]):
        return None
    try:
        if abs(time.time() - int(ts)) > _CONTEXT_MAX_SKEW_SECONDS:
            return None
    except ValueError:
        return None
    expected = _expected_signature(
        principal_id, tenant_id, session_digest, ts, correlation_id)
    if not hmac.compare_digest(expected, sig):
        return None
    return {
        "principal_id": principal_id,
        "session_digest": session_digest,
        "session_generation": session_generation,
        "tenant_id": tenant_id or None,
        "correlation_id": correlation_id or None,
    }


async def _display_token_context(request: Request) -> dict | None:
    """Resolve an X-Display-Token into a minimal authority context.

    The device token is the credential binding (§9); currentness is
    the token's own state (unretired, unexpired) plus the principal
    being active — no browser session is involved.
    """
    token = request.headers.get("X-Display-Token")
    if not token:
        return None
    digest = hashlib.sha256(token.encode()).hexdigest()
    try:
        async with db_connection() as conn:
            cur = await conn.execute(
                """
                SELECT t.principal_id, t.tenant_id
                  FROM g1.display_tokens t
                  JOIN g1.principals p USING (principal_id)
                 WHERE t.token_digest = %s
                   AND t.retired = FALSE
                   AND (t.expires_at IS NULL OR t.expires_at > now())
                   AND p.active = TRUE
                """, (digest,))
            row = await cur.fetchone()
    except RuntimeError:
        return None
    if row is None:
        return None
    return {"principal_id": row[0], "tenant_id": row[1],
            "session_digest": "", "session_generation": "",
            "correlation_id": telemetry.extract_correlation_id(
                request.headers), "display": True}


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


# Path-prefix -> permission domain. GET/HEAD = read, anything else =
# operate. Route-level vocabulary lives in shared/access.py.
_SOURCE_PATH = re.compile(r"/api/v1/monitoring/sources/([^/]+)")
_DOMAIN_PREFIXES = (
    ("/api/v1/monitoring/", "monitoring"),
    ("/api/v1/alerting/", "alerting"),
    ("/api/v1/observability/", "observability"),
)


def _required_permission(path: str, method: str) -> str | None:
    for prefix, domain in _DOMAIN_PREFIXES:
        if path.startswith(prefix):
            verb = "read" if method in ("GET", "HEAD", "OPTIONS") else "operate"
            return f"{domain}:{verb}"
    if path.startswith("/api/v1/tenant/"):
        return ("tenant:read" if method in ("GET", "HEAD", "OPTIONS")
                else "tenant:admin")
    return None


@app.middleware("http")
async def verify_context(request: Request, call_next):
    """Enforce signed+current context on all /api/v1/ routes.

    Unprotected: /health, /docs, /openapi.json and the dev sandbox
    routers (kept for local exploration only).
    """
    path = request.url.path
    if not path.startswith("/api/v1/"):
        return await call_next(request)

    # G9 provider callback boundary — external callers have no
    # session; authenticity is HMAC-verified inside the endpoint.
    # It can never gain alert/ack/responsibility mutation authority.
    if path == "/api/v1/alerting/notifications/callback":
        return await call_next(request)

    # Dev sandbox routes stay open for local exploration in development
    sandbox_prefixes = (
        "/api/v1/auth/", "/api/v1/fence/", "/api/v1/monitoring/",
        "/api/v1/async/", "/api/v1/observability/", "/api/v1/release/",
    )
    ctx = _verify_bff_context(request)
    display_ctx = False
    if ctx is None:
        # Display/TV principals authenticate via a device token —
        # independently attributable, read-only, revocable (§9).
        ctx = await _display_token_context(request)
        display_ctx = ctx is not None

    # Dev sandbox is open only to ANONYMOUS local exploration — a
    # presented credential (signed ctx or display token) always gets
    # gated, never upgraded to sandbox trust.
    if (settings.is_development
            and path.startswith(sandbox_prefixes)
            and ctx is None):
        return await call_next(request)

    if ctx is None:
        return JSONResponse({"state": "unauthenticated"},
                            status_code=status.HTTP_401_UNAUTHORIZED)
    if not display_ctx and not await _session_current(ctx):
        return JSONResponse({"state": "forbidden"},
                            status_code=status.HTTP_403_FORBIDDEN)

    # Deny-by-default permission gate (canonical access model):
    # domain/method -> required permission; effective authority =
    # membership role ∪ delegated grants ∪ platform capability.
    required = _required_permission(path, request.method)
    if required and ctx.get("tenant_id"):
        async with db_connection() as conn:
            perms = await access.effective_permissions(
                conn, ctx["principal_id"], ctx["tenant_id"])
            # Resource-scope refinement: delegated grants may
            # restrict authority to named monitoring sources.
            source_match = _SOURCE_PATH.search(path)
            if source_match:
                allowed = await access.allowed_source_ids(
                    conn, ctx["principal_id"], ctx["tenant_id"])
                if allowed is not None and \
                        source_match.group(1) not in allowed:
                    return JSONResponse({"state": "forbidden"},
                                        status_code=status.HTTP_403_FORBIDDEN)
        if required not in perms:
            return JSONResponse({"state": "forbidden"},
                                status_code=status.HTTP_403_FORBIDDEN)

    request.state.jlmirror_context = ctx
    with telemetry.bind(
            correlation_id=ctx.get("correlation_id")
            or telemetry.new_correlation_id(),
            tenant_id=ctx.get("tenant_id"),
            principal_id=ctx.get("principal_id")):
        response = await call_next(request)
    response.headers["X-Correlation-Id"] = (
        telemetry.current_correlation_id() or "")
    return response


# ---------------------------------------------------------------------------
# G1 protected endpoints
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# Dev webhook sink — real HTTP delivery target for the outbox
# dispatcher (proves the wire path end-to-end; production = broker).
# Internal-only route, dev-gated.
# ---------------------------------------------------------------------------


@app.post("/dev/outbox-sink", tags=["dev"])
async def dev_outbox_sink(request: Request) -> dict:
    if not settings.is_development:
        return JSONResponse({"state": "forbidden"}, status_code=403)
    envelope = await request.json()
    async with db_connection() as conn:
        await conn.execute(
            """
            INSERT INTO g1.webhook_delivery
                (message_id, contract_name, correlation_id, envelope)
            VALUES (%s, %s, %s, %s::jsonb)
            """,
            (envelope.get("message_id", ""),
             envelope.get("contract_name", ""),
             envelope.get("correlation_id", ""),
             json.dumps(envelope)))
    return {"received": True, "message_id": envelope.get("message_id")}


@app.get("/dev/outbox-sink", tags=["dev"])
async def dev_outbox_sink_list(limit: int = 50) -> list:
    if not settings.is_development:
        return JSONResponse({"state": "forbidden"}, status_code=403)
    async with db_connection() as conn:
        cur = await conn.execute(
            """
            SELECT delivery_id, received_at, message_id, contract_name,
                   correlation_id
              FROM g1.webhook_delivery
             ORDER BY delivery_id DESC LIMIT %s
            """, (min(limit, 200),))
        rows = await cur.fetchall()
    return [{"delivery_id": r[0], "received_at": r[1].isoformat(),
             "message_id": r[2], "contract_name": r[3],
             "correlation_id": r[4]} for r in rows]


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

app.add_middleware(_slo.SloMiddleware)

app.include_router(authority.router)
app.include_router(monitoring.router)
app.include_router(async_ops.router)
app.include_router(observability.router)
app.include_router(release.router)
app.include_router(alerting.router)
app.include_router(human_ops.router)
app.include_router(notifications.router)
app.include_router(platform.router)
app.include_router(tenant.router)


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
    """Readiness with declared failure modes (ADR-017).

    - database: authoritative -> fail closed (not_ready / 503)
    - worker pipeline: stale heartbeat -> degraded (200) — the API
      still serves reads; fresh monitoring data is what lags.
    """
    deps: dict = {}
    degraded = False

    db_ready = await check_db_ready()
    deps["database"] = {
        "state": "ok" if db_ready else "unavailable",
        "mode": "fail_closed"}
    if not db_ready:
        return JSONResponse(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            content={"status": "not_ready", "dependencies": deps,
                     "environment": settings.environment})

    worker_dep = {"state": "ok", "mode": "degraded"}
    try:
        async with db_connection() as conn:
            cur = await conn.execute(
                "SELECT worker_id, seconds_stale, alive"
                " FROM monitoring.worker_alive(%s)",
                (settings.worker_poll_interval_seconds * 4,))
            rows = await cur.fetchall()
        if not rows or not all(r[2] for r in rows):
            worker_dep["state"] = "stale"
            degraded = True
        else:
            worker_dep["seconds_stale"] = max(r[1] for r in rows)
    except Exception:
        worker_dep["state"] = "unknown"
        degraded = True
    deps["workers"] = worker_dep

    return JSONResponse(
        status_code=status.HTTP_200_OK,
        content={
            "status": "degraded" if degraded else "ready",
            "dependencies": deps,
            "environment": settings.environment,
        },
    )


def _mtls_kwargs() -> dict:
    """mTLS on the internal API boundary — opt-in via env.

    API_MTLS=1 + cert paths: the API requires and verifies a client
    certificate against the CA — service identity, not just an
    encrypted channel. No client cert -> TLS handshake fails.
    """
    if os.environ.get("API_MTLS", "").strip().lower() not in (
            "1", "true", "yes"):
        return {}
    cert = os.environ.get("API_TLS_CERT_FILE")
    key = os.environ.get("API_TLS_KEY_FILE")
    ca = os.environ.get("API_CA_FILE")
    if not (cert and key and ca):
        raise RuntimeError(
            "API_MTLS=1 requires API_TLS_CERT_FILE, API_TLS_KEY_FILE "
            "and API_CA_FILE")
    return {
        "ssl_certfile": cert,
        "ssl_keyfile": key,
        "ssl_ca_certs": ca,
        "ssl_cert_reqs": 2,  # ssl.CERT_REQUIRED
    }


def run() -> None:
    import uvicorn

    telemetry.configure_structured_logging(settings.log_level)
    uvicorn.run(
        "api.main:app",
        host=settings.api_host,
        port=settings.api_port,
        reload=settings.is_development,
        **_mtls_kwargs(),
    )


if __name__ == "__main__":
    run()
