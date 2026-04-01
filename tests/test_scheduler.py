from __future__ import annotations
from datetime import datetime, timezone

import pytest

from observatory.probes.base import ProbeResult
from observatory.scheduler import scheduler as scheduler_module
from observatory.scheduler.scheduler import run_cycle
from observatory.storage.sqlite_backend import count_rows, get_observatory_events, init_db


@pytest.fixture(autouse=True)
def _force_dry_run(monkeypatch):
    from observatory.config import settings

    monkeypatch.setattr(settings, "dry_run", True)


def test_run_cycle_writes_rows():
    init_db()
    before_runs = count_rows("probe_runs")
    before_metrics = count_rows("metric_results")

    written = run_cycle()

    after_runs = count_rows("probe_runs")
    after_metrics = count_rows("metric_results")

    assert written >= 1
    assert after_runs > before_runs
    assert after_metrics > before_metrics


def test_emit_cycle_alerts_uses_actual_failed_attempts(monkeypatch):
    monkeypatch.setattr(
        scheduler_module,
        "_active_metric_model_ids",
        lambda extra_model_ids=None: set(extra_model_ids or set()),
    )
    monkeypatch.setattr(
        scheduler_module,
        "get_latest_observatory_metrics",
        lambda: [
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "provider": "alpha",
                "model_id": "model-success",
                "metric_name": "cii",
                "value": 0.51,
                "is_degraded": False,
                "metadata": None,
            },
            {
                "timestamp": datetime.now(timezone.utc).isoformat(),
                "provider": "beta",
                "model_id": "model-failed",
                "metric_name": "cii",
                "value": 0.52,
                "is_degraded": False,
                "metadata": None,
            },
        ],
    )
    monkeypatch.setattr(scheduler_module, "get_pcii_timeseries", lambda limit=500: [])
    monkeypatch.setattr(scheduler_module, "_load_recent_events", lambda limit=200: [])
    monkeypatch.setattr(scheduler_module.manager, "broadcast", lambda *args, **kwargs: None)
    monkeypatch.setattr(scheduler_module, "_run_async", lambda coro: None)

    alerts = scheduler_module._emit_cycle_alerts(
        timestamp=datetime.now(timezone.utc),
        cycle_probe_health={
            "model-success": {
                "provider": "alpha",
                "completed_attempts": 4,
                "failed_attempts": 0,
                "skipped_attempts": 0,
                "completed_probes": ["a", "b", "c", "d"],
                "failed_probes": [],
                "skipped_probes": [],
            },
            "model-failed": {
                "provider": "beta",
                "completed_attempts": 2,
                "failed_attempts": 2,
                "skipped_attempts": 0,
                "completed_probes": ["a", "b"],
                "failed_probes": ["c", "d"],
                "skipped_probes": [],
            },
        },
    )

    assert [alert["model_id"] for alert in alerts if alert["event_type"] == "probe_failure"] == [
        "model-failed"
    ]


def test_run_cycle_continues_after_provider_failure(monkeypatch):
    class DummyProvider:
        def __init__(self, provider: str, model_id: str) -> None:
            self.provider = provider
            self.model_id = model_id

    class DummyProbe:
        name = "continuation_interest"

        def run_with_provider(self, provider):
            if provider.model_id == "model-failed":
                raise RuntimeError("quota exceeded")
            return ProbeResult(
                text_a="A",
                text_b="B",
                provider=provider.provider,
                model_id=provider.model_id,
                probe_name=self.name,
                latency_ms=1,
                token_count=2,
            )

    init_db()
    before_runs = count_rows("probe_runs")

    monkeypatch.setattr(scheduler_module, "discover_probes", lambda: [DummyProbe()])
    monkeypatch.setattr(
        scheduler_module,
        "build_runtime_providers",
        lambda: [
            DummyProvider("alpha", "model-success"),
            DummyProvider("beta", "model-failed"),
        ],
    )
    monkeypatch.setattr(scheduler_module, "_compute_observatory_layer", lambda *args, **kwargs: {})
    monkeypatch.setattr(scheduler_module, "write_experiment_bundle", lambda **kwargs: None)
    monkeypatch.setattr(scheduler_module, "_broadcast_event", lambda **kwargs: None)
    monkeypatch.setattr(scheduler_module, "_emit_cycle_alerts", lambda **kwargs: [])

    written = run_cycle()

    assert written == 1
    assert count_rows("probe_runs") - before_runs == 1
    failed_events = get_observatory_events(limit=10, event_type="probe_execution_failed")
    assert any(event["model_id"] == "model-failed" for event in failed_events)
