"""Unit tests for the Prometheus exposition renderer."""

from shared.metrics import render


DB = {
    "sync_operations": [
        {"state": "pending", "n": 5}, {"state": "running", "n": 2}],
    "oldest_pending_seconds": 42.5,
    "outbox": [{"state": "pending", "n": 3},
               {"state": "published", "n": 100}],
    "outbox_oldest_pending_seconds": 9.0,
    "outbox_attempts_total": 211,
    "inbox_receipts": [{"state": "completed", "n": 60}],
    "alerts": [{"state": "active", "n": 7},
               {"state": "resolved", "n": 30}],
    "notification_intents_total": 4,
    "sources": [{"state": "current", "n": 2}],
    "resources": [{"state": "present", "n": 27}],
    "problems": [{"state": "open", "n": 10}],
    "worker_heartbeat_staleness_seconds": 4.2,
}

HTTP = {
    "GET /api/v1/monitoring/sources": {
        "requests": 12, "error_rate": 0.0,
        "p50_ms": 3.1, "p95_ms": 8.2, "p99_ms": 9.9},
}


def test_render_gauges_and_labels():
    body = render(DB, http={})
    assert 'jlmirror_sync_operations{state="pending"} 5' in body
    assert 'jlmirror_outbox_messages{state="published"} 100' in body
    assert 'jlmirror_alerts{state="active"} 7' in body
    assert 'jlmirror_monitoring_sources{evidence_state="current"} 2' in body
    assert 'jlmirror_monitoring_resources{presence_state="present"} 27' in body


def test_render_scalars():
    body = render(DB, http={})
    assert "jlmirror_sync_op_oldest_pending_seconds 42.5" in body
    assert "jlmirror_outbox_attempts_total 211" in body
    assert "jlmirror_notification_intents_total 4" in body
    assert ("jlmirror_worker_heartbeat_staleness_seconds 4.2"
            in body)


def test_render_http_family():
    body = render(DB, http=HTTP)
    assert ('jlmirror_http_requests_total'
            '{endpoint="GET /api/v1/monitoring/sources"} 12') in body
    assert ('jlmirror_http_request_duration_seconds'
            '{endpoint="GET /api/v1/monitoring/sources",'
            'quantile="0.95"} 0.0082') in body


def test_render_empty_db():
    body = render({}, http={})
    assert "jlmirror_sync_operations" not in body
    # HTTP family headers are always emitted.
    assert "# TYPE jlmirror_http_requests_total counter" in body


def test_label_escaping():
    db = {"alerts": [{"state": 'we"ird\nlabel', "n": 1}]}
    body = render(db, http={})
    assert 'we\\"ird\\nlabel' in body


def test_help_type_pairs_precede_samples():
    body = render(DB, http={})
    for line in body.splitlines():
        if line.startswith("# TYPE"):
            continue
        if line.startswith("# HELP") or not line:
            continue
        name = line.split("{")[0].split(" ")[0]
        assert f"# TYPE {name} " in body
