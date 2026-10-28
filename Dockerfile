# ─── Stage 1: Frontend build ─────────────────────────────────────────────────
FROM node:20-slim AS frontend
WORKDIR /build/frontend
COPY frontend/package*.json ./
RUN npm ci --ignore-scripts
COPY frontend/ ./
RUN npm run build
# vite.config.ts → outDir: "../bff/shell" → output lands at /build/bff/shell/

# ─── Stage 2: Python runtime ──────────────────────────────────────────────────
FROM python:3.11-slim

WORKDIR /srv

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc && \
    rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY shared/ shared/
COPY api/ api/
COPY bff/ bff/
# Overlay the compiled frontend over the bff/ copy (from Stage 1)
COPY --from=frontend /build/bff/shell/ bff/shell/
COPY providers/ providers/
COPY workers/ workers/
COPY scripts/ scripts/
COPY sql/ sql/
COPY vendor/ProjectJLMirror/src/ vendor/ProjectJLMirror/src/

RUN pip install --no-cache-dir -e .

EXPOSE 8000 8080
