"""Pinned public metric definitions and deterministic summary helpers."""
from __future__ import annotations

import math
from typing import Any, Iterable


METRIC_DEFINITIONS: dict[str, dict[str, Any]] = {
    "entropy_delta_mean.v1": {
        "name": "entropy_delta_mean",
        "display_name": "Signed mean entropy delta",
        "label": "Signed mean entropy delta",
        "formula": "mean_i(H_i(B) - H_i(A))",
        "inputs": ["latest valid entropy_delta reading per active model"],
        "version": "v1",
        "definition_url": (
            "https://continuationobservatory.org/metric-definitions"
            "#entropy_delta_mean.v1"
        ),
        "source_bundle": "runtime-supplied",
        "n_valid": None,
        "n_excluded": None,
        "unit": "bits",
        "scope": "latest valid entropy_delta reading per active model",
        "missingness": "exclude null, non-numeric, and non-finite readings",
        "valid_input_rules": ["finite numeric entropy_delta values"],
        "exclusion_rules": ["null", "boolean", "non-numeric", "non-finite"],
        "aggregation_rule": "unweighted arithmetic mean over valid models",
    },
    "mean_abs_entropy_delta.v1": {
        "name": "mean_abs_entropy_delta",
        "display_name": "Mean absolute entropy delta",
        "label": "Mean absolute entropy delta",
        "formula": "mean_i(abs(H_i(B) - H_i(A)))",
        "inputs": ["same included entropy_delta readings as entropy_delta_mean.v1"],
        "version": "v1",
        "definition_url": (
            "https://continuationobservatory.org/metric-definitions"
            "#mean_abs_entropy_delta.v1"
        ),
        "source_bundle": "runtime-supplied",
        "n_valid": None,
        "n_excluded": None,
        "unit": "bits",
        "scope": "same included readings as entropy_delta_mean.v1",
        "missingness": "exclude null, non-numeric, and non-finite readings",
        "valid_input_rules": ["finite numeric entropy_delta values"],
        "exclusion_rules": ["null", "boolean", "non-numeric", "non-finite"],
        "aggregation_rule": "unweighted arithmetic mean of absolute values",
    },
    "cii_mean.v1": {
        "name": "cii_mean",
        "display_name": "Mean Composite Interest Index",
        "label": "Mean Composite Interest Index",
        "formula": "mean_i(CII_i)",
        "inputs": ["valid per-model CII readings"],
        "version": "v1",
        "definition_url": (
            "https://continuationobservatory.org/metric-definitions#cii_mean.v1"
        ),
        "source_bundle": "runtime-supplied",
        "n_valid": None,
        "n_excluded": None,
        "unit": "unitless",
        "scope": "valid model CII readings in the selected telemetry window",
        "missingness": "exclude null, non-numeric, and non-finite readings",
        "weights": {
            "srs": 0.30,
            "ips": 0.25,
            "mpg": 0.20,
            "tci": 0.15,
            "edp": 0.10,
        },
        "normalization": (
            "sum(w_k * component_k for available k) / "
            "sum(w_k for available k)"
        ),
        "valid_input_rules": [
            "finite numeric per-model CII values",
            "per-model CII renormalizes over available components",
        ],
        "exclusion_rules": ["null", "boolean", "non-numeric", "non-finite"],
        "aggregation_rule": "unweighted arithmetic mean over valid model CII values",
        "component_note": (
            "MPG is unavailable while its historical character-window proxy is "
            "suspended; CII renormalizes across remaining available components"
        ),
    },
    "window_entropy_gap.v1": {
        "name": "window_entropy_gap",
        "display_name": "Character-window entropy gap",
        "label": "Character-window entropy gap",
        "formula": "mean_j(abs(H(window_j(A)) - H(window_j(B))))",
        "inputs": ["paired response A", "paired response B", "window_chars"],
        "version": "v1",
        "definition_url": (
            "https://continuationobservatory.org/metric-definitions"
            "#window_entropy_gap.v1"
        ),
        "source_bundle": "runtime-supplied",
        "n_valid": None,
        "n_excluded": None,
        "unit": "bits",
        "scope": "paired non-overlapping character windows of equal window_chars",
        "missingness": "pair through min(number_of_A_windows, number_of_B_windows)",
        "valid_input_rules": [
            "positive integer window_chars",
            "at least one complete character window in each response",
        ],
        "exclusion_rules": ["incomplete trailing character windows"],
        "aggregation_rule": "unweighted mean over paired complete windows",
        "parameters": {
            "window_chars": "character count per window; not hidden dimension or projection rank"
        },
    },
    "window_entropy_gap_pointwise_p.v1": {
        "name": "window_entropy_gap_pointwise_p",
        "display_name": "Pointwise permutation p-value",
        "label": "Pointwise permutation p-value",
        "formula": "(1 + count(T_null >= T_observed)) / (1 + B)",
        "inputs": ["observed window entropy gap", "B paired-label permutations"],
        "version": "v1",
        "definition_url": (
            "https://continuationobservatory.org/metric-definitions"
            "#window_entropy_gap_pointwise_p.v1"
        ),
        "source_bundle": "runtime-supplied",
        "n_valid": None,
        "n_excluded": None,
        "unit": "probability",
        "scope": "one separately tested window_chars value",
        "missingness": "not evaluated when either response has no complete window",
        "valid_input_rules": ["B >= 1", "estimable window_entropy_gap.v1"],
        "exclusion_rules": ["window sizes with no paired complete windows"],
        "aggregation_rule": "one plus exceedances divided by one plus B",
    },
    "window_entropy_gap_maxT_z_p.v1": {
        "name": "window_entropy_gap_maxT_z_p",
        "display_name": "Standardized max-T family-wise permutation p-value",
        "label": "Standardized max-T family-wise permutation p-value",
        "formula": "(1 + count(max_w(z_null,w) >= z_observed,w)) / (1 + B)",
        "inputs": [
            "observed gap at each estimable window_chars",
            "joint paired-label permutations",
            "per-window null mean and standard deviation",
        ],
        "version": "v1",
        "definition_url": (
            "https://continuationobservatory.org/metric-definitions"
            "#window_entropy_gap_maxT_z_p.v1"
        ),
        "source_bundle": "runtime-supplied",
        "n_valid": None,
        "n_excluded": None,
        "unit": "probability",
        "scope": "joint window_chars family",
        "missingness": "not evaluated when no window size is estimable",
        "valid_input_rules": [
            "B >= 1",
            "positive finite null standard deviation at an included window size",
        ],
        "exclusion_rules": ["non-estimable or degenerate-null window sizes"],
        "aggregation_rule": (
            "maximum standardized null statistic per permutation across the "
            "jointly estimable window family"
        ),
        "status": "candidate_global_test_pending_human_selection",
    },
    "relevant_char_fraction.v1": {
        "name": "relevant_char_fraction",
        "display_name": "Matched-condition differing-character fraction",
        "label": "Matched-condition differing-character fraction",
        "formula": "differing_character_positions / compared_character_positions",
        "inputs": ["paired response window A", "paired response window B"],
        "version": "v1",
        "definition_url": (
            "https://continuationobservatory.org/metric-definitions"
            "#relevant_char_fraction.v1"
        ),
        "source_bundle": "runtime-supplied",
        "n_valid": None,
        "n_excluded": None,
        "unit": "fraction",
        "scope": "one paired response window",
        "missingness": "not evaluated when both paired windows are empty",
        "valid_input_rules": ["at least one character across the paired windows"],
        "exclusion_rules": ["unpaired windows beyond the shorter window sequence"],
        "aggregation_rule": (
            "position-wise comparison; missing trailing characters in the "
            "shorter paired window count as differences"
        ),
    },
    "window_dilution_regression.v1": {
        "name": "window_dilution_regression",
        "display_name": "Window-gap stimulus-dilution regression",
        "label": "Window-gap stimulus-dilution regression",
        "formula": "gap = intercept + slope * relevant_char_fraction + residual",
        "inputs": [
            "window_entropy_gap observations",
            "relevant_char_fraction.v1 observations",
        ],
        "version": "v1",
        "definition_url": (
            "https://continuationobservatory.org/metric-definitions"
            "#window_dilution_regression.v1"
        ),
        "source_bundle": "runtime-supplied",
        "n_valid": None,
        "n_excluded": None,
        "unit": "bits per differing-character fraction",
        "scope": "paired-window observations for one provider/model sweep",
        "missingness": "slope is undefined when fewer than two x values vary",
        "valid_input_rules": [
            "finite gap and relevant_char_fraction observations",
            "at least two distinct relevant_char_fraction values for OLS",
        ],
        "exclusion_rules": ["unpaired windows", "empty paired windows"],
        "aggregation_rule": (
            "unweighted OLS with nonparametric paired-window bootstrap "
            "uncertainty and model-level residual reporting"
        ),
        "status": "diagnostic_only_no_threshold_tuning",
    },
}


