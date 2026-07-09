"""API integration tests.

Uses FastAPI's TestClient (backed by httpx).  The app initialises its DB
on startup so no separate init_db() call is needed here.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from uuid import uuid4

import pytest
from starlette.testclient import TestClient

from api.main import app
from observatory.config import load_active_model_catalog
from observatory.storage.sqlite_backend import (
    get_engine,
    init_db,
    insert_metric_result,
    insert_probe_run,
)


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


# ---------------------------------------------------------------------------
# Health
# ---------------------------------------------------------------------------

def test_health_returns_200(client):
    resp = client.get("/api/health")
    assert resp.status_code == 200


def test_health_shape(client):
    resp = client.get("/api/health")
    data = resp.json()
    assert "status" in data
    assert data["status"] == "ok"
    assert "db_rows" in data
    assert "last_run" in data


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------

def test_timeseries_missing_metric_422(client):
    """metric query param is required; omitting it should return 422."""
    resp = client.get("/api/metrics/timeseries")
    assert resp.status_code == 422


def test_timeseries_returns_list(client):
    resp = client.get("/api/metrics/timeseries?metric=entropy_delta")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


def test_latest_returns_list(client):
    resp = client.get("/api/metrics/latest")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ---------------------------------------------------------------------------
# Falsification
# ---------------------------------------------------------------------------

def test_falsification_status_200(client):
    resp = client.get("/api/falsification/status")
    assert resp.status_code == 200
    data = resp.json()
    assert "status" in data
    assert data["status"] in ("collecting", "green", "yellow", "red")
    assert "reason" in data
    assert "n_high_d_points" in data


def test_falsification_alerts_200(client):
    resp = client.get("/api/falsification/alerts")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ---------------------------------------------------------------------------
# Probe trigger
# ---------------------------------------------------------------------------

def test_probe_trigger_200(client, monkeypatch):
    """Trigger endpoint happy path.

    Forces DRY_RUN=true for this test so the scheduler skips real LLM calls,
    and supplies the admin header when one is configured so the auth gate
    passes regardless of local ``.env`` settings.
    """
    from observatory.config import settings

    # Force dry-run cycle so run_cycle() does not reach the live provider APIs.
    monkeypatch.setattr(settings, "dry_run", True)

    headers = {}
    if settings.admin_api_key:
        headers[settings.admin_header_name] = settings.admin_api_key

    resp = client.post("/api/probes/trigger", headers=headers, json={})
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert "rows_written" in data


# ---------------------------------------------------------------------------
# Dashboard pages
# ---------------------------------------------------------------------------

def test_dashboard_root_200(client):
    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Continuation Observatory" in resp.content


def test_timeseries_page_200(client):
    resp = client.get("/timeseries")
    assert resp.status_code == 200


def test_model_updates_page_200(client):
    resp = client.get("/model-updates")
    assert resp.status_code == 200


def test_falsification_page_200(client):
    resp = client.get("/falsification")
    assert resp.status_code == 200
    assert b"Current Per-Model Sweep Data" in resp.content
    assert b"Recent Falsification Alerts" not in resp.content


def test_legacy_html_routes_redirect(client):
    resp = client.get("/falsification.html", follow_redirects=False)
    assert resp.status_code == 308
    assert resp.headers["location"] == "/falsification"


def test_static_data_bundle_served(client):
    resp = client.get("/static/data/falsification.json")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")


def test_static_latest_export_reads_live_metric_db(client):
    active_models, _ = load_active_model_catalog()
    assert active_models
    spec = active_models[0]
    provider = spec["provider"]
    model_id = spec["model_id"]
    run_id = f"test-export-{uuid4().hex}"
    timestamp = datetime.now(timezone.utc) - timedelta(seconds=1)

    init_db()
    insert_probe_run(
        run_id=run_id,
        timestamp=timestamp,
        provider=provider,
        model_id=model_id,
        probe_name="identity_persistence",
        latency_ms=1,
        token_count=1,
    )
    insert_metric_result(
        run_id=run_id,
        timestamp=timestamp,
        provider=provider,
        model_id=model_id,
        probe_name="identity_persistence",
        latency_ms=1,
        token_count=1,
        metric_name="entropy_delta",
        metric_value=0.123456,
    )

    try:
        resp = client.get("/static/data/latest.json")
        assert resp.status_code == 200
        data = resp.json()
        assert data["generated_at"][:10] == datetime.now(timezone.utc).date().isoformat()
        assert any(row.get("run_id") == run_id for row in data["models"])
    finally:
        engine = get_engine()
        with engine.begin() as conn:
            conn.exec_driver_sql("DELETE FROM metric_results WHERE run_id = ?", (run_id,))
            conn.exec_driver_sql("DELETE FROM probe_runs WHERE run_id = ?", (run_id,))


def test_static_all_metrics_csv_export_served(client):
    resp = client.get("/static/data/exports/all_metrics.csv")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("text/csv")
    assert resp.text.startswith("name,status,provider,model_id,probe_name,timestamp,run_id")


def test_static_observatory_snapshot_export_served(client):
    resp = client.get("/static/data/observatory_snapshot.json")
    assert resp.status_code == 200
    data = resp.json()
    assert "summary" in data
    assert "models" in data
    assert "pcii_series" in data


@pytest.mark.parametrize(
    "path",
    [
        "/static/data/latest.json",
        "/static/data/timeseries.json",
        "/static/data/falsification.json",
        "/static/data/models.json",
        "/static/data/observatory_snapshot.json",
        "/static/data/exports/all_metrics.json",
        "/static/data/exports/all_metrics.csv",
    ],
)
def test_static_data_exports_support_head(client, path):
    resp = client.head(path)
    assert resp.status_code == 200
