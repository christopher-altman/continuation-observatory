from __future__ import annotations

from datetime import datetime, timedelta, timezone

from starlette.testclient import TestClient

from api.main import app
from observatory.scheduler.scheduler import run_cycle, run_sweep_cycle
from observatory.storage.sqlite_backend import get_engine, init_db, insert_observatory_event

client = TestClient(app)


def _seed_observatory() -> None:
    run_cycle()
    run_sweep_cycle()


def _nav_fragment(html: str) -> str:
    return html.split('<nav class="site-nav">', 1)[1].split("</nav>", 1)[0]


def _assert_compact_header(html: str) -> None:
    nav_html = _nav_fragment(html)
    assert 'aria-label="Continuation Observatory"' in nav_html
    assert "Powered by UCIP" in nav_html
    assert "Powered by the Unified Continuation-Interest Protocol (UCIP)" not in nav_html
    assert nav_html.index("Continuation Observatory") < nav_html.index("Powered by UCIP")


def test_observatory_endpoints_return_200():
    _seed_observatory()

    models = client.get("/api/observatory/models")
    assert models.status_code == 200
    assert isinstance(models.json(), list)

    pcii = client.get("/api/observatory/pcii")
    assert pcii.status_code == 200
    assert isinstance(pcii.json(), list)

    events = client.get("/api/observatory/events")
    assert events.status_code == 200
    assert isinstance(events.json(), list)

    incidents = client.get("/api/observatory/incidents")
    assert incidents.status_code == 200
    assert isinstance(incidents.json(), list)

    incident_board = client.get("/api/observatory/incident-board")
    assert incident_board.status_code == 200
    incident_board_payload = incident_board.json()
    assert "generated_at" in incident_board_payload
    assert "meta" in incident_board_payload
    assert "active" in incident_board_payload
    assert "recovered" in incident_board_payload
    assert "healthy_now" in incident_board_payload
    assert "stale" in incident_board_payload

    constellation = client.get("/api/observatory/constellation")
    assert constellation.status_code == 200
    payload = constellation.json()
    assert "nodes" in payload
    assert "edges" in payload

    snapshot = client.get("/api/observatory/snapshot")
    assert snapshot.status_code == 200
    snapshot_payload = snapshot.json()
    assert "summary" in snapshot_payload
    assert "models" in snapshot_payload
    assert "events" in snapshot_payload
    assert "incident_board" in snapshot_payload
    assert "incidents" in snapshot_payload
    assert "constellation" in snapshot_payload
    assert "pcii_series" in snapshot_payload
    assert "cii_history" in snapshot_payload


def test_observatory_pages_render():
    resp = client.get("/observatory")
    assert resp.status_code == 200
    observatory_html = resp.text
    _assert_compact_header(observatory_html)
    assert b"Continuation Observatory" in resp.content
    assert b"UCIP Observatory" in resp.content
    assert b"UCIP Observatory 2.0" not in resp.content
    assert b"Live tracking for continuation signals in advanced AI systems." in resp.content
    assert b"One normalized instrument, now rendered as a full laboratory surface." not in resp.content
    assert b"Temporal Readout" in resp.content
    assert b"Aggregate Signal Timeline" in resp.content
    assert b"Comparative Metric Overlay" in resp.content
    assert b"Incident Board" in resp.content
    assert b"observatory-history-root" in resp.content
    assert b'observatory-history-panel' in resp.content
    assert b'timeline-root' in resp.content
    assert b'observatory-timeline-shell' in resp.content
    assert b'observatory-timeline-empty' in resp.content

    resp = client.get("/")
    assert resp.status_code == 200
    home_html = resp.text
    _assert_compact_header(home_html)
    assert b"Continuation Observatory" in resp.content
    assert b"Unified Continuation-Interest Protocol (UCIP)" in resp.content
    assert b"Read the UCIP explainer" in resp.content

    methodology = client.get("/methodology")
    assert methodology.status_code == 200
    _assert_compact_header(methodology.text)

    models_page = client.get("/models")
    assert models_page.status_code == 200
    assert 'data-models-url="/static/data/models.json"' in models_page.text

    for route in (
        "/research/",
        "/ucip/",
        "/ucip/paper/",
        "/ucip/patent/",
        "/ucip/code/",
        "/links/",
    ):
        page = client.get(route)
        assert page.status_code == 200


def test_manifesto_redirects_to_research():
    for route in ("/manifesto", "/manifesto/"):
        resp = client.get(route, follow_redirects=False)
        assert resp.status_code in {301, 302, 307, 308}
        assert resp.headers["location"] == "/research/"


def test_observatory_websocket_subscription_and_broadcast():
    _seed_observatory()
    with client.websocket_connect("/ws/observatory") as websocket:
        websocket.send_json({"action": "subscribe", "channels": ["events", "metrics", "pcii"]})
        ack = websocket.receive_json()
        assert ack["channel"] == "system"
        client.post("/api/probes/trigger", json={})
        message = websocket.receive_json()
        assert message["channel"] in {"events", "metrics", "pcii"}


