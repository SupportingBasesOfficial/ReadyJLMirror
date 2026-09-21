# ReadyJLMirror

Runnable product implementation of [JLMirror](https://github.com/SupportingBasesOfficial/ProjectJLMirror) — a specification-first enterprise multi-tenant operations platform.

This repository implements the product slices authorized by the canonical specification. The specification itself (ADRs, domain primitives, SQL, governance) is consumed read-only as a git submodule at `vendor/ProjectJLMirror` — it is never modified here.

## Implemented slices

| Slice | What it delivers |
|---|---|
| G1 identity/tenant/shell | OIDC BFF, durable sessions, RLS tenant isolation, CSRF |
| Monitoring Wave 4 | sources → validation → inventory → metrics → current → history → problems → health → outbox, all durable with evidence states |
| Alerting core model | `alerting.alert` + immutable transitions, closed source-kind law, policy evidence required |
| Publication bridge | atomic outbox obligations on problem/health transitions |
| G6 transport consumer | `alerting.inbox_receipt` dedup + envelope validation + Monitoring owner reread -> durable resync completion (never Alert mutation) |
| G7 alert policy lifecycle | immutable policy versions, explicit effective selection, alert pinned to exact version, idempotent evaluation, fail-closed stale evidence |
| G8 human operations | assign / ACK / atomic reassign, current-action projection, immutable timeline, native visibility requirement + receipt (exact viewer only) |
| G9 notification delivery | `whatsapp_business@1` intent -> durable outbox -> immutable attempts -> HMAC callbacks -> monotonic delivery projection, bounded retry + fallback-required |
| G10 ITSM incidents | Incident independent of Alert (create only on admitted active alert), open -> in_progress -> resolved -> closed (no reopen), assignment history + immutable comments, durable provider-neutral sync outbox with claim lease, bounded retry, lease-expiry reconcile to `unknown`, external ticket refs as evidence only |
| Ops surface | DLQ visibility + operator requeue, worker heartbeat, readiness with declared failure modes, audit trail, backup/restore rehearsal, chaos matrix, SLO probe, DNS-pinned egress |
| Security | mounted-file secrets, OpenBao dev backend, TLS + opt-in mTLS, least-privilege roles, direct-SQL escape battery |

## G1 — Identity + Tenant + Protected Shell

The first authorized product slice (`g1.identity-tenant-protected-shell@1`):

- **Confidential BFF** — OIDC Authorization Code Flow + PKCE S256, server-side token exchange
- **Opaque session capability** — browser holds only an opaque HttpOnly cookie; the handle's SHA-256 digest is the only persisted form
- **Durable session authority** — PostgreSQL (`g1.browser_sessions`); revocation survives restarts
- **CSRF double-submit** — token bound to the session row, required on all mutations
- **Tenant binding via membership** — `tenant_id` from the client is never authority; only active membership in an active tenant binds a session
- **Tenant isolation at the DB** — `monitoring.*` is ENABLE+FORCE RLS;
  `jlmirror_app` (api/bff) only sees rows where
  `jlmirror.tenant_id` session GUC matches; `jlmirror_worker`
  (BYPASSRLS) carries system authority for fenced ops;
  `jlmirror_owner` retains migration authority. `db_tenant_connection`
  sets/resets the GUC around every tenant-scoped request
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
| `db` | 5434 | PostgreSQL 16 + TimescaleDB |
| `migrate` | — | Applies `sql/` migrations, exits |
| `worker` | — | Continuous pipeline (`--profile worker`) |
| `openbao` | 8200 | Dev secret backend (`--profile secrets`) |

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
- `POST /sources/{id}/problems/poll` + `GET /sources/{id}/problems`
  (`?active_only=`) — `problem_state_sync` ops require source evidence
  `current` and a volatile fail-closed recovery admission per poll epoch
- `workers/problem_state.py` — canonical `collect_problem_state`:
  trigger.get selectHosts refreshes trigger→resource bindings →
  problem.get active problems (bounded, r_eventid='0', dedup eventid) →
  recovery evidence (r_eventid/r_clock) → stable canonical `problem_id`
  binding (provider eventid never becomes canonical identity) →
  `monitoring_problem` projection + immutable transitions
  (`provider_positive`, `severity_change`, `provider_recovery`,
  `authoritative_negative`); resolved problems never reopen under the
  same event identity; omission resolves only on a proven-complete
  snapshot — incomplete snapshots mark actives `reconciliation_required`
- `GET /sources/{id}/health` + `POST /health/run` (dev sweep) —
  `workers/health.py` derives per-resource health with the canonical
  `derive_health` from Monitoring state only (source currentness,
  resource presence/scope, complete problem snapshot evidence, active
  problem severities) → `health_projection` + immutable transitions;
  `healthy` requires 'current' evidence and no health-affecting active
  problem (also enforced by the DB projection guard)
- `GET /outbox/messages` + `POST /outbox/run` (dev) — durable
  transactional outbox: problem state changes and health changes append
  `domain_event` rows inside the same transaction as the projection
  mutation; `workers/outbox_dispatcher.py` claims pending rows (lease +
  SKIP LOCKED), publishes to `ALERTING_WEBHOOK_URL` (or dev-log receipt
  when unset), and quarantines after 5 attempts — publication can never
  diverge from platform truth
- `providers/credentials.py` — env-based dev resolver
  (`ZABBIX_CRED_<REF>`); production = OpenBao/secret manager
- `providers/egress.py` — fail-closed egress admission: https +
  required `EGRESS_ALLOW_HOSTS` allowlist + DNS screen blocking
  non-public targets (`EGRESS_ALLOW_PRIVATE_IPS` for intranet);
  production = governed egress policy engine

## Operations

- **Sync ops / DLQ** — `GET /sources/{id}/operations` lists durable
  operation state including `reconciliation_required` and
  `failed_terminal`; `POST /sources/{id}/operations/{op_id}/requeue`
  is the operator reconciliation path (guarded SECURITY DEFINER —
  the app role keeps no-UPDATE on operation state)
- **Worker heartbeat** — `monitoring.worker_heartbeat` upserts every
  tick; `monitoring.worker_alive(max_age)` exposes staleness to
  readiness
- **Readiness** — API `/health/ready` reports database (fail_closed)
  + workers (degraded); BFF `/health/ready` reports db + api
- **Audit trail** — `audit.audit_event`, append-only and FORCE RLS,
  written in the same transaction as source creation, operation
  requeue and every alert transition;
  `GET /api/v1/observability/audit-events`
- **Backup/DR** — `python -m scripts.backup` (dump + watermark
  manifest), `python -m scripts.restore_verify` (restores into an
  isolated scratch DB, checks invariants, drops it — never touches
  live). Runbook: `docs/runbooks/disaster-recovery.md`
- **Alerting (G7)** — `POST/GET /api/v1/alerting/policies[/versions]`
  + `/effective` for the immutable policy lifecycle;
  `GET /api/v1/alerting/alerts[/{id}[/timeline]]` for alerts pinned
  to the exact policy version that produced them
- **Human ops (G8)** — `POST /alerts/{id}/assign|ack` (reassign is
  atomic), `POST /alerts/{id}/visibility-requirements` +
  `POST /visibility-requirements/{id}/receipts`; timeline and
  current-action projection derive from immutable facts
- **Notifications (G9)** — `POST /alerts/{id}/notifications` creates
  an immutable `whatsapp_business@1` intent + durable outbox entry;
  the worker dispatches through the WhatsApp adapter (dev: BFF sink
  at `/dev/whatsapp`); provider callbacks POST to
  `/api/v1/alerting/notifications/callback` with an HMAC-SHA256
  signature over the raw body (replayed, forged, stale-timestamp or
  unbindable callbacks are durably poisoned, never become evidence);
  `GET /notifications[/{id}]` exposes the monotonic delivery
  projection — sent ≠ accepted ≠ delivered ≠ external read, and
  none of them is the G8 native view
- **Administration** — `GET/POST /api/v1/tenant/members[/{id}/revoke]`
  and `/tenant/roles[/{name}/retire]` (gate: `tenant:read` /
  `tenant:admin`); `GET /api/v1/platform/organizations` and
  `/delegated-grants` require a `platform_admin_principal`; the
  shell renders members + custom roles with add/revoke/retire
  controls and a read-only platform block
- **ITSM incidents (G10)** — `POST /alerts/{id}/incidents`,
  `GET /alerts/{id}/incidents`, `GET /incidents/{id}`,
  `POST /incidents/{id}/transition|assignments|comments`; every
  mutation goes through canonical `itsm.g10_*` SECURITY DEFINER
  functions — `jlmirror_app`/`jlmirror_worker` hold zero `itsm.*`
  table privilege and only the EXECUTE grants of their invoker
  roles; the worker claims the durable sync outbox (lease, bounded
  retry to 3 attempts, expired lease reconciles to `unknown`) and
  writes external ticket linkage as evidence — provider state never
  mutates the Incident
- **G6 inbox** — `workers/alerting_transport.py` consumes the two
  accepted outbox contracts: envelope validation -> create-or-observe
  receipt -> Monitoring owner reread -> durable resync completion;
  `GET /api/v1/alerting/inbox` shows receipt diagnostics
- **Chaos matrix** — `python -m scripts.chaos_matrix` injects each
  dependency failure and asserts the declared mode (db fail_closed,
  api degraded, worker stale heartbeat, keycloak session-survival)
- **SLO probe** — `GET /api/v1/observability/slo` latency/error
  distribution per endpoint
- **DNS-pinned egress** — admission resolves once, screens and pins
  the admitted IP; the transport connects to the IP with Host/SNI
  bound (no rebind TOCTOU)

## What this is NOT yet

- Not production-ready: dev HMAC trust (not SPIFFE), dev auth bypass flag, dev realm passwords, no CSRF key ring rotation
- Boundary secrets fail closed outside development: `db_password`, `BFF_INTERNAL_SECRET`, `KEYCLOAK_CLIENT_SECRET` and `NOTIFICATION_CALLBACK_SECRET` must resolve via mounted file or env — the dev literal is rejected (`APP_ENVIRONMENT != development`)
- Callback tenant routing is binding-derived: `notification.provider_ref_binding` (written at dispatch completion) maps the provider's message ref to `(tenant, intent)` — the callback payload never asserts a tenant and there is no global tenant fallback; unbindable callbacks park as poisoned under the `platform` pseudo-tenant
- WhatsApp adapter defaults to the dev sink — production needs the real provider URL + token via credential binding and a rotated `NOTIFICATION_CALLBACK_SECRET`
- The G10 ITSM adapter defaults to a simulated provider (deterministic `dev-ticket-*` refs); production needs `ITSM_PROVIDER_URL` pointing at a governed bridge plus a credential binding
- Automation, AIOps and further governance slices remain governed by the canonical authorization chain — not implemented until authorized

## Submodule

```bash
git submodule update --remote vendor/ProjectJLMirror   # pull latest spec
git add vendor/ProjectJLMirror && git commit -m "chore: update spec submodule"
```
