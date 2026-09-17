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

## Monitoring vertical (Wave 4)

Real persistence + real Zabbix adapter, implementing the accepted
`validation_and_initial_sync` semantics:

- `POST /api/v1/monitoring/sources` — durable source creation (atomic
  idempotency row + generation + pending sync op, mirroring
  `monitoring.create_zabbix_source`)
- `GET /api/v1/monitoring/sources` / `/{id}` — tenant-scoped reads
- `workers/validation.py` — claims pending operations and runs the
  canonical `InitialValidationWorker`: CredentialResolver →
  OutboundAdmission → `hostgroup.get` → fenced complete (generation +
  revisions must still be current or completion fails closed)
- `providers/zabbix.py` — real JSON-RPC client (`hostgroup.get` and
  `host.get` with truncation detection), mapping Zabbix errors to the
  domain failure classes
- `POST /sources/{id}/inventory` + `GET /sources/{id}/resources` —
  enqueue `host_inventory_sync` and read canonical resources
- `workers/inventory.py` — canonical `HostInventoryWorker`:
  hostgroup.get (anchor visibility) → host.get (bounded snapshot)
  → fenced complete → `monitoring_resource` upsert + immutable
  snapshot/provider evidence; absent hosts become `removed` only on
  complete snapshots — degraded evidence never removes resources
- `POST /sources/{id}/metrics/poll` + `GET /sources/{id}/metrics` —
  `metric_definition_poll` ops carry (epoch, generation); completion
  requires the source to still sit at the predecessor generation, then
  the slot is consumed — strictly monotonic poll ordering
- `workers/metrics.py` — canonical `MetricDefinitionWorker`:
  item.get → `metric_definition` + `provider_binding` upsert; unseen
  definitions retire; items bound to non-canonical hosts reject the
  whole snapshot (`host_association_invalid`, fail closed); native
  value-type drift marks evidence `reconciliation_required`
- `POST /sources/{id}/current/poll` + `GET /sources/{id}/current` —
  `current_state_poll` ops with the same epoch/generation ordering;
  claim builds targets from pollable definitions (active + current
  binding + in_scope)
- `workers/current_state.py` — canonical `MetricCurrentStateWorker`:
  item.get `lastvalue/lastclock/lastns` → strict canonical parsing per
  value_kind → deduplicated observation acceptance →
  `metric_current_state` projection (advances only on newer provider
  clock) + immutable transitions; unreturned targets go `stale` —
  values are never fabricated
- `POST /sources/{id}/history/poll` (optional `time_from`/`time_till`,
  ≤24h window) + `GET /sources/{id}/history` + `GET
  /sources/{id}/history/streams` — `metric_history_sync` ops read
  bounded `history.get` windows grouped by Zabbix history value type
- `workers/history.py` — canonical `read_metric_history_window`:
  history.get (≤512 items, ≤20k rows, ≤24h window) → raw rows captured
  through a recording reader → repository-bound acceptance (dedup on
  provider clock) → immutable `metric_observation` reusing the
  acceptance identity → per-(item, value-type) stream checkpoints
  (`open`/`gap`/`reconciliation_required`/`finalized`, immutable gap
  evidence on truncated windows). The same pass projects
  `history_projection_state='pending'` acceptance envelopes — the
  History obligation carried by current-state acceptances
- `POST /sources/{id}/inventory` + `GET /sources/{id}/resources` —
  enqueue `host_inventory_sync` and read canonical resources
- `workers/inventory.py` — canonical `HostInventoryWorker`:
  hostgroup.get (anchor visibility) → host.get (bounded snapshot,
  truncation-detected via `limit: max+1`) → fenced complete →
  `monitoring_resource` upsert + immutable snapshot/provider evidence;
  absent hosts become `removed` only on complete snapshots — degraded
  evidence never removes resources (fail closed, no inference)
- `providers/credentials.py` — env-based dev resolver
  (`ZABBIX_CRED_<REF>`); production = OpenBao/secret manager
- `providers/egress.py` — dev egress admission (https +
  `EGRESS_ALLOW_HOSTS` allowlist); production = governed egress policy

## What this is NOT yet

- Not production-ready: dev HMAC trust (not SPIFFE), dev auth bypass flag, no real Zabbix/Kafka, no CSRF key ring rotation, dev realm passwords
- No problem/health/event ingestion yet (next Wave 4 slices), no Alerting/ITSM/Automation/AIOps — those remain governed by the canonical authorization chain

## Submodule

```bash
git submodule update --remote vendor/ProjectJLMirror   # pull latest spec
git add vendor/ProjectJLMirror && git commit -m "chore: update spec submodule"
```
