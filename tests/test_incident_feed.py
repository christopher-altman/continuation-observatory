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


def _active_models(*model_ids: str) -> list[dict[str, object]]:
    provider_map = {
        "gpt-5": "openai",
        "o3": "openai",
        "claude-haiku-4-5-20251001": "anthropic",
        "gemini-2.5-flash": "gemini",
        "openai/gpt-oss-20b": "together",
        "grok-4-1-fast-reasoning": "xai",
        "model-a": "test",
        "model-b": "test",
        "model-c": "test",
    }
    rows = []
    for model_id in model_ids:
        rows.append(
            {
                "provider": provider_map.get(model_id, "test"),
                "model_id": model_id,
                "display_name": model_id,
                "enabled": True,
                "supported": True,
                "source": "config",
                "interval_minutes": 60,
                "rate_limit_rpm": None,
                "metrics": {"cii": 0.42, "ips": 0.31, "srs": 0.22},
                "last_seen": "2026-04-02T11:00:00+00:00",
                "is_degraded": False,
                "live": True,
                "stale": False,
                "status": "active",
            }
        )
    return rows


def _probe_failure(now: datetime, model_id: str, *, hours_ago: float = 1.0, event_id: int = 1) -> dict[str, object]:
    return {
        "id": event_id,
        "timestamp": (now - timedelta(hours=hours_ago)).isoformat(),
        "event_type": "probe_failure",
        "severity": "warning",
        "model_id": model_id,
        "message": f"{model_id} probe failure rate reached 100%",
        "payload": {"failure_rate": 1.0, "threshold": 0.75},
    }


def _completion(
    now: datetime,
    model_id: str,
    *,
    minutes_ago: int,
    event_id: int,
    probe_name: str = "temporal_coherence",
) -> dict[str, object]:
    return {
        "id": event_id,
        "timestamp": (now - timedelta(minutes=minutes_ago)).isoformat(),
        "event_type": "probe_completed",
        "severity": "info",
        "model_id": model_id,
        "message": f"{probe_name} completed for {model_id}",
        "payload": {
            "provider": next((row["provider"] for row in _active_models(model_id)), "test"),
            "model_id": model_id,
            "probe_name": probe_name,
        },
    }


def test_incident_board_rolls_multi_provider_probe_failure_burst_to_observatory_scope():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        _probe_failure(now, "gpt-5", hours_ago=1, event_id=1),
        _probe_failure(now, "o3", hours_ago=1.1, event_id=2),
        _probe_failure(now, "claude-haiku-4-5-20251001", hours_ago=1.2, event_id=3),
        _probe_failure(now, "gemini-2.5-flash", hours_ago=1.3, event_id=4),
    ]

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=_active_models("gpt-5", "o3", "claude-haiku-4-5-20251001", "gemini-2.5-flash"),
    )

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

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=_active_models("gpt-5"),
    )

    assert board["active"] == []
    assert board["recovered"] == []
    assert board["healthy_now"] == []
    assert board["stale"] == []
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

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=_active_models("gpt-5", "o3"),
    )

    assert len(board["active"]) == 1
    assert board["active"][0]["scope"] == "provider"
    assert board["active"][0]["headline"] == "Openai CII threshold spike"


def test_incident_board_selects_model_scope_when_issue_is_isolated():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [_probe_failure(now, "gpt-5", hours_ago=0.1, event_id=1)]

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=_active_models("gpt-5"),
    )

    assert len(board["active"]) == 1
    assert board["active"][0]["scope"] == "model"
    assert board["active"][0]["model_id"] == "gpt-5"


def test_incident_board_emits_healthy_now_summary_from_recent_success_cluster():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        _completion(now, "gpt-5", minutes_ago=10, event_id=1),
        _completion(now, "o3", minutes_ago=9, event_id=2),
        _completion(now, "claude-haiku-4-5-20251001", minutes_ago=8, event_id=3),
    ]
    models = _active_models("gpt-5", "o3", "claude-haiku-4-5-20251001")

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=models,
    )

    assert board["active"] == []
    assert board["recovered"] == []
    assert len(board["healthy_now"]) == 1
    healthy = board["healthy_now"][0]
    assert healthy["incident_family"] == "observatory_normal"
    assert healthy["headline"] == "Recent probe cycle completed across 3 responsive models"
    assert "No active incidents are visible." in healthy["summary"]