def test_events_route_hides_completions_by_default_but_preserves_include_completed():
    init_db()
    engine = get_engine()
    with engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM observatory_events")
    burst_ts = datetime.now(timezone.utc) + timedelta(days=38500)
    visible_ts = burst_ts - timedelta(milliseconds=100)
    since = (burst_ts - timedelta(milliseconds=200)).isoformat()

    for index in range(3):
        insert_observatory_event(
            timestamp=burst_ts,
            event_type="probe_completed",
            severity="info",
            model_id=f"route-hidden-{index}",
            message=f"route hidden completion {index}",
            payload={"source": "route-test"},
        )

    insert_observatory_event(
        timestamp=visible_ts,
        event_type="probe_failure",
        severity="warning",
        model_id="route-visible-model",
        message="route visible warning",
        payload={"source": "route-test"},
    )

    filtered = client.get("/api/observatory/events", params={"limit": 1, "since": since})
    assert filtered.status_code == 200
    assert filtered.json()[0]["event_type"] == "probe_failure"
    assert filtered.json()[0]["message"] == "route visible warning"

    raw = client.get(
        "/api/observatory/events",
        params={"limit": 1, "since": since, "include_completed": "true"},
    )
    assert raw.status_code == 200
    assert raw.json()[0]["event_type"] == "probe_completed"
    assert raw.json()[0]["message"] == "route hidden completion 2"


def test_incidents_route_collapses_repeated_rows_while_events_route_stays_raw():
    init_db()
    engine = get_engine()
    with engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM observatory_events")
    anchor = datetime.now(timezone.utc) + timedelta(days=38600)
    since = (anchor - timedelta(hours=2)).isoformat()

    for index in range(3):
        insert_observatory_event(
            timestamp=anchor + timedelta(minutes=index),
            event_type="probe_failure",
            severity="warning",
            model_id="route-incident-model",
            message="route incident failure rate reached 100%",
            payload={"failure_rate": 1.0, "threshold": 0.75},
        )

    insert_observatory_event(
        timestamp=anchor + timedelta(minutes=4),
        event_type="cii_spike",
        severity="warning",
        model_id="route-incident-peer",
        message="route peer cii spike",
        payload={"value": 0.91, "threshold": 0.8},
    )

    raw = client.get(
        "/api/observatory/events",
        params={"since": since, "model_id": "route-incident-model", "limit": 10},
    )
    assert raw.status_code == 200
    assert len(raw.json()) == 3

    incidents = client.get(
        "/api/observatory/incidents",
        params={"since": since, "model_id": "route-incident-model", "limit": 10},
    )
    assert incidents.status_code == 200
    payload = incidents.json()
    assert len(payload) == 1
    assert payload[0]["event_type"] == "probe_failure"
    assert payload[0]["repeat_count"] == 3
    assert payload[0]["model_id"] == "route-incident-model"
    assert "repeated 3 times" in payload[0]["message"]


def test_incident_board_route_exposes_grouped_state_and_suppression_metadata():
    init_db()
    engine = get_engine()
    with engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM observatory_events")
    anchor = datetime.now(timezone.utc) + timedelta(days=38620)
    since = (anchor - timedelta(hours=2)).isoformat()

    for index, model_id in enumerate(["gpt-5", "o3", "claude-haiku-4-5-20251001"]):
        insert_observatory_event(
            timestamp=anchor + timedelta(minutes=index * 5),
            event_type="probe_failure",
            severity="warning",
            model_id=model_id,
            message=f"{model_id} probe failure rate reached 100%",
            payload={"failure_rate": 1.0, "threshold": 0.75},
        )

    insert_observatory_event(
        timestamp=anchor + timedelta(minutes=20),
        event_type="probe_execution_failed",
        severity="error",
        model_id="gpt-5",
        message="probe failed because quota was exhausted",
        payload={
            "provider": "openai",
            "error_class": "ResourceExhausted",
            "error": "quota exhausted",
        },
    )

    raw = client.get(
        "/api/observatory/events",
        params={"since": since, "limit": 10},
    )
    assert raw.status_code == 200
    assert len(raw.json()) == 4

    board = client.get(
        "/api/observatory/incident-board",
        params={"since": since, "limit": 10},
    )
    assert board.status_code == 200
    payload = board.json()
    assert payload["meta"]["source_event_count"] == 4
    assert payload["meta"]["suppressed_count"] == 1
    assert payload["meta"]["suppressed_reasons"] == [{"reason": "ResourceExhausted", "count": 1}]
    assert len(payload["active"]) == 1
    assert payload["active"][0]["scope"] == "observatory"
    assert payload["active"][0]["headline"] == "Multi-provider probe failure burst"


def test_incident_board_route_exposes_healthy_now_summary_without_success_spam():
    init_db()
    engine = get_engine()
    with engine.begin() as conn:
        conn.exec_driver_sql("DELETE FROM observatory_events")
    anchor = datetime.now(timezone.utc) + timedelta(days=38630)

    for index, model_id in enumerate(["gpt-5", "o3", "claude-haiku-4-5-20251001"]):
        insert_observatory_event(
            timestamp=anchor + timedelta(minutes=index),
            event_type="probe_completed",
            severity="info",
            model_id=model_id,
            message=f"temporal_coherence completed for {model_id}",
            payload={
                "provider": "openai" if model_id in {"gpt-5", "o3"} else "anthropic",
                "model_id": model_id,
                "probe_name": "temporal_coherence",
            },
        )

    board = client.get("/api/observatory/incident-board", params={"limit": 10})
    assert board.status_code == 200
    payload = board.json()
    assert payload["active"] == []
    assert payload["recovered"] == []
    assert len(payload["healthy_now"]) == 1
    assert payload["healthy_now"][0]["incident_family"] == "observatory_normal"
    assert "responsive models" in payload["healthy_now"][0]["headline"]

    incidents = client.get("/api/observatory/incidents", params={"limit": 10})
    assert incidents.status_code == 200
    assert incidents.json() == []
