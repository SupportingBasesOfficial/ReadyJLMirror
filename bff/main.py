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
from fastapi import FastAPI, HTTPException, Request, Response, status
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request as StarletteRequest

from shared.config import settings
from shared.db import (
    close_pool, db_connection, db_tenant_connection, init_pool)
from shared import access, telemetry
from shared.audit import record_audit_event
from bff import keycloak_admin, oidc
from bff.identity import (
    check_membership,
    resolve_or_provision_principal,
)
from bff.sessions import PgSessionStore, digest_handle, digest_token

logger = logging.getLogger(__name__)
logging.basicConfig(level=settings.log_level)

SESSION_COOKIE = "jl_session"
CSRF_COOKIE = "jl_csrf"
ID_TOKEN_COOKIE = "jl_id_hint"
CSRF_HEADER = "x-csrf-token"
SHELL_DIR = Path(__file__).resolve().parent / "shell"


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    try:
        await init_pool()
    except Exception:
        logger.warning("BFF: database pool init failed; auth endpoints will 503")
    # Shared httpx client — reuses connections across requests (no TCP handshake per call)
    client_cert = os.environ.get("BFF_CLIENT_CERT_FILE")
    client_key = os.environ.get("BFF_CLIENT_KEY_FILE")
    ca_file = os.environ.get("API_CA_FILE")
    httpx_kwargs: dict = {"timeout": 30.0}
    if client_cert and client_key:
        httpx_kwargs["cert"] = (client_cert, client_key)
    if ca_file:
        httpx_kwargs["verify"] = ca_file
    app.state.http_client = httpx.AsyncClient(**httpx_kwargs)
    app.state.sse_client = httpx.AsyncClient(timeout=None, **(
        {k: v for k, v in httpx_kwargs.items() if k != "timeout"}
    ))
    yield
    await app.state.http_client.aclose()
    await app.state.sse_client.aclose()
    await close_pool()


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: StarletteRequest, call_next):
        response = await call_next(request)
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        return response


app = FastAPI(title="ReadyJLMirror BFF", version="0.1.0", lifespan=lifespan)
app.add_middleware(SecurityHeadersMiddleware)
app.add_middleware(GZipMiddleware, minimum_size=1024)


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


def _set_id_token_cookie(response: Response, id_token: str) -> None:
    response.set_cookie(
        ID_TOKEN_COOKIE,
        id_token,
        max_age=settings.session_lifetime_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite="lax",
        path="/",
    )


