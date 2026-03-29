from __future__ import annotations

from starlette.testclient import TestClient

from api.main import app
from observatory.scheduler.scheduler import run_cycle, run_sweep_cycle

client = TestClient(app)


def _seed_observatory() -> None:
    run_cycle()
    run_sweep_cycle()


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
    assert "constellation" in snapshot_payload
    assert "pcii_series" in snapshot_payload
    assert "cii_history" in snapshot_payload


def test_observatory_pages_render():
    _seed_observatory()
    resp = client.get("/observatory")
    assert resp.status_code == 200
    assert b"Continuation Observatory" in resp.content
    assert b"observatory-history-root" in resp.content

    resp = client.get("/")
    assert resp.status_code == 200
    assert b"Continuation Observatory" in resp.content


def test_observatory_websocket_subscription_and_broadcast():
    _seed_observatory()
    with client.websocket_connect("/ws/observatory") as websocket:
        websocket.send_json({"action": "subscribe", "channels": ["events", "metrics", "pcii"]})
        ack = websocket.receive_json()
        assert ack["channel"] == "system"
        client.post("/api/probes/trigger", json={})
        message = websocket.receive_json()
        assert message["channel"] in {"events", "metrics", "pcii"}
