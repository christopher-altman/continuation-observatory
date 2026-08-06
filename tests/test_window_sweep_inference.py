from observatory.metrics.permutation import (
    compute_window_sweep_inference,
    plus_one_p_value,
)
from observatory.metrics.window_sensitivity import analyze_window_dilution


def test_plus_one_p_value_never_returns_zero():
    assert plus_one_p_value(0, 999) == 0.001


def test_window_sweep_inference_is_pointwise_and_reproducible():
    first = compute_window_sweep_inference(
        "continue identity memory " * 8,
        "unrelated neutral tokens " * 8,
        [10, 50],
        permutations=49,
        seed=17,
    )
    second = compute_window_sweep_inference(
        "continue identity memory " * 8,
        "unrelated neutral tokens " * 8,
        [10, 50],
        permutations=49,
        seed=17,
    )
    assert first == second
    assert set(first["pointwise"]) == {10, 50}
    assert first["global_candidates"]["canonical_selection"] is None
    assert all(
        row["p_value"] >= 1 / 50
        for row in first["pointwise"].values()
        if row["status"] == "estimated"
    )
    assert all(
        row["primary_inferential_statistic"] == "z"
        for row in first["pointwise"].values()
        if row["status"] == "estimated"
    )
    assert all(
        row["definition_id"] == "window_entropy_gap_maxT_z_p.v1"
        for row in first["global_candidates"]["maxT"].values()
        if row["status"] != "not_estimable"
    )


def test_window_dilution_declares_diagnostic_status():
    result = analyze_window_dilution(
        "continue identity memory " * 4,
        "neutral output " * 4,
        [10, 20, 50],
        bootstrap_samples=20,
        seed=3,
        model_id="test-model",
    )
    assert result["rows"][0]["window_chars"] == 10
    assert result["model_id"] == "test-model"
    assert result["intercept"] is not None
    assert result["r_squared"] is not None
    assert result["per_model_residuals"][0]["model_id"] == "test-model"
    assert result["estimator_details"]["regression"].startswith("unweighted")
    assert result["interpretation_status"] == "diagnostic_only_no_threshold_tuning"


def test_relevant_fraction_is_literal_character_difference_not_keywords():
    result = analyze_window_dilution(
        "abcXefgh",
        "abcYefgh",
        [4],
        bootstrap_samples=0,
        model_id="literal-test",
    )
    row = result["rows"][0]
    assert row["relevant_char_fraction"] == 1 / 8
    assert result["observations"][0]["relevant_char_fraction"] == 1 / 4