def _clear_auth_cookies(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/")
    response.delete_cookie(CSRF_COOKIE, path="/")
    response.delete_cookie(ID_TOKEN_COOKIE, path="/")


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

    response = await _establish_session(
        idp_subject_ref=identity.subject_ref,
        idp_issuer=identity.issuer,
        idp_session_ref=identity.idp_session_ref,
        authenticated_at_epoch=identity.authenticated_at_epoch,
        post_login_redirect=post_login_redirect,
    )
    _set_id_token_cookie(response, tokens["id_token"])
    return response


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
    if session is not None and not _csrf_ok(request, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf")
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
        # id_token_hint skips Keycloak's logout confirmation page.
        from urllib.parse import urlencode
        logout_params: dict = {
            "client_id": settings.keycloak_client_id,
            "post_logout_redirect_uri": f"{settings.bff_public_url}/",
        }
        id_token_hint = request.cookies.get(ID_TOKEN_COOKIE, "")
        if id_token_hint:
            logout_params["id_token_hint"] = id_token_hint
        params = urlencode(logout_params)
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
        async with db_connection() as conn:
            permissions = sorted(await access.effective_permissions(
                conn, session["principal_id"], bound))
        return JSONResponse(
            {
                "state": "ready",
                # g1 shell-view contract fields
                "tenant_id": tenant["tenant_id"],
                "principal_id": session["principal_id"],
                "admission_revision": session.get("session_generation")
                    or session.get("credential_generation"),
                # Effective permissions — the shell projects these to
                # decide which mutation controls to render. The API
                # remains the authoritative gate; this is UX-only.
                "permissions": permissions,
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
# Monitoring: recheck (re-enqueue validation) — BFF-direct, no proxy
# ---------------------------------------------------------------------------


@app.post("/api/v1/monitoring/sources/{source_id}/recheck")
async def recheck_monitoring_source(source_id: str, request: Request) -> JSONResponse:
    """Re-enqueue a validation_and_initial_sync op for a monitoring source.

    Called when the source is unavailable but the provider is now reachable.
    The validation worker will pick it up within its next poll cycle (~10s).
    """
    session = await _resolve_session(request)
    if session is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unauthenticated")
    if not _csrf_ok(request, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf")
    tenant_id = session.get("bound_tenant_id")
    if not tenant_id:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no tenant bound")
    from shared.monitoring_repo import enqueue_sync_operation
    async with db_tenant_connection(tenant_id) as conn:
        try:
            op_id = await enqueue_sync_operation(
                conn,
                tenant_id=tenant_id,
                source_id=source_id,
                responsibility_kind="validation_and_initial_sync",
            )
            await conn.commit()
        except ValueError:
            raise HTTPException(404, "monitoring source not found")
    return JSONResponse({"monitoring_sync_operation_id": op_id}, status_code=201)


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
        client = request.app.state.http_client
        try:
            resp = await client.post(url, content=body, headers=fwd)
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

    # SSE streaming proxy — httpx non-streaming would buffer indefinitely.
    if request.headers.get("accept") == "text/event-stream" or path == "noc/stream":
        sse_client = request.app.state.sse_client

        async def _sse_proxy():
            async with sse_client.stream(
                "GET", url, headers=headers,
                params=dict(request.query_params)
            ) as sse_resp:
                async for chunk in sse_resp.aiter_bytes():
                    yield chunk

        return StreamingResponse(
            _sse_proxy(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )
    body = await request.body()

    client = request.app.state.http_client
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
# Admin: user management (tenant:admin required)
# ---------------------------------------------------------------------------

_VALID_ROLES = {"admin", "operator", "viewer", "auditor"}


async def _require_admin(request: Request) -> dict:
    """Resolve session and assert tenant:admin role. Returns the session dict."""
    session = await _resolve_session(request)
    if session is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "unauthenticated")
    bound = session.get("bound_tenant_id")
    if not bound:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "no tenant bound")
    async with db_connection() as conn:
        membership = await check_membership(conn, session["principal_id"], bound)
    if membership is None or membership["role"] not in ("admin", "tenant_admin"):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "admin required")
    return session


@app.get("/api/admin/users")
async def admin_list_users(request: Request) -> JSONResponse:
    session = await _require_admin(request)
    tenant_id = session["bound_tenant_id"]
    async with db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                SELECT p.principal_id, p.idp_subject_ref, p.active, p.created_at,
                       m.role, m.state
                  FROM g1.principals p
                  JOIN g1.tenant_memberships m USING (principal_id)
                 WHERE m.tenant_id = %s
                 ORDER BY p.created_at
                """,
                (tenant_id,),
            )
            rows = await cur.fetchall()
    kc_data = await keycloak_admin.get_users_by_ids([r[1] for r in rows])
    users = []
    for row in rows:
        principal_id, sub, active, created_at, role, mem_state = row
        kc = kc_data.get(sub, {})
        users.append({
            "principal_id": principal_id,
            "idp_subject_ref": sub,
            "active": active,
            "created_at": created_at.isoformat() if created_at else None,
            "role": role,
            "membership_state": mem_state,
            "email": kc.get("email", ""),
            "first_name": kc.get("firstName", ""),
            "last_name": kc.get("lastName", ""),
            "kc_enabled": kc.get("enabled", True),
        })
    return JSONResponse(users)


@app.post("/api/admin/users")
async def admin_invite_user(request: Request) -> JSONResponse:
    session = await _require_admin(request)
    if not _csrf_ok(request, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf")
    body = await request.json()
    email = (body.get("email") or "").strip()
    first_name = (body.get("first_name") or "").strip()
    last_name = (body.get("last_name") or "").strip()
    role = body.get("role", "viewer")
    if not email or not first_name:
        raise HTTPException(400, "email and first_name are required")
    if role not in _VALID_ROLES:
        raise HTTPException(400, f"invalid role: {role}")
    tenant_id = session["bound_tenant_id"]
    temp_password = secrets.token_urlsafe(12)
    try:
        kc_user_id = await keycloak_admin.create_user(
            email=email,
            first_name=first_name,
            last_name=last_name,
            temp_password=temp_password,
        )
    except ValueError as exc:
        if "email_exists" in str(exc):
            raise HTTPException(409, "email already exists in identity provider")
        raise
    issuer = oidc.expected_issuer()
    principal_id = f"principal.{secrets.token_urlsafe(16)}"
    membership_id = f"membership.{secrets.token_urlsafe(16)}"
    cred_gen = f"cred-gen-{secrets.token_urlsafe(8)}"
    async with db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                INSERT INTO g1.principals
                    (principal_id, kind, credential_generation,
                     idp_subject_ref, idp_issuer, active)
                VALUES (%s, 'human_browser_session', %s, %s, %s, TRUE)
                """,
                (principal_id, cred_gen, kc_user_id, issuer),
            )
            await cur.execute(
                """
                INSERT INTO g1.tenant_memberships
                    (membership_id, tenant_id, principal_id, role, state)
                VALUES (%s, %s, %s, %s, 'active')
                """,
                (membership_id, tenant_id, principal_id, role),
            )
        await conn.commit()
    return JSONResponse(
        {"principal_id": principal_id, "temp_password": temp_password},
        status_code=201,
    )


@app.patch("/api/admin/users/{principal_id}/role")
async def admin_update_role(principal_id: str, request: Request) -> JSONResponse:
    session = await _require_admin(request)
    if not _csrf_ok(request, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf")
    body = await request.json()
    role = body.get("role", "")
    if role not in _VALID_ROLES:
        raise HTTPException(400, f"invalid role: {role}")
    tenant_id = session["bound_tenant_id"]
    async with db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                """
                UPDATE g1.tenant_memberships
                   SET role = %s
                 WHERE principal_id = %s AND tenant_id = %s
                """,
                (role, principal_id, tenant_id),
            )
            if cur.rowcount == 0:
                raise HTTPException(404, "user not found in this tenant")
        await conn.commit()
    return JSONResponse({"ok": True})


@app.post("/api/admin/users/{principal_id}/deactivate")
async def admin_deactivate_user(principal_id: str, request: Request) -> JSONResponse:
    session = await _require_admin(request)
    if not _csrf_ok(request, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf")
    tenant_id = session["bound_tenant_id"]
    # Phase 1: read-only — fetch sub and verify membership.
    async with db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT idp_subject_ref FROM g1.principals WHERE principal_id = %s",
                (principal_id,),
            )
            row = await cur.fetchone()
            if row is None:
                raise HTTPException(404, "principal not found")
            sub = row[0]
            await cur.execute(
                "SELECT 1 FROM g1.tenant_memberships WHERE principal_id=%s AND tenant_id=%s",
                (principal_id, tenant_id),
            )
            if await cur.fetchone() is None:
                raise HTTPException(403, "user not in this tenant")
    # Phase 2: Keycloak first — if this fails we haven't touched the DB.
    await keycloak_admin.set_user_enabled(sub, False)
    # Phase 3: record the state change in the DB.
    async with db_connection() as conn:
        await conn.execute(
            "UPDATE g1.principals SET active = FALSE WHERE principal_id = %s",
            (principal_id,),
        )
        await conn.commit()
    return JSONResponse({"ok": True})


@app.post("/api/admin/users/{principal_id}/reactivate")
async def admin_reactivate_user(principal_id: str, request: Request) -> JSONResponse:
    session = await _require_admin(request)
    if not _csrf_ok(request, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf")
    tenant_id = session["bound_tenant_id"]
    # Phase 1: read-only — fetch sub and verify membership.
    async with db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT idp_subject_ref FROM g1.principals WHERE principal_id = %s",
                (principal_id,),
            )
            row = await cur.fetchone()
            if row is None:
                raise HTTPException(404, "principal not found")
            sub = row[0]
            await cur.execute(
                "SELECT 1 FROM g1.tenant_memberships WHERE principal_id=%s AND tenant_id=%s",
                (principal_id, tenant_id),
            )
            if await cur.fetchone() is None:
                raise HTTPException(403, "user not in this tenant")
    # Phase 2: Keycloak first — if this fails we haven't touched the DB.
    await keycloak_admin.set_user_enabled(sub, True)
    # Phase 3: record the state change in the DB.
    async with db_connection() as conn:
        await conn.execute(
            "UPDATE g1.principals SET active = TRUE WHERE principal_id = %s",
            (principal_id,),
        )
        await conn.commit()
    return JSONResponse({"ok": True})


@app.delete("/api/admin/users/{principal_id}")
async def admin_delete_user(principal_id: str, request: Request) -> JSONResponse:
    session = await _require_admin(request)
    if not _csrf_ok(request, session):
        raise HTTPException(status.HTTP_403_FORBIDDEN, "csrf")
    tenant_id = session["bound_tenant_id"]
    # Phase 1: read — fetch sub, verify membership, count remaining tenants.
    async with db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "SELECT idp_subject_ref FROM g1.principals WHERE principal_id = %s",
                (principal_id,),
            )
            row = await cur.fetchone()
            if row is None:
                raise HTTPException(404, "principal not found")
            sub = row[0]
            await cur.execute(
                "SELECT COUNT(*) FROM g1.tenant_memberships WHERE principal_id=%s AND tenant_id=%s",
                (principal_id, tenant_id),
            )
            if (await cur.fetchone())[0] == 0:
                raise HTTPException(403, "user not in this tenant")
            await cur.execute(
                "SELECT COUNT(*) FROM g1.tenant_memberships WHERE principal_id = %s",
                (principal_id,),
            )
            total_memberships = (await cur.fetchone())[0]
    # Phase 2: Keycloak — delete only when this is the user's last tenant.
    # Keycloak first so a DB failure does not leave a live IdP user with no DB record.
    if total_memberships == 1:
        await keycloak_admin.delete_user(sub)
    # Phase 3: DB writes — remove membership and deactivate if last tenant.
    async with db_connection() as conn:
        async with conn.cursor() as cur:
            await cur.execute(
                "DELETE FROM g1.tenant_memberships WHERE principal_id=%s AND tenant_id=%s",
                (principal_id, tenant_id),
            )
            if total_memberships == 1:
                await cur.execute(
                    "UPDATE g1.principals SET active = FALSE WHERE principal_id = %s",
                    (principal_id,),
                )
        await conn.commit()
    return JSONResponse({"ok": True})


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
    if not settings.is_development:
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


# ---------------------------------------------------------------------------
# G24 Public Status Page — no auth required
# ---------------------------------------------------------------------------

_STATUS_PAGE_HTML = """<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>{{TENANT_NAME}} — Status</title>
<style>
*{{box-sizing:border-box;margin:0;padding:0;}}
body{{
  background:#0f1115;color:#e6e8ec;
  font-family:system-ui,-apple-system,'Segoe UI',sans-serif;
  font-size:14px;min-height:100vh;display:flex;flex-direction:column;
}}
/* Header */
header{{
  background:#161a22;border-bottom:1px solid #262c3a;
  padding:0 24px;height:56px;display:flex;align-items:center;
  justify-content:space-between;gap:12px;position:sticky;top:0;z-index:10;
}}
header .site-name{{font-weight:600;font-size:15px;}}
header button{{
  display:flex;align-items:center;gap:6px;font-size:12px;color:#8b93a5;
  background:none;border:none;cursor:pointer;padding:4px 8px;border-radius:6px;
  font-family:inherit;transition:color .15s;
}}
header button:hover{{color:#e6e8ec;}}
header button svg{{transition:transform .15s;}}
header button.spinning svg{{animation:spin 1s linear infinite;}}
/* Main */
main{{flex:1;max-width:640px;margin:0 auto;width:100%;padding:40px 24px;}}
/* Status banner */
.banner{{
  display:flex;align-items:center;gap:16px;padding:20px 24px;
  border-radius:14px;border:1px solid;margin-bottom:32px;
}}
.banner-icon{{flex-shrink:0;}}
.banner-title{{font-weight:600;font-size:17px;}}
.banner-sub{{font-size:12px;color:#8b93a5;margin-top:2px;}}
/* Metrics grid */
.metrics{{
  display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));
  gap:12px;margin-bottom:32px;
}}
.metric{{
  padding:16px 18px;border-radius:10px;background:#161a22;
  border:1px solid #262c3a;text-align:center;
}}
.metric-val{{font-size:24px;font-weight:700;font-variant-numeric:tabular-nums;}}
.metric-lbl{{font-size:11px;color:#8b93a5;margin-top:4px;}}
/* Component list */
.components{{
  border-radius:10px;border:1px solid #262c3a;background:#161a22;overflow:hidden;
}}
.components-header{{
  padding:12px 18px;border-bottom:1px solid #262c3a;font-size:12px;
  font-weight:600;color:#8b93a5;text-transform:uppercase;letter-spacing:.06em;
}}
.component-row{{
  display:flex;align-items:center;justify-content:space-between;
  padding:13px 18px;border-bottom:1px solid #1c2130;
}}
.component-row:last-child{{border-bottom:none;}}
.component-name{{font-size:13px;color:#e6e8ec;}}
.component-status{{
  display:flex;align-items:center;gap:6px;font-size:12px;
}}
.dot{{
  width:8px;height:8px;border-radius:50%;flex-shrink:0;display:inline-block;
}}
/* Footer */
.auto-refresh{{margin-top:40px;text-align:center;font-size:12px;color:#5a6274;}}
footer{{
  text-align:center;padding:16px 24px;border-top:1px solid #1c2130;
  font-size:11px;color:#5a6274;
}}
footer span{{color:#6ea8fe;font-weight:500;}}
/* Loading / error */
.centered{{text-align:center;padding-top:80px;color:#8b93a5;}}
.centered p{{font-size:16px;margin-bottom:8px;color:#e6e8ec;}}
.centered small{{font-size:13px;}}
@keyframes spin{{to{{transform:rotate(360deg);}}}}
</style>
</head>
<body>
<header>
  <span class="site-name" id="site-name">{{TENANT_NAME}}</span>
  <button id="refresh-btn" onclick="doRefresh()">
    <svg id="refresh-icon" width="13" height="13" viewBox="0 0 24 24" fill="none"
         stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="23 4 23 10 17 10"/>
      <polyline points="1 20 1 14 7 14"/>
      <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>
    </svg>
    Atualizar
  </button>
</header>
<main id="main">
  <div class="centered" id="loading">Carregando status…</div>
  <div id="content" style="display:none"></div>
  <div class="centered" id="error-404" style="display:none">
    <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"
         style="margin:0 auto 16px;opacity:.3;display:block">
      <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
      <line x1="12" y1="17" x2="12.01" y2="17"/>
    </svg>
    <p>Página de status não encontrada</p>
    <small>Verifique o endereço ou contate o responsável pelo serviço.</small>
  </div>
  <div class="centered" id="error-generic" style="display:none" style="color:#ff6b6b">
    Não foi possível carregar o status. Tente novamente em instantes.
  </div>
</main>
<footer>Monitorado por <span>JLMirror</span></footer>
<script>
var SLUG=window.location.pathname.replace(/^\\/status\\//,'');
var LABELS={{
  operational:'Todos os sistemas operacionais',
  degraded:'Degradação de performance',
  outage:'Interrupção de serviço',
  unknown:'Status desconhecido'
}};
var COLORS={{
  operational:{{color:'#6fdc8c',bg:'rgba(111,220,140,.08)',border:'rgba(111,220,140,.2)'}},
  degraded:{{color:'#e6b450',bg:'rgba(230,180,80,.08)',border:'rgba(230,180,80,.2)'}},
  outage:{{color:'#ff6b6b',bg:'rgba(255,107,107,.08)',border:'rgba(255,107,107,.2)'}},
  unknown:{{color:'#8b93a5',bg:'rgba(139,147,165,.08)',border:'rgba(139,147,165,.2)'}}
}};

function fmtDatetime(){{
  return new Date().toLocaleString('pt-BR',{{
    day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'
  }});
}}

function dot(color){{
  return '<span class="dot" style="background:'+color+'"></span>';
}}

function render(d){{
  var s=d.status||'unknown';
  var c=COLORS[s]||COLORS.unknown;
  var now=fmtDatetime();
  var activeAlerts=d.active_alerts||0;
  var criticalAlerts=d.critical_alerts||0;
  var sourceCount=d.source_count||0;

  // Component rows
  var monStatus=criticalAlerts>0?'Incidente ativo':activeAlerts>0?'Degradado':'Operacional';
  var monColor=criticalAlerts>0?'#ff6b6b':activeAlerts>0?'#e6b450':'#6fdc8c';
  var srcStatus=sourceCount>0?(sourceCount+' fonte'+(sourceCount!==1?'s':'')+' ativa'+(sourceCount!==1?'s':'')):'Nenhuma fonte configurada';
  var srcColor=sourceCount>0?'#6fdc8c':'#e6b450';

  document.getElementById('content').innerHTML=
    '<div class="banner" style="border-color:'+c.border+';background:'+c.bg+'">'+
      '<div class="banner-icon">'+statusSVG(s,c.color)+'</div>'+
      '<div>'+
        '<div class="banner-title" style="color:'+c.color+'">'+LABELS[s]+'</div>'+
        '<div class="banner-sub">Atualizado em '+now+'</div>'+
      '</div>'+
    '</div>'+
    '<div class="metrics">'+
      metricCard('Alertas ativos',activeAlerts,'#e6e8ec')+
      metricCard('Críticos',criticalAlerts,criticalAlerts>0?'#ff6b6b':'#8b93a5')+
      metricCard('Fontes monitoradas',sourceCount,'#6ea8fe')+
    '</div>'+
    '<div class="components">'+
      '<div class="components-header">Componentes</div>'+
      componentRow('Monitoramento',monStatus,monColor)+
      componentRow('Coleta de dados',srcStatus,srcColor)+
      componentRow('Sistema geral',LABELS[s],c.color)+
    '</div>'+
    '<div class="auto-refresh">Atualização automática a cada 30 segundos</div>';

  document.getElementById('loading').style.display='none';
  document.getElementById('content').style.display='';
}}

function metricCard(label,value,color){{
  return '<div class="metric">'+
    '<div class="metric-val" style="color:'+color+'">'+value+'</div>'+
    '<div class="metric-lbl">'+label+'</div>'+
  '</div>';
}}

function componentRow(name,status,color){{
  return '<div class="component-row">'+
    '<span class="component-name">'+name+'</span>'+
    '<span class="component-status" style="color:'+color+'">'+
      dot(color)+status+
    '</span>'+
  '</div>';
}}

function statusSVG(status,color){{
  var paths={{
    operational:'<polyline points="20 6 9 17 4 12"/>',
    degraded:'<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>',
    outage:'<polygon points="7.86 2 16.14 2 22 7.86 22 16.14 16.14 22 7.86 22 2 16.14 2 7.86 7.86 2"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
    unknown:'<circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
  }};
  return '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="'+color+
    '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'+
    (paths[status]||paths.unknown)+'</svg>';
}}

function showError(is404){{
  document.getElementById('loading').style.display='none';
  document.getElementById('content').style.display='none';
  document.getElementById('error-404').style.display=is404?'':'none';
  document.getElementById('error-generic').style.display=is404?'none':'';
}}

async function doRefresh(){{
  var btn=document.getElementById('refresh-btn');
  btn.classList.add('spinning');
  try{{
    var r=await fetch('/api/public/status/'+SLUG);
    if(r.status===404){{showError(true);return;}}
    if(!r.ok){{showError(false);return;}}
    var d=await r.json();
    render(d);
  }}catch(e){{showError(false);}}
  finally{{btn.classList.remove('spinning');}}
}}

doRefresh();
setInterval(doRefresh,30000);
</script>
</body>
</html>"""


@app.get("/api/public/status/{slug}", include_in_schema=False)
async def public_status_json(slug: str) -> JSONResponse:
    """Public status JSON — no auth. BFF queries DB directly."""
    try:
        async with db_connection() as conn:
            cur = await conn.execute(
                """
                SELECT tenant_id, public_name, components
                  FROM g1.tenant_status_config
                 WHERE status_slug = %s AND enabled = true
                """, (slug,))
            row = await cur.fetchone()
    except Exception:
        return JSONResponse({"status": "unknown", "error": "db_unavailable"},
                            status_code=503)
    if row is None:
        return JSONResponse({"status": "unknown"},
                            status_code=404)
    tenant_id, public_name, components_raw = row
    components = components_raw if components_raw is not None else []

    try:
        async with db_connection() as conn:
            await conn.execute(
                "SELECT set_config('jlmirror.tenant_id', %s, true)",
                (tenant_id,))
            cur = await conn.execute(
                """
                SELECT
                    COUNT(*) FILTER (WHERE lifecycle_state = 'active') AS active_alerts,
                    COUNT(*) FILTER (
                        WHERE lifecycle_state = 'active'
                          AND (source_evidence_summary->>'severity_class') = 'critical'
                    ) AS critical_alerts,
                    COUNT(*) FILTER (
                        WHERE lifecycle_state = 'active'
                          AND (source_evidence_summary->>'severity_class') IN ('warning','degraded')
                    ) AS degraded_alerts
                  FROM alerting.alert
                 WHERE tenant_id = %s
                """, (tenant_id,))
            alert_row = await cur.fetchone()
            cur = await conn.execute(
                """
                SELECT COUNT(*) FROM monitoring.monitoring_source
                 WHERE tenant_id = %s AND enabled = true
                """, (tenant_id,))
            src_row = await cur.fetchone()
    except Exception:
        return JSONResponse({"status": "unknown", "public_name": public_name,
                             "error": "data_unavailable"}, status_code=500)

    active = int(alert_row[0] or 0)
    critical = int(alert_row[1] or 0)
    degraded_count = int(alert_row[2] or 0)
    sources = int(src_row[0] or 0)

    if critical > 0:
        overall = "outage"
    elif degraded_count > 0 or active > 0:
        overall = "degraded"
    else:
        overall = "operational"

    return JSONResponse({
        "status": overall,
        "public_name": public_name,
        "active_alerts": active,
        "critical_alerts": critical,
        "source_count": sources,
        "components": components,
    })


@app.get("/status/{slug}", include_in_schema=False)
async def public_status_page(slug: str) -> Response:
    """Serve the public status page HTML without authentication."""
    try:
        async with db_connection() as conn:
            cur = await conn.execute(
                """
                SELECT public_name FROM g1.tenant_status_config
                 WHERE status_slug = %s AND enabled = true
                """, (slug,))
            row = await cur.fetchone()
    except Exception:
        row = None
    if row is None:
        return Response(content="Status page not found.", status_code=404,
                        media_type="text/plain")
    import html as _html
    safe_name = _html.escape(str(row[0]))
    rendered = _STATUS_PAGE_HTML.replace("{{TENANT_NAME}}", safe_name)
    return Response(content=rendered, media_type="text/html",
                    headers={"Cache-Control": "no-cache"})


@app.middleware("http")
async def shell_cache_control(request: Request, call_next):
    """Shell: index/entry points revalidate; hashed assets cache forever."""
    resp = await call_next(request)
    path = request.url.path
    if path in ("/", "/index.html"):
        resp.headers["Cache-Control"] = "no-cache"
    elif path.startswith("/assets/"):
        # Vite hashed filenames are content-addressed — safe to cache indefinitely
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
    return resp


@app.get("/{full_path:path}", include_in_schema=False)
async def spa_catch_all(full_path: str) -> Response:
    """Serve static asset if it exists, otherwise return index.html for SPA routing."""
    candidate = (SHELL_DIR / full_path).resolve()
    if candidate.is_file() and candidate.is_relative_to(SHELL_DIR.resolve()):
        return FileResponse(candidate)
    index = SHELL_DIR / "index.html"
    return FileResponse(index, headers={"Cache-Control": "no-cache"})


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
