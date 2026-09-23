"""BFF service — G1 identity + tenant + protected shell.

Implements the accepted IR-D-001/G1 shape:
  - Confidential BFF: OIDC Authorization Code + PKCE S256 server-side
  - Browser receives only an opaque session handle (HttpOnly cookie)
  - No access/refresh token reaches browser JS
  - CSRF double-submit bound to the session
  - Tenant binding requires current active membership (no existence leakage)
  - Session resolution is durable (PostgreSQL), never cache-authoritative
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import os
import secrets
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import AsyncIterator, Optional

import httpx
from fastapi import FastAPI, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

from shared.config import settings
from shared.db import (
    close_pool, db_connection, db_tenant_connection, init_pool)
from shared import access, telemetry
from shared.audit import record_audit_event
from bff import oidc
from bff.identity import (
    check_membership,
    resolve_or_provision_principal,
)
from bff.sessions import PgSessionStore, digest_handle, digest_token

logger = logging.getLogger(__name__)
logging.basicConfig(level=settings.log_level)

SESSION_COOKIE = "jl_session"
CSRF_COOKIE = "jl_csrf"
CSRF_HEADER = "x-csrf-token"
SHELL_DIR = Path(__file__).resolve().parent / "shell"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    try:
        await init_pool()
    except Exception:
        logger.warning("BFF: database pool init failed; auth endpoints will 503")
    yield
    await close_pool()


app = FastAPI(title="ReadyJLMirror BFF", version="0.1.0", lifespan=lifespan)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _utcnow() -> datetime:
    return datetime.now(timezone.utc)


def _session_cookie(request: Request) -> Optional[str]:
    return request.cookies.get(SESSION_COOKIE)


def _set_session_cookie(response: Response, handle: str) -> None:
    response.set_cookie(
        SESSION_COOKIE,
        handle,
        max_age=settings.session_lifetime_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def _set_csrf_cookie(response: Response, csrf: str) -> None:
    response.set_cookie(
        CSRF_COOKIE,
        csrf,
        max_age=settings.session_lifetime_hours * 3600,
        httponly=False,  # JS must read it to send the header
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")


async def _resolve_session(request: Request) -> Optional[dict]:
    """Resolve the current durable session, or None. Fail-closed."""
    raw = _session_cookie(request)
    if not raw:
        return None
    try:
        async with db_connection() as conn:
            store = PgSessionStore(conn)
            row = await store.resolve_row(digest_handle(raw))
    except RuntimeError:
        return None
    if row is None:
        return None
    if row["retired"] or row["expires_at"] <= _utcnow():
        return None
    return row


def _csrf_ok(request: Request, session: dict) -> bool:
    """Double-submit CSRF check bound to the session row."""
    header_token = request.headers.get(CSRF_HEADER)
    cookie_token = request.cookies.get(CSRF_COOKIE)
    if not header_token or not cookie_token or header_token != cookie_token:
        return False
    return hmac.compare_digest(digest_token(cookie_token), session["csrf_digest"])


def _sign_internal_context(principal_id: str, tenant_id: Optional[str],
                           session_digest: str, ts: int,
                           correlation_id: str = "") -> str:
    """HMAC signature for BFF->API internal context headers (dev trust model).

    Production: workload identity (SPIFFE/SPIRE) per D3 candidates.
    """
    payload = (f"{principal_id}|{tenant_id or ''}|{session_digest}"
               f"|{ts}|{correlation_id}")
    return hmac.new(
        settings.bff_internal_secret.encode(), payload.encode(), hashlib.sha256
    ).hexdigest()


# ---------------------------------------------------------------------------
# Auth flow
# ---------------------------------------------------------------------------


@app.get("/auth/login")
async def auth_login() -> RedirectResponse:
    """Start the OIDC Authorization Code + PKCE flow."""
    state = oidc.new_state()
    nonce = oidc.new_nonce()
    verifier, challenge = oidc.new_pkce_pair()

    async with db_connection() as conn:
        await conn.execute(
            """
            INSERT INTO g1.oidc_pending_states
                (state_digest, nonce, code_verifier, post_login_redirect, expires_at)
            VALUES (%s, %s, %s, %s, %s)
            """,
            (
                digest_token(state),
                nonce,
                verifier,
                "/",
                _utcnow() + timedelta(minutes=10),
            ),
        )
        await conn.commit()

    return RedirectResponse(
        oidc.build_authorize_url(state=state, nonce=nonce, code_challenge=challenge),
        status_code=status.HTTP_302_FOUND,
    )


@app.get("/auth/callback")
async def auth_callback(code: str, state: str) -> Response:
    """OIDC redirect target — exchange code, validate, establish session."""
    # Consume the pending state one-shot
    async with db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                DELETE FROM g1.oidc_pending_states
                 WHERE state_digest = %s AND expires_at > %s
                 RETURNING nonce, code_verifier, post_login_redirect
                """,
                (digest_token(state), _utcnow()),
            )
            row = await cur.fetchone()
        await conn.commit()

    if row is None:
        # Unknown/expired state — fail closed, restart login
        return RedirectResponse("/", status_code=status.HTTP_302_FOUND)

    nonce, code_verifier, post_login_redirect = row

    try:
        tokens = await oidc.exchange_code(code=code, code_verifier=code_verifier)
        identity = oidc.validate_id_token(
            tokens["id_token"],
            expected_nonce=nonce,
            expected_issuer=oidc.expected_issuer(),
        )
    except Exception as exc:
        logger.warning("OIDC exchange/validation failed: %s", exc)
        return RedirectResponse("/?error=auth_failed", status_code=status.HTTP_302_FOUND)

    return await _establish_session(
        idp_subject_ref=identity.subject_ref,
        idp_issuer=identity.issuer,
        idp_session_ref=identity.idp_session_ref,
        authenticated_at_epoch=identity.authenticated_at_epoch,
        post_login_redirect=post_login_redirect,
    )


