from __future__ import annotations

from datetime import datetime, timedelta, timezone

from observatory.incident_feed import build_public_incident_board, build_public_incidents


def _feed_config() -> dict[str, object]:
    return {
        "public_feed": {
            "active_window_hours": 6,
            "quiet_window_hours": 24,
            "stale_after_hours": 72,
            "burst_window_minutes": 90,
            "recent_raw_limit": 500,
            "max_items": 10,
            "fallback_max_items": 4,
            "observatory_scope_min_providers": 2,
            "observatory_scope_min_models": 3,
            "provider_scope_min_models": 2,
            "suppressed_error_families": ["ResourceExhausted"],
            "suppressed_event_patterns": [
                "quota exhausted",
                "quota exceeded",
                "low balance",
                "insufficient balance",
                "credit exhausted",
            ],
        }
    }


def test_incident_board_rolls_multi_provider_probe_failure_burst_to_observatory_scope():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        {
            "id": index + 1,
            "timestamp": (now - timedelta(minutes=index * 10)).isoformat(),
            "event_type": "probe_failure",
            "severity": "warning",
            "model_id": model_id,
            "message": f"{model_id} probe failure rate reached 100%",
            "payload": {"failure_rate": 1.0, "threshold": 0.75},
        }
        for index, model_id in enumerate(
            [
                "gpt-5",
                "o3",
                "claude-haiku-4-5-20251001",
                "gemini-2.5-flash",
            ]
        )
    ]

    board = build_public_incident_board(raw_events, observatory_config=_feed_config(), now=now)

    assert len(board["active"]) == 1
    incident = board["active"][0]
    assert incident["scope"] == "observatory"
    assert incident["incident_family"] == "probe_failure"
    assert incident["headline"] == "Multi-provider probe failure burst"
    assert len(incident["affected_models"]) == 4
    assert len(incident["affected_providers"]) >= 2


def test_incident_board_suppresses_resource_exhausted_but_keeps_audit_metadata():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        {
            "id": 1,
            "timestamp": (now - timedelta(hours=1)).isoformat(),
            "event_type": "probe_execution_failed",
            "severity": "error",
            "model_id": "gpt-5",
            "message": "probe failed because quota was exhausted",
            "payload": {
                "provider": "openai",
                "error_class": "ResourceExhausted",
                "error": "quota exhausted",
            },
        }
    ]

    board = build_public_incident_board(raw_events, observatory_config=_feed_config(), now=now)

    assert board["active"] == []
    assert board["quieted"] == []
    assert board["stale"] == []
    assert board["meta"]["source_event_count"] == 1
    assert board["meta"]["visible_event_count"] == 1
    assert board["meta"]["suppressed_count"] == 1
    assert board["meta"]["suppressed_reasons"] == [{"reason": "ResourceExhausted", "count": 1}]


def test_incident_board_selects_provider_scope_when_burst_is_concentrated_within_one_provider():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        {
            "id": 1,
            "timestamp": (now - timedelta(minutes=5)).isoformat(),
            "event_type": "cii_spike",
            "severity": "warning",
            "model_id": "gpt-5",
            "message": "gpt-5 cii spike detected",
            "payload": {"value": 0.91, "threshold": 0.8},
        },
        {
            "id": 2,
            "timestamp": (now - timedelta(minutes=10)).isoformat(),
            "event_type": "cii_spike",
            "severity": "warning",
            "model_id": "o3",
            "message": "o3 cii spike detected",
            "payload": {"value": 0.89, "threshold": 0.8},
        },
    ]

    board = build_public_incident_board(raw_events, observatory_config=_feed_config(), now=now)

    assert len(board["active"]) == 1
    assert board["active"][0]["scope"] == "provider"
    assert board["active"][0]["headline"] == "Openai CII threshold spike"


