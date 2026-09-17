# ReadyJLMirror

Runnable application stack for [JLMirror](https://github.com/SupportingBasesOfficial/ProjectJLMirror) — a specification-first enterprise monitoring and observability platform.

This repository contains **only the application code** (API, workers, Docker setup, tests). The domain primitives, ADRs, SQL schema, and governance are consumed as a git submodule from [`ProjectJLMirror`](https://github.com/SupportingBasesOfficial/ProjectJLMirror).

## Quickstart

### Prerequisites

- Python 3.11+
- Docker and Docker Compose (for the full stack)
- Git (with submodule support)

### Option 1 — Docker Compose (recommended)

```bash
# Clone with submodules
git clone --recursive https://github.com/SupportingBasesOfficial/ReadyJLMirror.git
cd ReadyJLMirror

# Copy environment template
cp .env.example .env

# Start the database and API
docker compose up -d db api

# Run migrations (one-time)
docker compose --profile migrate run --rm migrate

# Verify
curl http://localhost:8000/health
curl http://localhost:8000/docs
```

### Option 2 — Local development

```bash
# Clone with submodules
git clone --recursive https://github.com/SupportingBasesOfficial/ReadyJLMirror.git
cd ReadyJLMirror

# Install dependencies (includes ProjectJLMirror as local package)
pip install -e ".[dev]"

# Run the API
make dev

# Run tests
make test

# Run workers
make worker
```

## Architecture

```
ReadyJLMirror/
├── app/                    # Application code (this repo)
│   ├── main.py            # FastAPI entry point
│   ├── config.py          # Environment configuration
│   ├── db.py              # PostgreSQL pool + tenant context
│   ├── auth.py            # Development authority adapters
│   ├── tenant.py          # Development tenant context builder
│   ├── context.py         # Tenant context middleware
│   ├── routers/           # Domain API routers
│   │   ├── authority.py   # Session + fence endpoints
│   │   ├── monitoring.py  # Source planning + health projection
│   │   ├── async_ops.py   # Outbox operations
│   │   ├── observability.py # Reliability/observability joins
│   │   └── release.py     # Change outcome classification
│   └── workers/           # Background workers
│       ├── outbox_dispatcher.py
│       ├── validation.py
│       ├── reconciliation.py
│       └── run_all.py
├── vendor/ProjectJLMirror/ # Git submodule (specification + domain primitives)
│   ├── src/                # Python domain packages (jlmirror_*)
│   ├── sql/                # PostgreSQL schema (18k+ lines, RLS, SECURITY DEFINER)
│   ├── adr/                # 22 accepted ADRs
│   └── docs/               # 258 design documents
├── docker/                 # Docker init scripts
├── scripts/                # Migration runner
├── tests/                  # Integration tests
├── docker-compose.yml      # PostgreSQL + API + workers
├── Dockerfile              # Application image
├── pyproject.toml          # Python project metadata
└── Makefile                # Development commands
```

## API Endpoints

| Domain | Endpoint | Method | Description |
|---|---|---|---|
| Health | `/health` | GET | Liveness probe |
| Health | `/health/ready` | GET | Readiness probe (checks DB) |
| Authority | `/api/v1/auth/session/issue` | POST | Issue browser session |
| Authority | `/api/v1/auth/session/retire` | POST | Retire browser session |
| Authority | `/api/v1/fence/bootstrap` | POST | Bootstrap fence scope |
| Authority | `/api/v1/fence/acquire` | POST | Acquire next fence epoch |
| Authority | `/api/v1/fence/current/{id}` | GET | Get current fence state |
| Monitoring | `/api/v1/monitoring/sources/plan` | POST | Plan source creation |
| Monitoring | `/api/v1/monitoring/health/derive` | POST | Derive health decision |
| Async | `/api/v1/async/outbox/append` | POST | Append outbox message |
| Async | `/api/v1/async/outbox/claim-next` | POST | Claim next outbox message |
| Async | `/api/v1/async/outbox/mark-published` | POST | Mark message as published |
| Async | `/api/v1/async/outbox/pending` | GET | List pending messages |
| Observability | `/api/v1/observability/profiles` | GET | List reliability profiles |
| Observability | `/api/v1/observability/profiles/{id}` | GET | Get observability join |
| Release | `/api/v1/release/outcome/classify` | POST | Classify change outcome |
| Release | `/api/v1/release/outcomes` | GET | List outcome classes |

Interactive docs available at `/docs` (Swagger UI) and `/redoc`.

## Development Notes

### What is development mode?

The application starts with **in-memory authority adapters** (sessions, fences, outbox). These are suitable for local development and testing. They are **not production-safe** — they lose state on restart and provide no durability.

### What is production mode?

Set `APP_ENVIRONMENT=production`. The application will:
- Require database connectivity at startup
- Require all tenant context headers (no defaults)
- Disable hot reload

### Updating the submodule

When `ProjectJLMirror` is updated:

```bash
git submodule update --remote vendor/ProjectJLMirror
git add vendor/ProjectJLMirror
git commit -m "chore: update ProjectJLMirror submodule"
```

## Limitations

This is a runnable MVP. The following are **not yet implemented**:

- **Persistence**: Repositories connecting domain operations to PostgreSQL
- **Real identity**: Keycloak/OIDC integration (candidates in conformance)
- **Real broker**: Kafka integration (proposed, 4 closure conditions pending)
- **Frontend**: No web UI
- **Realtime**: WebSocket gateway (deferred per ADR-011)
- **Alerting/Notification/ITSM**: Not yet authorized per governance

See the [deep analysis](https://github.com/SupportingBasesOfficial/ProjectJLMirror) in the specification repository for the full roadmap.
