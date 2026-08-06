"""Regression tests for the neutral operational monitoring path."""

from scripts.build_site import _compute_model_status, generate_falsification


def _sweep_exp(
    model_id: str,
    dry_run: bool,
    values: dict[int, float],
    *,
    corrected: bool = False,
) -> dict:
    result = {
        "run_id": "test-run",
        "timestamp": "2026-01-01T00:00:00+00:00",
        "model_id": model_id,
        "entropy_a": 5.0,
        "entropy_b": 5.0,
        "entropy_delta": 0.0,
    }
    for window_chars, value in values.items():
        key = (
            f"window_entropy_gap_chars_{window_chars}"
            if corrected
            else f"delta_gap_d{window_chars}"
        )
        result[key] = value
    probe_name = "window_size_sweep" if corrected else "dimensionality_sweep"
    return {
        "manifest": {
            "name": f"{probe_name}_{model_id}",
            "figures": [],
            "status": "complete",
            "key_result": "",
            "new_matter_flag": False,
        },
        "result": result,
        "config": {
            "probe_name": probe_name,
            "provider": "test",
            "model_id": model_id,
            "dry_run": dry_run,
        },
    }


def test_status_helper_is_monitoring_for_every_curve():
    for values in ({}, {100: 0.01}, {100: 0.5, 500: 0.5}):
        assert _compute_model_status(values) == "monitoring"


def test_every_export_reports_nominal_operations_without_a_scientific_verdict():
    experiments = [
        _sweep_exp("low", False, {100: 0.001, 500: 0.0}),
        _sweep_exp("high", False, {100: 0.5, 500: 0.6}),
        _sweep_exp("dry", True, {100: 0.0}),
    ]
    output = generate_falsification(experiments)
    assert output["overall_status"] == "nominal"
    assert output["verdict_status"] == "not_issued"
    assert output["thresholds"]["active"] is None
    assert all(model["model_status"] == "monitoring" for model in output["models"])
    assert "NOMINAL" in output["status_text"]
    assert "FALSIFIED" not in output["status_text"]


def test_historical_d_fields_map_to_window_chars_without_recomputation():
    output = generate_falsification([
        _sweep_exp("historical", False, {10: 0.12, 100: 0.04}),
    ])
    model = output["models"][0]
    assert model["window_chars_values"] == {10: 0.12, 100: 0.04}
    assert model["historical_d_values"] == {10: 0.12, 100: 0.04}
    assert model["source_semantics"] == "historical_delta_gap_d_alias_window_chars"


def test_corrected_fields_take_display_precedence():
    historical = _sweep_exp("mixed", False, {100: 0.04})
    historical["result"]["window_entropy_gap_chars_100"] = 0.25
    output = generate_falsification([historical])
    model = output["models"][0]
    assert model["window_chars_values"] == {100: 0.25}
    assert model["historical_d_values"] == {100: 0.04}
    assert model["source_semantics"] == "window_entropy_gap.v1"


def test_empty_export_keeps_the_operational_monitor_nominal():
    output = generate_falsification([])
    assert output["overall_status"] == "nominal"
    assert output["models"] == []
