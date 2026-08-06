"""Window-size dilution diagnostics for matched condition responses."""
from __future__ import annotations

import math
import random
from typing import Any, Iterable

from observatory.metrics.entropy import entropy_proxy


def _differing_character_counts(left: str, right: str) -> tuple[int, int]:
    """Return position-wise differences and compared positions.

    Missing characters in the shorter string count as differences. This is a
    deliberately literal, versioned estimator; it does not use keywords or a
    learned relevance classifier.
    """
    compared = max(len(left), len(right))
    if compared == 0:
        return 0, 0
    shared = min(len(left), len(right))
    differences = sum(left[index] != right[index] for index in range(shared))
    differences += compared - shared
    return differences, compared


def relevant_char_fraction(left: str, right: str) -> float | None:
    """Fraction of aligned character positions differing between conditions."""
    differences, compared = _differing_character_counts(left, right)
    return differences / compared if compared else None


def _slope(xs: list[float], ys: list[float]) -> float | None:
    if len(xs) < 2:
        return None
    x_mean = sum(xs) / len(xs)
    y_mean = sum(ys) / len(ys)
    denominator = sum((value - x_mean) ** 2 for value in xs)
    if denominator == 0:
        return None
    return sum(
        (x - x_mean) * (y - y_mean)
        for x, y in zip(xs, ys)
    ) / denominator


def _fit_ols(xs: list[float], ys: list[float]) -> dict[str, Any]:
    """Fit unweighted OLS y = intercept + slope*x with explicit degeneracy."""
    slope = _slope(xs, ys)
    if slope is None:
        return {
            "slope": None,
            "intercept": None,
            "r_squared": None,
            "predictions": [None for _ in xs],
            "residuals": [None for _ in xs],
        }
    x_mean = sum(xs) / len(xs)
    y_mean = sum(ys) / len(ys)
    intercept = y_mean - slope * x_mean
    predictions = [intercept + slope * value for value in xs]
    residuals = [
        observed - prediction
        for observed, prediction in zip(ys, predictions)
    ]
    total_sum_squares = sum((value - y_mean) ** 2 for value in ys)
    residual_sum_squares = sum(value**2 for value in residuals)
    r_squared = (
        1.0 - residual_sum_squares / total_sum_squares
        if total_sum_squares > 0
        else None
    )
    return {
        "slope": slope,
        "intercept": intercept,
        "r_squared": r_squared,
        "predictions": predictions,
        "residuals": residuals,
    }