@app.get("/auth/dev-login")
async def auth_dev_login(subject: str = "dev-user-1") -> Response:
    """Development-only login bypass — simulates a completed OIDC flow.

    Only available when APP_ENVIRONMENT=development AND
    DEV_AUTH_BYPASS=true. Never enabled in production.
    """
    if not (settings.is_development and settings.dev_auth_bypass):
        return JSONResponse(
            {"error": "not_found"}, status_code=status.HTTP_404_NOT_FOUND
        )
    return await _establish_session(
        idp_subject_ref=subject,
        idp_issuer=f"dev-issuer:{settings.environment}",
        idp_session_ref=f"dev-sid-{secrets.token_urlsafe(8)}",
        authenticated_at_epoch=int(_utcnow().timestamp()),
        post_login_redirect="/",
    )


async def _establish_session(
    *,
    idp_subject_ref: str,
    idp_issuer: str,
    idp_session_ref: Optional[str],
    authenticated_at_epoch: int,
    post_login_redirect: str,
) -> Response:
    """Resolve principal + create durable session + set cookies."""
    async with db_connection() as conn:
        principal = await resolve_or_provision_principal(
            conn, idp_subject_ref=idp_subject_ref, idp_issuer=idp_issuer
        )
        if principal is None or not principal["active"]:
            # Unknown/inactive principal — fail closed, no existence leakage
            await conn.commit()
            return RedirectResponse("/?error=forbidden", status_code=status.HTTP_302_FOUND)

        handle = secrets.token_urlsafe(48)
        csrf = secrets.token_urlsafe(32)
        now = _utcnow()
        authenticated_at = datetime.fromtimestamp(authenticated_at_epoch, tz=timezone.utc)

        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO g1.browser_sessions
                    (handle_digest, principal_id, session_generation,
                     credential_generation, idp_session_ref, csrf_digest,
                     authenticated_at, created_at, expires_at, retired)
                VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, FALSE)
                """,
                (
                    digest_handle(handle),
                    principal["principal_id"],
                    f"session-gen-{secrets.token_urlsafe(12)}",
                    principal["credential_generation"],
                    idp_session_ref,
                    digest_token(csrf),
                    authenticated_at,
                    now,
                    now + timedelta(hours=settings.session_lifetime_hours),
                ),
            )
        await conn.commit()

    response = RedirectResponse(post_login_redirect, status_code=status.HTTP_302_FOUND)
    _set_session_cookie(response, handle)
    _set_csrf_cookie(response, csrf)
    return response


@app.post("/auth/logout")
async def auth_logout(request: Request) -> Response:
    """Retire the session server-side, clear cookies, IdP logout hint."""
    session = await _resolve_session(request)
    if session is not None:
        async with db_connection() as conn:
            store = PgSessionStore(conn)
            await store.retire(
                handle_digest=session["handle_digest"],
                expected_generation=session["session_generation"],
            )
            await conn.commit()
    response: Response
    sid = str(session.get("idp_session_ref") or "") if session else ""
    if sid and not sid.startswith("dev-sid-"):
        # RP-initiated logout: end the IdP SSO session too, then the
        # IdP lands back on the shell. Without this the Keycloak
        # session outlives our logout and the next sign-in silently
        # re-authenticates via SSO instead of prompting.
        from urllib.parse import urlencode
        params = urlencode({
            "client_id": settings.keycloak_client_id,
            "post_logout_redirect_uri": f"{settings.bff_public_url}/",
        })
        response = RedirectResponse(
            f"{oidc.end_session_endpoint()}?{params}",
            status_code=status.HTTP_302_FOUND)
    else:
        response = RedirectResponse("/", status_code=status.HTTP_302_FOUND)
    _clear_auth_cookies(response)
    return response


# ---------------------------------------------------------------------------
# Session / tenant context endpoints (consumed by the shell)
# ---------------------------------------------------------------------------


@app.get("/api/session")
async def api_session(request: Request) -> JSONResponse:
    """Current session state for the shell.

    States: unauthenticated | needs_tenant | ready
    """
    session = await _resolve_session(request)
    if session is None:
        return JSONResponse({"state": "unauthenticated",
                             "environment": settings.environment})

    async with db_connection() as conn:
        memberships = await access.accessible_tenants(
            conn, session["principal_id"])

    if not memberships:
        return JSONResponse({"state": "forbidden"})

    bound = session["bound_tenant_id"]
    if bound:
        tenant = next((m for m in memberships if m["tenant_id"] == bound), None)
        if tenant is None:
            # Bound tenant no longer authorized — fail closed
            return JSONResponse({"state": "forbidden"})
        return JSONResponse(
            {
                "state": "ready",
                # g1 shell-view contract fields
                "tenant_id": tenant["tenant_id"],
                "principal_id": session["principal_id"],
                "admission_revision": session.get("session_generation")
                    or session.get("credential_generation"),
                # operational extensions (membership picker etc.)
                "tenant": tenant,
                "memberships": memberships,
                "authenticated_at": session["authenticated_at"].isoformat(),
            }
        )

    return JSONResponse(
        {
            "state": "needs_tenant",
            "principal_id": session["principal_id"],
            "memberships": memberships,
        }
    )


class _TenantSelect:
    pass


@app.post("/api/tenant/select")
async def api_tenant_select(request: Request) -> JSONResponse:
    """Bind the session to a tenant. Requires CSRF + active membership."""
    session = await _resolve_session(request)
    if session is None:
        return JSONResponse({"state": "unauthenticated"},
                            status_code=status.HTTP_401_UNAUTHORIZED)
    if not _csrf_ok(request, session):
        return JSONResponse({"state": "forbidden"},
                            status_code=status.HTTP_403_FORBIDDEN)

    body = await request.json()
    tenant_id = body.get("tenant_id")

    async with db_connection() as conn:
        membership = await check_membership(conn, session["principal_id"], tenant_id)
        authorized = membership is not None
        role = membership["role"] if membership else None

        if not authorized:
            # Delegated grant or platform capability — the other two
            # legal paths to bind a tenant (same 403 on denial, no
            # existence leakage).
            authorized = await access.tenant_authorized(
                conn, session["principal_id"], tenant_id)

        if not authorized:
            return JSONResponse({"state": "forbidden"},
                                status_code=status.HTTP_403_FORBIDDEN)

    if role is None:
        # Delegation / platform entry — accountable, tenant-scoped
        # audit (audit.audit_event is RLS-protected, needs the tenant
        # context set).
        async with db_tenant_connection(tenant_id) as tconn:
            delegated = await access.effective_permissions(
                tconn, session["principal_id"], tenant_id)
            if await access.principal_is_platform_admin(
                    tconn, session["principal_id"]):
                role = "platform"
                await record_audit_event(
                    tconn, tenant_id,
                    action="platform.cross_tenant_entry",
                    actor_kind="platform_admin",
                    actor_id=session["principal_id"],
                    subject_type="tenant", subject_id=tenant_id,
                    detail={"via": "tenant_bind"})
            else:
                role = "delegated"
                await record_audit_event(
                    tconn, tenant_id,
                    action="delegation.tenant_entry",
                    actor_kind="delegated_principal",
                    actor_id=session["principal_id"],
                    subject_type="tenant", subject_id=tenant_id,
                    detail={"permissions": sorted(delegated)})
            await tconn.commit()

    async with db_connection() as conn:
        store = PgSessionStore(conn)
        ok = await store.bind_tenant(
            session["handle_digest"], tenant_id, session["session_generation"]
        )
        await conn.commit()

    if not ok:
        return JSONResponse({"state": "unavailable"},
                            status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
    return JSONResponse({"state": "ready", "tenant_id": tenant_id,
                         "role": role})


# ---------------------------------------------------------------------------
# Internal API proxy (BFF -> API with signed context)
# ---------------------------------------------------------------------------


@app.api_route("/api/v1/{path:path}", methods=["GET", "POST", "PUT", "DELETE", "PATCH"])
async def proxy_to_api(request: Request, path: str) -> Response:
    """Proxy protected API calls, injecting signed authority context.

    The browser never talks to the internal API directly. The BFF
    resolves the durable session, attaches signed context headers, and
    forwards. The API verifies the signature and timestamp freshness.
    """
    # G9 provider callback boundary — external providers carry no
    # session. Forward raw; the API authenticates via HMAC and the
    # endpoint can never mutate alert/ack/responsibility state.
    if path == "alerting/notifications/callback":
        url = f"{settings.api_internal_url}/api/v1/{path}"
        body = await request.body()
        fwd = {k: v for k, v in request.headers.items()
               if k.lower() in ("x-provider-signature",
                                "content-type")}
        hk: dict = {"timeout": 30.0}
        cert = os.environ.get("BFF_CLIENT_CERT_FILE")
        key = os.environ.get("BFF_CLIENT_KEY_FILE")
        ca = os.environ.get("API_CA_FILE")
        if cert and key:
            hk["cert"] = (cert, key)
        if ca:
            hk["verify"] = ca
        async with httpx.AsyncClient(**hk) as client:
            try:
                resp = await client.post(url, content=body,
                                         headers=fwd)
            except httpx.HTTPError:
                return JSONResponse(
                    {"state": "unavailable"},
                    status_code=status.HTTP_503_SERVICE_UNAVAILABLE)
        return Response(content=resp.content,
                        status_code=resp.status_code,
                        media_type=resp.headers.get("content-type"))

    session = await _resolve_session(request)
    if session is None:
        return JSONResponse({"state": "unauthenticated"},
                            status_code=status.HTTP_401_UNAUTHORIZED)

    if request.method != "GET" and not _csrf_ok(request, session):
        return JSONResponse({"state": "forbidden"},
                            status_code=status.HTTP_403_FORBIDDEN)

    ts = int(_utcnow().timestamp())
    digest = session["handle_digest"]
    tenant = session["bound_tenant_id"]
    corr = telemetry.extract_correlation_id(request.headers)
    signature = _sign_internal_context(
        session["principal_id"], tenant, digest, ts, corr
    )

    url = f"{settings.api_internal_url}/api/v1/{path}"
    headers = {
        "X-JLMirror-Principal-Id": session["principal_id"],
        "X-JLMirror-Session-Digest": digest,
        "X-JLMirror-Session-Generation": session["session_generation"],
        "X-JLMirror-Tenant-Id": tenant or "",
        "X-JLMirror-Context-Ts": str(ts),
        "X-JLMirror-Correlation-Id": corr,
        "X-JLMirror-Context-Sig": signature,
    }
    body = await request.body()

    # mTLS toward the internal API when configured — the BFF presents
    # its service cert and verifies the API against the CA.
    client_cert = os.environ.get("BFF_CLIENT_CERT_FILE")
    client_key = os.environ.get("BFF_CLIENT_KEY_FILE")
    ca_file = os.environ.get("API_CA_FILE")
    httpx_kwargs: dict = {"timeout": 30.0}
    if client_cert and client_key:
        httpx_kwargs["cert"] = (client_cert, client_key)
    if ca_file:
        httpx_kwargs["verify"] = ca_file

    async with httpx.AsyncClient(**httpx_kwargs) as client:
        try:
            resp = await client.request(
                request.method, url, headers=headers,
                content=body, params=dict(request.query_params),
            )
        except httpx.HTTPError:
            return JSONResponse({"state": "unavailable"},
                                status_code=status.HTTP_503_SERVICE_UNAVAILABLE)

    return Response(
        content=resp.content,
        status_code=resp.status_code,
        media_type=resp.headers.get("content-type"),
    )


# ---------------------------------------------------------------------------
# Health + shell
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "service": "bff"}


@app.post("/dev/whatsapp/{phone_ref}/messages", tags=["dev"])
async def dev_whatsapp_sink(phone_ref: str) -> dict:
    """Dev stand-in for the WhatsApp Cloud API — plain HTTP target
    for the G9 adapter (the api itself is mTLS). Returns a
    provider-shaped wamid; 2xx = provider accepted, NOT delivered."""
    if os.environ.get("APP_ENVIRONMENT", "") != "development":
        return JSONResponse({"state": "forbidden"}, status_code=403)
    import secrets as _s
    return {"messaging_product": "whatsapp",
            "contacts": [{"input": phone_ref, "wa_id": phone_ref}],
            "messages": [{"id": f"wamid.dev-{_s.token_hex(8)}"}]}


@app.get("/health/ready")
async def readiness() -> JSONResponse:
    """Readiness with declared failure modes (ADR-017).

    - database: authoritative -> fail closed (not_ready / 503)
    - api:      required for data, but shell/auth still serve ->
      degraded (200 with explicit state)
    """
    deps: dict = {}
    degraded = False

    try:
        async with db_connection() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT 1")
        deps["database"] = {"state": "ok", "mode": "fail_closed"}
    except Exception:
        deps["database"] = {"state": "unavailable", "mode": "fail_closed"}
        return JSONResponse(
            {"status": "not_ready", "service": "bff",
             "dependencies": deps},
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        )

    api_dep = {"state": "ok", "mode": "degraded"}
    try:
        async with httpx.AsyncClient(timeout=3.0) as client:
            resp = await client.get(f"{settings.api_internal_url}/health")
            if resp.status_code != 200:
                raise RuntimeError("api health non-200")
    except Exception:
        api_dep["state"] = "unavailable"
        degraded = True
    deps["api"] = api_dep

    return JSONResponse(
        {"status": "degraded" if degraded else "ready",
         "service": "bff", "dependencies": deps},
        status_code=status.HTTP_200_OK,
    )


@app.middleware("http")
async def shell_no_cache(request: Request, call_next):
    """Shell assets revalidate every load — stale app.js keeps running
    old client logic (e.g. an outdated op watcher) across rebuilds."""
    resp = await call_next(request)
    if request.url.path in ("/", "/index.html", "/app.js", "/style.css"):
        resp.headers["Cache-Control"] = "no-cache"
    return resp


app.mount("/", StaticFiles(directory=SHELL_DIR, html=True), name="shell")


def _tls_paths() -> tuple[str | None, str | None]:
    """TLS is explicit opt-in via TLS_CERT_FILE/TLS_KEY_FILE — kept
    out of auto-detection so a bare clone still boots http dev."""
    cert = os.environ.get("TLS_CERT_FILE")
    key = os.environ.get("TLS_KEY_FILE")
    if cert and key:
        return cert, key
    return None, None


def run() -> None:
    import uvicorn

    telemetry.configure_structured_logging(settings.log_level)
    cert, key = _tls_paths()
    kwargs: dict = {}
    if cert and key:
        kwargs = {"ssl_certfile": cert, "ssl_keyfile": key}
    uvicorn.run("bff.main:app", host=settings.bff_host, port=settings.bff_port,
                reload=settings.is_development, **kwargs)


if __name__ == "__main__":
    run()
