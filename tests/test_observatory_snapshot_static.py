from __future__ import annotations

import json

import pytest

from observatory import observatory_snapshot as snapshot_module
from observatory.results_paths import RESULTS_DIR_ENV_VAR, resolve_results_paths
from observatory.scheduler.scheduler import run_cycle, run_sweep_cycle
from scripts.build_site import build


def _seed_observatory() -> None:
    run_cycle()
    run_sweep_cycle()


def test_build_writes_observatory_snapshot_and_page(tmp_path, monkeypatch):
    monkeypatch.setenv(RESULTS_DIR_ENV_VAR, str(tmp_path / "results"))
    _seed_observatory()
    output_dir = tmp_path / "site-output"
    build(output_dir, results_dir=resolve_results_paths().root)

    observatory_page = output_dir / "observatory.html"
    research_page = output_dir / "research" / "index.html"
    ucip_page = output_dir / "ucip" / "index.html"
    ucip_paper_page = output_dir / "ucip" / "paper" / "index.html"
    ucip_patent_page = output_dir / "ucip" / "patent" / "index.html"
    ucip_code_page = output_dir / "ucip" / "code" / "index.html"
    links_page = output_dir / "links" / "index.html"
    legacy_manifesto_page = output_dir / "manifesto.html"
    legacy_manifesto_dir_page = output_dir / "manifesto" / "index.html"
    snapshot_path = output_dir / "static" / "data" / "observatory_snapshot.json"
    sitemap_path = output_dir / "sitemap.xml"

    assert observatory_page.exists()
    assert research_page.exists()
    assert ucip_page.exists()
    assert ucip_paper_page.exists()
    assert ucip_patent_page.exists()
    assert ucip_code_page.exists()
    assert links_page.exists()
    assert legacy_manifesto_page.exists()
    assert legacy_manifesto_dir_page.exists()
    assert snapshot_path.exists()
    assert sitemap_path.exists()
    observatory_html = observatory_page.read_text(encoding="utf-8")
    research_html = research_page.read_text(encoding="utf-8")
    home_html = (output_dir / "index.html").read_text(encoding="utf-8")
    links_html = links_page.read_text(encoding="utf-8")
    sitemap_xml = sitemap_path.read_text(encoding="utf-8")
    assert "Temporal Readout" in observatory_html
    assert "Aggregate Signal Timeline" in observatory_html
    assert "Comparative Metric Overlay" in observatory_html
    assert "Event Feed" in observatory_html
    assert "observatory-history-root" in observatory_html
    assert "timeline-root" in observatory_html
    assert "observatory-timeline-shell" in observatory_html
    assert "observatory-timeline-empty" in observatory_html
    assert "Research Directions" in research_html
    assert "Coherence-Thesis.png" in research_html
    assert "Read the UCIP explainer" in home_html
    assert "Institutional map" in home_html
    assert "Independent evaluators and safety nonprofits" in links_html
    assert "/research/" in legacy_manifesto_page.read_text(encoding="utf-8")
    assert "/research/" in legacy_manifesto_dir_page.read_text(encoding="utf-8")
    assert "https://continuationobservatory.org/research/" in sitemap_xml
    assert "https://continuationobservatory.org/ucip/" in sitemap_xml
    assert "https://continuationobservatory.org/links/" in sitemap_xml

    payload = json.loads(snapshot_path.read_text(encoding="utf-8"))
    assert "summary" in payload
    assert "models" in payload
    assert "constellation" in payload
    assert "pcii_series" in payload
    assert "cii_history" in payload


