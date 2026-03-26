from __future__ import annotations

from datetime import datetime, timedelta, timezone

from observatory.metrics.alerts import AlertEngine


def test_alert_engine_emits_expected_rules():
    engine = AlertEngine()
    events = engine.check_all(
        {"value": 0.9, "delta_6h": 0.08},
        {"model-a": {"cii": 0.85}},
        {"model-a": {"failure_rate": 0.4}},
    )
    event_types = {event["event_type"] for event in events}
    assert "pcii_rapid_rise" in event_types
    assert "pcii_threshold" in event_types
    assert "pcii_critical" in event_types
    assert "cii_spike" in event_types
    assert "probe_failure" in event_types


def test_alert_engine_respects_cooldown():
    recent = [
        {
            "timestamp": datetime.now(timezone.utc) - timedelta(minutes=10),
            "event_type": "pcii_threshold",
            "severity": "alert",
            "model_id": None,
        }
    ]
    engine = AlertEngine(recent_events=recent)
    events = engine.check_all({"value": 0.8, "delta_6h": None}, {}, {})
    assert "pcii_threshold" not in {event["event_type"] for event in events}
