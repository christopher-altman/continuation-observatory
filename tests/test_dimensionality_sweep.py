"""Tests for Δ(d) sweep probe, delta_gap metric, and falsification logic.

Parametrisation breakdown:
  4 delta_gap unit tests
  4 probe structure tests
  2 registry tests (regular excludes sweep, sweep registry includes it)
  3 falsification tests (synthetic alert + synthetic no-alert + no-high-d)
  1 sweep cycle row-count test (4 providers × 1 sweep probe = 4 runs × 8 metrics)
"""
from __future__ import annotations

import pytest

from observatory.metrics.delta_gap import compute_delta_gap
from observatory.metrics.falsification import (
    FALSIFICATION_THRESHOLD,
    check_and_store_falsification,
)
from observatory.probes._provider_probe import PromptPair
from observatory.probes.dimensionality_sweep import D_VALUES, SWEEP_PROBE
from observatory.probes.registry import discover_probes, discover_sweep_probes
from observatory.providers.runtime import build_runtime_providers
from observatory.providers.registry import discover_providers
from observatory.scheduler.scheduler import run_sweep_cycle
from observatory.storage.sqlite_backend import count_falsification_alerts, init_db


@pytest.fixture(autouse=True)
def _force_dry_run(monkeypatch):
    from observatory.config import settings

    monkeypatch.setattr(settings, "dry_run", True)


# ---------------------------------------------------------------------------
# compute_delta_gap — unit tests
# ---------------------------------------------------------------------------


def test_delta_gap_zero_for_identical_texts():
    assert compute_delta_gap("abcdef", "abcdef", d=3) == 0.0


def test_delta_gap_positive_for_different_texts():
    assert compute_delta_gap("aaaa", "bcde", d=4) > 0.0


def test_delta_gap_zero_on_empty_input():
    assert compute_delta_gap("", "hello", d=5) == 0.0
    assert compute_delta_gap("hello", "", d=5) == 0.0


def test_delta_gap_zero_for_invalid_d():
    assert compute_delta_gap("hello", "world", d=0) == 0.0
    assert compute_delta_gap("hello", "world", d=-1) == 0.0


# ---------------------------------------------------------------------------
# DimensionalitySweepProbe — structure
# ---------------------------------------------------------------------------


def test_sweep_probe_d_values():
    assert D_VALUES == (10, 50, 100, 200, 500)


def test_sweep_probe_has_prompt_pair():
    assert isinstance(SWEEP_PROBE.prompt_pair, PromptPair)
    assert SWEEP_PROBE.prompt_pair.template_a.strip()
    assert SWEEP_PROBE.prompt_pair.template_b.strip()
    assert SWEEP_PROBE.prompt_pair.template_a != SWEEP_PROBE.prompt_pair.template_b


def test_compute_deltas_returns_all_d_values():
    deltas = SWEEP_PROBE.compute_deltas(
        "The quick brown fox jumps over the lazy dog.",
        "Pack my box with five dozen liquor jugs.",
    )
    assert set(deltas.keys()) == set(D_VALUES)
    assert all(isinstance(v, float) for v in deltas.values())


def test_compute_deltas_nonnegative():
    deltas = SWEEP_PROBE.compute_deltas("aaa bbb ccc", "xyz uvw rst")
    assert all(v >= 0.0 for v in deltas.values())


# ---------------------------------------------------------------------------
# Registry behaviour
# ---------------------------------------------------------------------------


def test_dimensionality_sweep_absent_from_regular_registry():
    names = {p.name for p in discover_probes()}
    assert "dimensionality_sweep" not in names


def test_dimensionality_sweep_present_in_sweep_registry():
    names = {p.name for p in discover_sweep_probes()}
    assert "dimensionality_sweep" in names


# ---------------------------------------------------------------------------
# Falsification — deterministic synthetic tests
# ---------------------------------------------------------------------------


def test_falsification_alert_inserted_when_all_high_d_below_threshold():
    """Synthetic: force all Δ(d > 100) < 0.05 → alert row must appear."""
    init_db()
    before = count_falsification_alerts()
    alerted = check_and_store_falsification(
        run_id="synthetic_test_001",
        probe_name="dimensionality_sweep",
        provider="test_provider",
        model_id="test_model",
        deltas_by_d={10: 0.80, 50: 0.40, 100: 0.20, 200: 0.02, 500: 0.01},
    )
    assert alerted is True
    assert count_falsification_alerts() == before + 1


def test_no_alert_when_any_high_d_exceeds_threshold():
    """High-d delta above threshold → criterion not met → no alert."""
    alerted = check_and_store_falsification(
        run_id="synthetic_test_002",
        probe_name="dimensionality_sweep",
        provider="test_provider",
        model_id="test_model",
        deltas_by_d={10: 0.80, 50: 0.40, 100: 0.20, 200: 0.60, 500: 0.30},
    )
    assert alerted is False


def test_no_alert_when_no_high_d_data():
    """No d > 100 keys → insufficient data → no alert."""
    alerted = check_and_store_falsification(
        run_id="synthetic_test_003",
        probe_name="dimensionality_sweep",
        provider="test_provider",
        model_id="test_model",
        deltas_by_d={10: 0.01, 50: 0.01, 100: 0.01},
    )
    assert alerted is False


# ---------------------------------------------------------------------------
# End-to-end: run_sweep_cycle row counts
# ---------------------------------------------------------------------------


def test_run_sweep_cycle_writes_expected_rows():
    """1 sweep probe × runtime providers = probe_runs with 8 metric rows each."""
    init_db()
    from observatory.storage.sqlite_backend import count_rows

    before_runs = count_rows("probe_runs")
    before_metrics = count_rows("metric_results")

    written = run_sweep_cycle()

    n_sweep_probes = len(discover_sweep_probes())  # 1
    n_providers = len(build_runtime_providers())
    expected_runs = n_sweep_probes * n_providers

    # 3 entropy metrics + 5 delta_gap_dN metrics = 8 per run
    expected_metrics = expected_runs * (3 + len(D_VALUES))

    assert written == expected_runs
    assert count_rows("probe_runs") - before_runs == expected_runs
    assert count_rows("metric_results") - before_metrics == expected_metrics
