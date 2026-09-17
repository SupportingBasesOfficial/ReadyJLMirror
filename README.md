# ReadyJLMirror

Runnable product implementation of [JLMirror](https://github.com/SupportingBasesOfficial/ProjectJLMirror) — a specification-first enterprise multi-tenant operations platform.

This repository implements the product slices authorized by the canonical specification. The specification itself (ADRs, domain primitives, SQL, governance) is consumed read-only as a git submodule at `vendor/ProjectJLMirror` — it is never modified here.

## Current slice: G1 — Identity + Tenant + Protected Shell

The first authorized product slice (`g1.identity-tenant-protected-shell@1`):

- **Confidential BFF** — OIDC Authorization Code Flow + PKCE S256, server-side token exchange
- **Opaque session capability** — browser holds only an opaque HttpOnly cookie; the handle's SHA-256 digest is the only persisted form
- **Durable session authority** — PostgreSQL (`g1.browser_sessions`); revocation survives restarts
- **CSRF double-submit** — token bound to the session row, required on all mutations
- **Tenant binding via membership** — `tenant_id` from the client is never authority; only active membership in an active tenant binds a session
- **Fail-closed** — unknown principals, revoked sessions, suspended tenants, stale/expired state all deny without existence leakage
- **Protected shell** — minimal UI with explicit states: `loading / unauthenticated / needs_tenant / ready / forbidden / unavailable`
- **Signed internal context** — BFF→API requests carry an HMAC-signed principal/session/tenant context (dev trust model; production = SPIFFE/SPIRE per D3 candidates)

## Quickstart

### Docker Compose (recommended)

```bash
git clone --recursive https://github.com/SupportingBasesOfficial/ReadyJLMirror.git
cd ReadyJLMirror
cp .env.example .env

docker compose up -d db keycloak migrate api bff

# Open http://localhost:8080 — sign in as alice / alice (dev realm)
```

Services:

| Service | Port | Purpose |
|---|---|---|
| `bff` | 8080 | Public boundary — shell + auth + API proxy |
| `keycloak` | 8180 | IdP (dev realm auto-imported) |
| `api` | internal | Protected API — signed-context only |
| `db` | 5432 | PostgreSQL 16 + TimescaleDB |
| `migrate` | — | Applies `sql/` migrations, exits |

### Local development (without Docker)

```bash
git clone --recursive https://github.com/SupportingBasesOfficial/ReadyJLMirror.git
cd ReadyJLMirror
pip install -e ".[dev]"

# Requires a local PostgreSQL with the G1 schema applied:
python -m scripts.migrate

# Dev auth bypass (no Keycloak needed for local iteration):
$env:DEV_AUTH_BYPASS="true"   # or export on Linux/macOS

# Terminal 1 — internal API
uvicorn api.main:app --port 8000

# Terminal 2 — BFF + shell (public boundary)
uvicorn bff.main:app --port 8080

# Open http://localhost:8080, then:
#   GET /auth/dev-login  (simulates the OIDC callback in dev)
```

## Architecture

```
browser ──► bff:8080 ──(signed ctx)──► api:8000
   │            │                         │
   │            ▼                         ▼
   │      g1.browser_sessions        g1.* (authority checks)
   │            │
   └──► keycloak:8180 (OIDC / realm: jlmirror)

workers/ — outbox dispatcher, validation, reconciliation (dev stubs)
sql/g1/ — G1 schema (tenants, principals, memberships, sessions, oidc states)
vendor/ProjectJLMirror/ — canonical spec + domain primitives (submodule)
```

## The shell states

| State | Meaning |
|---|---|
| `loading` | Session state being resolved |
| `unauthenticated` | No session or expired → "Sign in" |
| `needs_tenant` | Authenticated, pick a tenant |
| `ready` | Bound to a tenant; principal + role shown |
| `forbidden` | Membership revoked / tenant suspended — no existence leakage |
| `unavailable` | Infrastructure failure — fail closed |

## Security properties (G1 invariants)

- ID token validated against realm JWKS: signature, iss, aud, exp, nonce
- PKCE S256 enforced; OIDC `state` is a one-shot digest, consumed on use
- `sub`/`sid` are external references (`idp_subject_ref`/`idp_session_ref`), never platform IDs
- `resolve_or_provision_principal` JIT-provisions only in development; production fails closed
- Session `retired`/`expires_at` and principal `active` are re-checked on every protected call
- Cross-tenant denial returns a single `forbidden` shape — no membership enumeration

## Tests

```bash
python -m pytest tests/ -v
```

- `test_api.py` — domain sandbox endpoints (15 tests)
- `test_g1_unit.py` — digests, PKCE RFC 7636 vector, HMAC context signatures (7 tests)
- `test_g1_integration.py` — full G1 flow (7 tests; require running DB, skip otherwise)

## What this is NOT yet

- Not production-ready: dev HMAC trust (not SPIFFE), dev auth bypass flag, no real Zabbix/Kafka, no CSRF key ring rotation, dev realm passwords
- No Monitoring UI, Alerting, ITSM, Automation, AIOps — those slices remain governed by the canonical spec's authorization chain

## Submodule

```bash
git submodule update --remote vendor/ProjectJLMirror   # pull latest spec
git add vendor/ProjectJLMirror && git commit -m "chore: update spec submodule"
```