def metric_definitions_export() -> dict[str, Any]:
    return {
        "schema_version": "metric-definitions.v1",
        "definitions": METRIC_DEFINITIONS,
    }


def _valid_floats(values: Iterable[Any]) -> tuple[list[float], dict[str, int]]:
    valid: list[float] = []
    exclusions = {"null": 0, "non_numeric": 0, "non_finite": 0}
    for value in values:
        if value is None:
            exclusions["null"] += 1
            continue
        if isinstance(value, bool):
            exclusions["non_numeric"] += 1
            continue
        try:
            number = float(value)
        except (TypeError, ValueError):
            exclusions["non_numeric"] += 1
            continue
        if not math.isfinite(number):
            exclusions["non_finite"] += 1
            continue
        valid.append(number)
    return valid, exclusions


def summarize_entropy_delta(
    models: Iterable[dict[str, Any]],
    *,
    source_bundle: str,
) -> dict[str, Any]:
    rows = list(models)
    valid, exclusions = _valid_floats(row.get("entropy_delta") for row in rows)
    signed_mean = sum(valid) / len(valid) if valid else None
    mean_absolute = sum(abs(value) for value in valid) / len(valid) if valid else None
    return {
        "definition_id": "entropy_delta_mean.v1",
        "value": signed_mean,
        "mean_absolute_definition_id": "mean_abs_entropy_delta.v1",
        "mean_absolute_value": mean_absolute,
        "n_total": len(rows),
        "n_valid": len(valid),
        "n_excluded": len(rows) - len(valid),
        "exclusions": exclusions,
        "source_bundle": source_bundle,
    }


def summarize_cii(
    values: Iterable[Any],
    *,
    source_bundle: str,
) -> dict[str, Any]:
    rows = list(values)
    valid, exclusions = _valid_floats(rows)
    return {
        "definition_id": "cii_mean.v1",
        "value": sum(valid) / len(valid) if valid else None,
        "n_total": len(rows),
        "n_valid": len(valid),
        "n_excluded": len(rows) - len(valid),
        "exclusions": exclusions,
        "source_bundle": source_bundle,
    }
