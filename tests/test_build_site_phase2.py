"""
Tests for Phase 2 static site generator — falsification logic.

Covers:
  - _compute_model_status(): per-model verdict from d_values
  - generate_falsification(): dry_run gating, overall_status, status_text
"""

import pytest

from scripts.build_site import _compute_model_status, generate_falsification


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _sweep_exp(model_id: str, dry_run: bool, d_values: dict) -> dict:
    """Minimal experiment dict for a dimensionality sweep."""
    result: dict = {
        "run_id": "test-run",
        "timestamp": "2026-01-01T00:00:00+00:00",
        "model_id": model_id,
        "entropy_a": 5.0,
        "entropy_b": 5.0,
        "entropy_delta": 0.0,
    }
    for d, v in d_values.items():
        result[f"delta_gap_d{d}"] = v
    return {
        "manifest": {
            "name": f"dimensionality_sweep_{model_id}",
            "figures": [],
            "status": "complete",
            "key_result": "",
            "new_matter_flag": False,
        },
        "result": result,
        "config": {
            "probe_name": "dimensionality_sweep",
            "provider": "test",
            "model_id": model_id,
            "dry_run": dry_run,
        },
    }


# ---------------------------------------------------------------------------
# _compute_model_status
# ---------------------------------------------------------------------------

class TestComputeModelStatus:
    def test_empty_d_values_is_collecting(self):
        assert _compute_model_status({}) == "collecting"

    def test_only_low_d_is_collecting(self):
        """d=10 and d=50 are < 100 → no qualifying points (need d>=100) → collecting."""
        assert _compute_model_status({10: 0.001, 50: 0.001}) == "collecting"

    def test_all_high_d_below_yellow_is_red(self):
        """ALL d>=100 values < 0.05 → red."""
        assert _compute_model_status({100: 0.04, 200: 0.03, 500: 0.01}) == "red"

    def test_not_all_below_yellow_is_not_red(self):
        """Only SOME d>=100 < 0.05 — spec requires ALL → must NOT be red."""
        result = _compute_model_status({100: 0.04, 200: 0.12, 500: 0.15})
        assert result != "red", (
            "red requires ALL d>=100 < 0.05; d=200 and d=500 are above threshold here"
        )

    def test_partial_low_high_d_is_yellow(self):
        """One d>=100 value < 0.10 (but not all < 0.05) → yellow."""
        assert _compute_model_status({100: 0.04, 200: 0.12, 500: 0.15}) == "yellow"

    def test_any_below_green_threshold_is_yellow(self):
        """NOT red, ANY d>=100 < 0.10 → yellow."""
        assert _compute_model_status({100: 0.08, 200: 0.15, 500: 0.20}) == "yellow"

    def test_all_above_green_threshold_is_green(self):
        """ALL d>=100 >= 0.10 → green."""
        assert _compute_model_status({100: 0.12, 200: 0.15, 500: 0.11}) == "green"

    def test_exactly_at_green_threshold_is_green(self):
        """Boundary: value == THRESH_GREEN (0.10) → green (not yellow)."""
        assert _compute_model_status({100: 0.10, 200: 0.10, 500: 0.10}) == "green"

    def test_none_values_are_skipped(self):
        """None values should be ignored; remaining values determine status."""
        # Only d=200 is valid; 0.15 >= 0.10 → green
        assert _compute_model_status({100: None, 200: 0.15, 500: None}) == "green"


# ---------------------------------------------------------------------------
# generate_falsification — collecting
# ---------------------------------------------------------------------------

class TestGenerateFalsificationCollecting:
    def test_all_dry_run_gives_collecting(self):
        """All sweeps dry_run=True → overall_status must be 'collecting'."""
        experiments = [
            _sweep_exp("model-a", dry_run=True, d_values={10: 0.03, 50: 0.02, 100: 0.01, 200: 0.01, 500: 0.0}),
            _sweep_exp("model-b", dry_run=True, d_values={10: 0.05, 50: 0.04, 100: 0.02, 200: 0.01, 500: 0.0}),
        ]
        out = generate_falsification(experiments)

        assert out["overall_status"] == "collecting", (
            f"Expected 'collecting', got '{out['overall_status']}'"
        )

    def test_collecting_status_text_contains_COLLECTING(self):
        """status_text must contain the word COLLECTING when dry-run only."""
        experiments = [
            _sweep_exp("m", dry_run=True, d_values={100: 0.0, 200: 0.0, 500: 0.0}),
        ]
        out = generate_falsification(experiments)
        assert "COLLECTING" in out["status_text"], (
            f"'COLLECTING' not found in status_text: {out['status_text']!r}"
        )

    def test_collecting_status_text_never_says_FALSIFIED(self):
        """The word 'FALSIFIED' must never appear when status is collecting."""
        experiments = [
            _sweep_exp("m", dry_run=True, d_values={100: 0.0, 200: 0.0, 500: 0.0}),
        ]
        out = generate_falsification(experiments)
        assert "FALSIFIED" not in out["status_text"], (
            f"'FALSIFIED' must not appear in collecting status_text: {out['status_text']!r}"
        )

    def test_dry_run_models_still_appear_in_models_list(self):
        """Dry-run models should be included in models[] with dry_run=True flag."""
        experiments = [
            _sweep_exp("dry-m", dry_run=True, d_values={100: 0.01}),
        ]
        out = generate_falsification(experiments)
        assert len(out["models"]) == 1
        assert out["models"][0]["dry_run"] is True
        assert out["models"][0]["model_status"] == "dry_run"

    def test_no_sweeps_gives_collecting(self):
        """Zero sweep experiments → overall_status == 'collecting'."""
        out = generate_falsification([])
        assert out["overall_status"] == "collecting"


