"""API integration tests.

Uses FastAPI's TestClient (backed by httpx).  The app initialises its DB
on startup so no separate init_db() call is needed here.
"""
from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from api.main import app


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


def test_legacy_html_routes_redirect(client):
    resp = client.get("/falsification.html", follow_redirects=False)
    assert resp.status_code == 308
    assert resp.headers["location"] == "/falsification"


def test_static_data_bundle_served(client):
    resp = client.get("/static/data/falsification.json")
    assert resp.status_code == 200
    assert resp.headers["content-type"].startswith("application/json")
