from __future__ import annotations

import json

from observatory import observatory_snapshot as snapshot_module
from observatory.scheduler.scheduler import run_cycle, run_sweep_cycle
from scripts.build_site import build


def _seed_observatory() -> None:
    run_cycle()
    run_sweep_cycle()


def test_build_writes_observatory_snapshot_and_page(tmp_path):
    _seed_observatory()
    output_dir = tmp_path / "site-output"
    build(output_dir)

    observatory_page = output_dir / "observatory.html"
    snapshot_path = output_dir / "static" / "data" / "observatory_snapshot.json"

    assert observatory_page.exists()
    assert snapshot_path.exists()
    observatory_html = observatory_page.read_text(encoding="utf-8")
    assert "Temporal Readout" in observatory_html
    assert "Aggregate Signal Timeline" in observatory_html
    assert "Comparative Metric Overlay" in observatory_html
    assert "Event Feed" in observatory_html
    assert "observatory-history-root" in observatory_html
    assert "timeline-root" in observatory_html
    assert "observatory-timeline-shell" in observatory_html
    assert "observatory-timeline-empty" in observatory_html

    payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert "summary" in payload
    assert "models" in payload
    assert "constellation" in payload
    assert "pcii_series" in payload
    assert "cii_history" in payload


def test_snapshot_keeps_sparse_history_without_interpolation(monkeypatch):
    monkeypatch.setattr(snapshot_module, "models_payload", lambda: [
        {
            "provider": "test",
            "model_id": "model-a",
            "display_name": "Model A",
            "enabled": True,
            "supported": True,
            "source": "runtime",
            "interval_minutes": 60,
            "rate_limit_rpm": None,
            "metrics": {"cii": 0.42, "ips": 0.31, "srs": 0.22},
            "last_seen": "2026-01-02T00:00:00+00:00",
            "is_degraded": False,
            "live": True,
            "stale": False,
            "status": "active",
        }
    ])
    monkeypatch.setattr(snapshot_module, "build_constellation", lambda models=None: {
        "nodes": [],
        "edges": [],
        "threshold": 0.6,
        "window_days": 7,
    })
    monkeypatch.setattr(snapshot_module, "get_pcii_timeseries", lambda **kwargs: [])
    monkeypatch.setattr(snapshot_module, "get_observatory_events", lambda **kwargs: [])
    monkeypatch.setattr(snapshot_module, "load_alerts_config", lambda: {"ui": {"default_hide_event_types": []}})
    monkeypatch.setattr(snapshot_module, "get_observatory_timeseries", lambda **kwargs: [
        {"model_id": "model-a", "timestamp": "2026-01-01T00:00:00+00:00", "value": 0.31},
        {"model_id": "model-a", "timestamp": "2026-01-02T00:00:00+00:00", "value": 0.42},
    ])

    payload = snapshot_module.build_observatory_snapshot()
    assert payload["cii_history"]["model-a"] == [
        {"timestamp": "2026-01-01T00:00:00+00:00", "value": 0.31},
        {"timestamp": "2026-01-02T00:00:00+00:00", "value": 0.42},
    ]
