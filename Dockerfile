FROM python:3.11-slim AS base

WORKDIR /srv

RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc && \
    rm -rf /var/lib/apt/lists/*

COPY pyproject.toml ./
COPY shared/ shared/
COPY api/ api/
COPY bff/ bff/
COPY workers/ workers/
COPY scripts/ scripts/
COPY sql/ sql/
COPY vendor/ProjectJLMirror/src/ vendor/ProjectJLMirror/src/

RUN pip install --no-cache-dir -e .

EXPOSE 8000 8080