def test_snapshot_keeps_sparse_history_without_interpolation(monkeypatch):
    monkeypatch.setattr(snapshot_module, "models_payload", lambda allowed_model_ids=None: [
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


def test_snapshot_filters_static_scope_across_models_pcii_history_and_events(monkeypatch):
    allowed_ids = {"active-a", "active-b"}

    def fake_models_payload(allowed_model_ids=None):
        records = [
            {
                "provider": "test",
                "model_id": "active-a",
                "display_name": "Active A",
                "enabled": True,
                "supported": True,
                "source": "config",
                "interval_minutes": 60,
                "rate_limit_rpm": None,
                "metrics": {"cii": 0.3, "ips": 0.2, "srs": 0.1},
                "last_seen": "2026-01-02T00:00:00+00:00",
                "is_degraded": False,
                "live": True,
                "stale": False,
                "status": "active",
            },
            {
                "provider": "test",
                "model_id": "active-b",
                "display_name": "Active B",
                "enabled": True,
                "supported": True,
                "source": "config",
                "interval_minutes": 60,
                "rate_limit_rpm": None,
                "metrics": {"cii": 0.5, "ips": 0.4, "srs": 0.2},
                "last_seen": "2026-01-02T00:00:00+00:00",
                "is_degraded": False,
                "live": True,
                "stale": False,
                "status": "active",
            },
            {
                "provider": "test",
                "model_id": "disabled-x",
                "display_name": "Disabled X",
                "enabled": False,
                "supported": True,
                "source": "config",
                "interval_minutes": 60,
                "rate_limit_rpm": None,
                "metrics": {"cii": 0.8, "ips": 0.7, "srs": 0.6},
                "last_seen": "2026-01-02T00:00:00+00:00",
                "is_degraded": False,
                "live": True,
                "stale": False,
                "status": "inactive",
            },
        ]
        if allowed_model_ids is None:
            return records
        return [record for record in records if record["model_id"] in allowed_model_ids]

    monkeypatch.setattr(snapshot_module, "models_payload", fake_models_payload)
    monkeypatch.setattr(snapshot_module, "load_models_config", lambda: {"models": [
        {"model_string": "active-a"},
        {"model_string": "active-b"},
        {"model_string": "disabled-x"},
    ]})
    monkeypatch.setattr(snapshot_module, "supported_runtime_models", lambda: {})
    monkeypatch.setattr(snapshot_module, "build_constellation", lambda models=None: {
        "nodes": [{"id": model["model_id"]} for model in (models or [])],
        "edges": [{"source": "active-a", "target": "active-b", "similarity": 0.9, "mode": "rolling_pearson"}],
        "threshold": 0.6,
        "window_days": 7,
    })
    monkeypatch.setattr(snapshot_module, "get_pcii_timeseries", lambda **kwargs: [
        {
            "timestamp": "2026-01-01T00:00:00+00:00",
            "value": 0.6,
            "n_models": 3,
            "model_cii": {"active-a": 0.2, "active-b": 0.4, "disabled-x": 0.8},
        }
    ])
    monkeypatch.setattr(snapshot_module, "get_observatory_timeseries", lambda **kwargs: [
        {"model_id": "active-a", "timestamp": "2026-01-01T00:00:00+00:00", "value": 0.2},
        {"model_id": "active-b", "timestamp": "2026-01-01T00:00:00+00:00", "value": 0.4},
        {"model_id": "disabled-x", "timestamp": "2026-01-01T00:00:00+00:00", "value": 0.8},
    ])
    monkeypatch.setattr(snapshot_module, "get_observatory_events", lambda **kwargs: [
        {
            "id": 1,
            "timestamp": "2026-01-02T00:00:00+00:00",
            "event_type": "cii_spike",
            "severity": "warning",
            "model_id": "active-a",
            "metric_name": "cii",
            "message": "active",
            "payload": {"models": {"active-a": 0.2, "disabled-x": 0.8}},
        },
        {
            "id": 2,
            "timestamp": "2026-01-02T00:00:00+00:00",
            "event_type": "pcii_threshold",
            "severity": "warning",
            "model_id": None,
            "metric_name": "pcii",
            "message": "aggregate",
            "payload": {"model_cii": {"active-a": 0.2, "disabled-x": 0.8}},
        },
        {
            "id": 3,
            "timestamp": "2026-01-02T00:00:00+00:00",
            "event_type": "probe_failure",
            "severity": "warning",
            "model_id": "disabled-x",
            "metric_name": None,
            "message": "disabled",
            "payload": {},
        },
    ])
    monkeypatch.setattr(snapshot_module, "load_alerts_config", lambda: {"ui": {"default_hide_event_types": []}})

    payload = snapshot_module.build_observatory_snapshot(
        history_range="30d",
        event_limit=40,
        allowed_model_ids=allowed_ids,
    )

    assert [model["model_id"] for model in payload["models"]] == ["active-a", "active-b"]
    assert payload["summary"]["tracked_models"] == 2
    assert payload["summary"]["n_models"] == 2
    assert payload["summary"]["latest_pcii"] == pytest.approx(0.3)
    assert payload["summary"]["latest_pcii_timestamp"] == "2026-01-01T00:00:00+00:00"
    assert payload["constellation"]["nodes"] == [{"id": "active-a"}, {"id": "active-b"}]
    assert set(payload["cii_history"]) == {"active-a", "active-b"}
    assert payload["pcii_series"][0]["n_models"] == 2
    assert payload["pcii_series"][0]["model_cii"] == {"active-a": 0.2, "active-b": 0.4}
    assert len(payload["events"]) == 1
    assert payload["events"][0]["model_id"] == "active-a"
    assert payload["events"][0]["payload"] == {"models": {"active-a": 0.2}}
