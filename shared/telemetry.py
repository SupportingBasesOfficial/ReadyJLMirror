"""Telemetry context — correlation propagation + structured logs (ADR-014).

One correlation id flows end to end:

    browser -> BFF (generate/extract) -> signed ctx -> API -> enqueue
    -> sync_operation claim -> worker logs -> provider read -> outbox

W3C `traceparent` is honored for OTel-compatible propagation — the
trace-id portion becomes our correlation id when present.

Structured output: JSON lines carrying the bound context so a
request/job/provider/event path is reconstructable without secrets.
Only whitelisted fields are emitted — secret-bearing context is never
loggable by construction.
"""

from __future__ import annotations

import contextvars
import json
import logging
import re
import secrets
import time
from contextlib import contextmanager

correlation_id_var: contextvars.ContextVar[str | None] = (
    contextvars.ContextVar("correlation_id", default=None))
tenant_id_var: contextvars.ContextVar[str | None] = (
    contextvars.ContextVar("tenant_id", default=None))
principal_id_var: contextvars.ContextVar[str | None] = (
    contextvars.ContextVar("principal_id", default=None))

_TRACEPARENT_RE = re.compile(
    r"^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$")


def new_correlation_id() -> str:
    return f"corr_{secrets.token_urlsafe(16)}"


def extract_correlation_id(headers) -> str:
    """traceparent trace-id > X-Correlation-Id > generate."""
    tp = headers.get("traceparent") if headers else None
    if tp:
        m = _TRACEPARENT_RE.match(tp.strip().lower())
        if m:
            return m.group(1)
    cid = headers.get("x-correlation-id") if headers else None
    return cid.strip() if cid and cid.strip() else new_correlation_id()


@contextmanager
def bind(**fields):
    """Bind telemetry context fields for the current logical unit.

    Only whitelisted names may be bound — secrets cannot become
    log context by accident.
    """
    allowed = {"correlation_id", "tenant_id", "principal_id"}
    tokens = []
    for name, value in fields.items():
        if name not in allowed or value is None:
            continue
        var = {
            "correlation_id": correlation_id_var,
            "tenant_id": tenant_id_var,
            "principal_id": principal_id_var,
        }[name]
        tokens.append((var, var.set(value)))
    try:
        yield
    finally:
        for var, tok in reversed(tokens):
            var.reset(tok)


def current_correlation_id() -> str | None:
    return correlation_id_var.get()


class JsonFormatter(logging.Formatter):
    """Single-line JSON log records with bound telemetry context."""

    def format(self, record: logging.LogRecord) -> str:
        doc = {
            "ts": self.formatTime(record, "%Y-%m-%dT%H:%M:%S%z"),
            "level": record.levelname,
            "logger": record.name,
            "msg": record.getMessage(),
        }
        cid = correlation_id_var.get()
        if cid:
            doc["correlation_id"] = cid
        tid = tenant_id_var.get()
        if tid:
            doc["tenant_id"] = tid
        pid = principal_id_var.get()
        if pid:
            doc["principal_id"] = pid
        if record.exc_info:
            doc["exc"] = self.formatException(record.exc_info)
        return json.dumps(doc, separators=(",", ":"), default=str)


def configure_structured_logging(level: str = "INFO") -> None:
    """Install the JSON formatter on the root handler — call once at
    each service entrypoint (api, bff, workers)."""
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    root = logging.getLogger()
    root.handlers[:] = [handler]
    root.setLevel(level.upper())
    # uvicorn's own handlers keep their format — normalize access logs
    for name in ("uvicorn", "uvicorn.access", "uvicorn.error"):
        lg = logging.getLogger(name)
        lg.handlers[:] = [handler]
        lg.propagate = False


def monotonic() -> float:
    return time.monotonic()