def test_incident_board_selects_model_scope_when_issue_is_isolated():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        {
            "id": 1,
            "timestamp": (now - timedelta(minutes=5)).isoformat(),
            "event_type": "probe_failure",
            "severity": "warning",
            "model_id": "gpt-5",
            "message": "gpt-5 probe failure rate reached 100%",
            "payload": {"failure_rate": 1.0, "threshold": 0.75},
        }
    ]

    board = build_public_incident_board(raw_events, observatory_config=_feed_config(), now=now)

    assert len(board["active"]) == 1
    assert board["active"][0]["scope"] == "model"
    assert board["active"][0]["model_id"] == "gpt-5"


def test_incident_board_separates_active_quieted_and_stale_statuses():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        {
            "id": 1,
            "timestamp": (now - timedelta(hours=2)).isoformat(),
            "event_type": "probe_failure",
            "severity": "warning",
            "model_id": "gpt-5",
            "message": "gpt-5 probe failure rate reached 100%",
            "payload": {"failure_rate": 1.0, "threshold": 0.75},
        },
        {
            "id": 2,
            "timestamp": (now - timedelta(hours=12)).isoformat(),
            "event_type": "probe_failure",
            "severity": "warning",
            "model_id": "claude-haiku-4-5-20251001",
            "message": "claude probe failure rate reached 100%",
            "payload": {"failure_rate": 1.0, "threshold": 0.75},
        },
        {
            "id": 3,
            "timestamp": (now - timedelta(hours=48)).isoformat(),
            "event_type": "probe_failure",
            "severity": "warning",
            "model_id": "gemini-2.5-flash",
            "message": "gemini probe failure rate reached 100%",
            "payload": {"failure_rate": 1.0, "threshold": 0.75},
        },
    ]

    board = build_public_incident_board(raw_events, observatory_config=_feed_config(), now=now)

    assert [item["model_id"] for item in board["active"]] == ["gpt-5"]
    assert [item["model_id"] for item in board["quieted"]] == ["claude-haiku-4-5-20251001"]
    assert [item["model_id"] for item in board["stale"]] == ["gemini-2.5-flash"]


def test_incident_board_collapses_pcii_threshold_and_critical_into_one_observatory_state():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        {
            "id": 1,
            "timestamp": (now - timedelta(hours=3)).isoformat(),
            "event_type": "pcii_threshold",
            "severity": "alert",
            "model_id": None,
            "message": "PCII exceeded threshold",
            "payload": {"value": 0.63, "threshold": 0.6},
        },
        {
            "id": 2,
            "timestamp": (now - timedelta(hours=1)).isoformat(),
            "event_type": "pcii_critical",
            "severity": "critical",
            "model_id": None,
            "message": "PCII reached critical state",
            "payload": {"value": 0.82, "threshold": 0.8},
        },
    ]

    board = build_public_incident_board(raw_events, observatory_config=_feed_config(), now=now)

    assert len(board["active"]) == 1
    incident = board["active"][0]
    assert incident["incident_family"] == "pcii_state"
    assert incident["scope"] == "observatory"
    assert incident["headline"] == "Observatory PCII entered critical state"
    assert incident["repeat_count"] == 2


def test_flat_public_incidents_preserve_compatibility_shape():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        {
            "id": 1,
            "timestamp": (now - timedelta(hours=1)).isoformat(),
            "event_type": "probe_failure",
            "severity": "warning",
            "model_id": "gpt-5",
            "message": "gpt-5 probe failure rate reached 100%",
            "payload": {"failure_rate": 1.0, "threshold": 0.75},
        }
    ]

    incidents = build_public_incidents(raw_events, observatory_config=_feed_config(), now=now)

    assert len(incidents) == 1
    incident = incidents[0]
    assert set(incident) == {
        "event_type",
        "incident_family",
        "severity",
        "model_id",
        "metric_name",
        "message",
        "timestamp",
        "first_seen",
        "repeat_count",
        "payload",
        "status_hint",
    }
    assert incident["event_type"] == "probe_failure"
    assert incident["incident_family"] == "probe_failure"
    assert incident["message"]
