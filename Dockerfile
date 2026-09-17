FROM python:3.11-slim AS base

WORKDIR /app

# Install system dependencies for psycopg
RUN apt-get update && apt-get install -y --no-install-recommends \
    libpq-dev gcc && \
    rm -rf /var/lib/apt/lists/*

# Copy project files
COPY pyproject.toml ./
COPY app/ app/
COPY scripts/ scripts/
COPY tests/ tests/

# Copy the submodule (domain primitives)
COPY vendor/ProjectJLMirror/src/ vendor/ProjectJLMirror/src/
COPY vendor/ProjectJLMirror/pyproject.toml vendor/ProjectJLMirror/
COPY vendor/ProjectJLMirror/README.md vendor/ProjectJLMirror/

# Install the project
RUN pip install --no-cache-dir -e ".[dev]"

EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