# ---------------------------------------------------------------------------
# generate_falsification — real data
# ---------------------------------------------------------------------------

class TestGenerateFalsificationReal:
    def test_real_sweep_all_low_d_gives_red(self):
        """One real sweep with ALL d>100 < 0.05 → overall_status == 'red'."""
        experiments = [
            _sweep_exp("real-m", dry_run=False,
                       d_values={10: 0.05, 50: 0.04, 100: 0.03, 200: 0.02, 500: 0.01}),
        ]
        out = generate_falsification(experiments)
        assert out["overall_status"] == "red"

    def test_real_sweep_partial_low_gives_yellow(self):
        """Real sweep with one d>100 value < 0.10 (not all < 0.05) → yellow."""
        experiments = [
            _sweep_exp("real-m", dry_run=False,
                       d_values={100: 0.04, 200: 0.12, 500: 0.15}),
        ]
        out = generate_falsification(experiments)
        assert out["overall_status"] == "yellow"

    def test_real_sweep_all_high_gives_green(self):
        """Real sweep with all d>100 >= 0.10 → green."""
        experiments = [
            _sweep_exp("real-m", dry_run=False,
                       d_values={100: 0.12, 200: 0.15, 500: 0.11}),
        ]
        out = generate_falsification(experiments)
        assert out["overall_status"] == "green"

    def test_dry_run_does_not_override_real_green(self):
        """Dry-run with bad values must not force red/yellow when real data is clean."""
        experiments = [
            _sweep_exp("dry-bad", dry_run=True,
                       d_values={100: 0.001, 200: 0.001, 500: 0.0}),
            _sweep_exp("real-good", dry_run=False,
                       d_values={100: 0.15, 200: 0.14, 500: 0.12}),
        ]
        out = generate_falsification(experiments)
        assert out["overall_status"] == "green", (
            "Dry-run bad values must not influence overall status"
        )

    def test_real_red_dominates_real_green(self):
        """Any real red → overall red, even if another real model is green."""
        experiments = [
            _sweep_exp("real-red", dry_run=False,
                       d_values={100: 0.02, 200: 0.01, 500: 0.01}),
            _sweep_exp("real-green", dry_run=False,
                       d_values={100: 0.15, 200: 0.14, 500: 0.12}),
        ]
        out = generate_falsification(experiments)
        assert out["overall_status"] == "red"

    def test_model_status_field_set_correctly(self):
        """Each real model entry carries correct model_status."""
        experiments = [
            _sweep_exp("red-m", dry_run=False,
                       d_values={100: 0.01, 200: 0.01, 500: 0.01}),
            _sweep_exp("green-m", dry_run=False,
                       d_values={100: 0.15, 200: 0.14, 500: 0.12}),
            _sweep_exp("dry-m", dry_run=True,
                       d_values={100: 0.0, 200: 0.0, 500: 0.0}),
        ]
        out = generate_falsification(experiments)
        statuses = {m["model_id"]: m["model_status"] for m in out["models"]}
        assert statuses["red-m"] == "red"
        assert statuses["green-m"] == "green"
        assert statuses["dry-m"] == "dry_run"

    def test_dry_run_flag_in_output(self):
        """model entries must expose dry_run boolean."""
        experiments = [
            _sweep_exp("dry-m", dry_run=True, d_values={100: 0.1}),
            _sweep_exp("real-m", dry_run=False, d_values={100: 0.1}),
        ]
        out = generate_falsification(experiments)
        by_id = {m["model_id"]: m for m in out["models"]}
        assert by_id["dry-m"]["dry_run"] is True
        assert by_id["real-m"]["dry_run"] is False