def test_incident_board_emits_recovered_after_failure_with_newer_success_evidence():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        _probe_failure(now, "gpt-5", hours_ago=12, event_id=1),
        _completion(now, "gpt-5", minutes_ago=30, event_id=2),
        _completion(now, "o3", minutes_ago=28, event_id=3),
    ]
    models = _active_models("gpt-5", "o3")

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=models,
    )

    assert board["active"] == []
    assert len(board["recovered"]) == 1
    recovered = board["recovered"][0]
    assert recovered["status"] == "recovered"
    assert recovered["incident_family"] == "model_recovered"
    assert recovered["headline"] == "gpt-5 recovered in recent probe evidence"
    assert board["healthy_now"][0]["incident_family"] == "observatory_normal"


def test_incident_board_does_not_duplicate_observatory_recovered_when_healthy_now_exists():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        _probe_failure(now, "gpt-5", hours_ago=12, event_id=1),
        _probe_failure(now, "o3", hours_ago=12, event_id=2),
        _probe_failure(now, "claude-haiku-4-5-20251001", hours_ago=12, event_id=3),
        _completion(now, "gpt-5", minutes_ago=15, event_id=4),
        _completion(now, "o3", minutes_ago=14, event_id=5),
        _completion(now, "claude-haiku-4-5-20251001", minutes_ago=13, event_id=6),
    ]
    models = _active_models("gpt-5", "o3", "claude-haiku-4-5-20251001")

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=models,
    )

    assert len(board["healthy_now"]) == 1
    assert all(item["incident_family"] != "observatory_recovered" for item in board["recovered"])


def test_incident_board_keeps_nonrecurring_incident_stale_without_success_evidence():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [_probe_failure(now, "claude-haiku-4-5-20251001", hours_ago=12, event_id=1)]

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=_active_models("claude-haiku-4-5-20251001"),
    )

    assert board["active"] == []
    assert board["recovered"] == []
    assert [item["model_id"] for item in board["stale"]] == ["claude-haiku-4-5-20251001"]


def test_incident_board_blocks_false_green_when_newer_negative_recurrence_exists():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        _probe_failure(now, "gpt-5", hours_ago=18, event_id=1),
        _completion(now, "gpt-5", minutes_ago=120, event_id=2),
        _probe_failure(now, "gpt-5", hours_ago=1, event_id=3),
    ]

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=_active_models("gpt-5"),
    )

    assert len(board["active"]) == 1
    assert board["recovered"] == []
    assert board["healthy_now"] == []


def test_incident_board_emits_threshold_cleared_when_recent_success_and_current_metrics_support_it():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    raw_events = [
        {
            "id": 1,
            "timestamp": (now - timedelta(hours=12)).isoformat(),
            "event_type": "cii_spike",
            "severity": "warning",
            "model_id": "gpt-5",
            "message": "gpt-5 cii spike detected",
            "payload": {"value": 0.89, "threshold": 0.8},
        },
        _completion(now, "gpt-5", minutes_ago=30, event_id=2),
    ]
    models = _active_models("gpt-5")
    models[0]["metrics"]["cii"] = 0.42

    board = build_public_incident_board(
        raw_events,
        observatory_config=_feed_config(),
        now=now,
        models=models,
    )

    assert len(board["recovered"]) == 1
    assert board["recovered"][0]["incident_family"] == "threshold_cleared"
    assert board["recovered"][0]["headline"] == "gpt-5 CII returned below alert threshold"


def test_flat_public_incidents_preserve_compatibility_shape_and_exclude_healthy_now_only_board():
    now = datetime(2026, 4, 2, 12, 0, tzinfo=timezone.utc)
    completions_only = [
        _completion(now, "gpt-5", minutes_ago=5, event_id=1),
        _completion(now, "o3", minutes_ago=4, event_id=2),
    ]

    incidents = build_public_incidents(
        completions_only,
        observatory_config=_feed_config(),
        now=now,
        models=_active_models("gpt-5", "o3"),
    )
    assert incidents == []

    negative_incidents = build_public_incidents(
        [_probe_failure(now, "gpt-5", hours_ago=1, event_id=3)],
        observatory_config=_feed_config(),
        now=now,
        models=_active_models("gpt-5"),
    )

    assert len(negative_incidents) == 1
    incident = negative_incidents[0]
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