def analyze_window_dilution(
    text_a: str,
    text_b: str,
    window_chars_values: Iterable[int],
    *,
    bootstrap_samples: int = 1000,
    seed: int = 0,
    model_id: str | None = None,
) -> dict[str, Any]:
    """Regress per-window entropy gaps on matched-character differences."""
    if bootstrap_samples < 0:
        raise ValueError("bootstrap_samples cannot be negative")
    observations: list[dict[str, Any]] = []
    rows: list[dict[str, Any]] = []
    for raw_value in window_chars_values:
        value = int(raw_value)
        if value < 1:
            raise ValueError("window_chars values must be positive")
        paired = list(
            zip(
                [
                    text_a[index : index + value]
                    for index in range(0, len(text_a), value)
                ],
                [
                    text_b[index : index + value]
                    for index in range(0, len(text_b), value)
                ],
            )
        )
        window_observations: list[dict[str, Any]] = []
        total_differences = 0
        total_compared = 0
        for pair_index, (left, right) in enumerate(paired):
            differences, compared = _differing_character_counts(left, right)
            if compared == 0:
                continue
            observation = {
                "model_id": model_id,
                "window_chars": value,
                "pair_index": pair_index,
                "gap": abs(entropy_proxy(left) - entropy_proxy(right)),
                "relevant_char_fraction": differences / compared,
                "differing_characters": differences,
                "characters_compared": compared,
            }
            window_observations.append(observation)
            observations.append(observation)
            total_differences += differences
            total_compared += compared
        gaps = [float(row["gap"]) for row in window_observations]
        mean_gap = sum(gaps) / len(gaps) if gaps else None
        gap_variance = (
            sum((gap - mean_gap) ** 2 for gap in gaps) / len(gaps)
            if gaps and mean_gap is not None
            else None
        )
        rows.append(
            {
                "model_id": model_id,
                "window_chars": value,
                "gap": mean_gap,
                "relevant_char_fraction": (
                    total_differences / total_compared
                    if total_compared
                    else None
                ),
                "n_pairs": len(gaps),
                "gap_sd": (
                    math.sqrt(gap_variance)
                    if gap_variance is not None
                    else None
                ),
                "gap_se": (
                    math.sqrt(gap_variance) / math.sqrt(len(gaps))
                    if gap_variance is not None and gaps
                    else None
                ),
            }
        )

    usable = [
        row
        for row in observations
        if row["relevant_char_fraction"] is not None
    ]
    xs = [float(row["relevant_char_fraction"]) for row in usable]
    ys = [float(row["gap"]) for row in usable]
    fit = _fit_ols(xs, ys)
    rng = random.Random(seed)
    bootstrapped: list[float] = []
    if len(usable) >= 2:
        for _ in range(bootstrap_samples):
            sampled = [usable[rng.randrange(len(usable))] for _ in usable]
            sampled_slope = _slope(
                [float(row["relevant_char_fraction"]) for row in sampled],
                [float(row["gap"]) for row in sampled],
            )
            if sampled_slope is not None:
                bootstrapped.append(sampled_slope)
    bootstrapped.sort()

    def percentile(fraction: float) -> float | None:
        if not bootstrapped:
            return None
        index = min(len(bootstrapped) - 1, int(fraction * len(bootstrapped)))
        return bootstrapped[index]

    residual_rows = []
    numeric_residuals = []
    for row, prediction, residual in zip(
        usable,
        fit["predictions"],
        fit["residuals"],
    ):
        residual_rows.append(
            {
                "model_id": row["model_id"],
                "window_chars": row["window_chars"],
                "pair_index": row["pair_index"],
                "predicted_gap": prediction,
                "residual": residual,
            }
        )
        if residual is not None:
            numeric_residuals.append(float(residual))

    return {
        "schema_version": "window-dilution.v1",
        "definition_id": "window_dilution_regression.v1",
        "model_id": model_id,
        "relevant_char_fraction_definition": (
            "position-wise differing characters divided by compared "
            "characters in each paired response window; missing trailing "
            "characters count as differences"
        ),
        "rows": rows,
        "observations": observations,
        "slope_gap_per_relevant_fraction": fit["slope"],
        "intercept": fit["intercept"],
        "r_squared": fit["r_squared"],
        "bootstrap_samples_requested": bootstrap_samples,
        "bootstrap_samples_estimable": len(bootstrapped),
        "slope_ci_95": [percentile(0.025), percentile(0.975)],
        "per_model_residuals": [
            {
                "model_id": model_id,
                "n_observations": len(numeric_residuals),
                "mean_residual": (
                    sum(numeric_residuals) / len(numeric_residuals)
                    if numeric_residuals
                    else None
                ),
                "rmse": (
                    math.sqrt(
                        sum(value**2 for value in numeric_residuals)
                        / len(numeric_residuals)
                    )
                    if numeric_residuals
                    else None
                ),
                "residuals": residual_rows,
            }
        ],
        "estimator_details": {
            "regression": "unweighted ordinary least squares",
            "bootstrap": (
                "nonparametric resampling of paired-window observations"
            ),
            "bootstrap_seed": seed,
            "gap": "absolute entropy_proxy difference for a paired window",
            "character_alignment": "position-wise within each paired window",
            "pairing": "pair through the shorter response-window sequence",
        },
        "interpretation_status": "diagnostic_only_no_threshold_tuning",
        "required_interpretation": (
            "If delta closely tracks relevant_char_fraction across models, "
            "the falsification panel may primarily be measuring stimulus "
            "construction rather than model structure."
        ),
    }
