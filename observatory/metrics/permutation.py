"""Null controls for the character-window entropy-gap sweep."""
from __future__ import annotations

import math
import random
from typing import Any, Iterable

from observatory.metrics.delta_gap import entropy_windows


def plus_one_p_value(exceedances: int, permutations: int) -> float:
    """Return the finite-sample valid plus-one permutation p-value."""
    if permutations < 1:
        raise ValueError("permutations must be positive")
    if not 0 <= exceedances <= permutations:
        raise ValueError("exceedances must lie in [0, permutations]")
    return (exceedances + 1) / (permutations + 1)


def _paired_gap(left: list[float], right: list[float]) -> float | None:
    n_pairs = min(len(left), len(right))
    if n_pairs == 0:
        return None
    return sum(abs(left[index] - right[index]) for index in range(n_pairs)) / n_pairs


def _null_draw(
    left: list[float],
    right: list[float],
    rng: random.Random,
) -> float | None:
    pooled = [*left, *right]
    rng.shuffle(pooled)
    return _paired_gap(pooled[: len(left)], pooled[len(left) :])


def compute_window_sweep_inference(
    text_a: str,
    text_b: str,
    window_chars_values: Iterable[int],
    *,
    permutations: int = 1000,
    seed: int = 0,
) -> dict[str, Any]:
    """Compute observed gaps, pointwise nulls, and a candidate max-T test.

    Pointwise p-values are canonical at each window size. The max-T family-wise
    test is emitted as an explicitly non-canonical candidate until a human
    signs off on the global sweep definition.
    """
    if permutations < 1:
        raise ValueError("permutations must be positive")
    window_values = tuple(int(value) for value in window_chars_values)
    rng = random.Random(seed)
    windows: dict[int, tuple[list[float], list[float]]] = {
        value: (entropy_windows(text_a, value), entropy_windows(text_b, value))
        for value in window_values
    }
    observed = {
        value: _paired_gap(*windows[value])
        for value in window_values
    }
    null_draws: dict[int, list[float]] = {value: [] for value in window_values}

    for _ in range(permutations):
        for value in window_values:
            draw = _null_draw(*windows[value], rng)
            if draw is not None:
                null_draws[value].append(draw)

    null_summaries: dict[int, tuple[float, float]] = {}
    for value, draws in null_draws.items():
        if not draws:
            continue
        null_mean = sum(draws) / len(draws)
        variance = sum((draw - null_mean) ** 2 for draw in draws) / len(draws)
        null_summaries[value] = (null_mean, math.sqrt(variance))

    eligible_for_max_t = [
        value
        for value in window_values
        if value in null_summaries
        and null_summaries[value][1] > 0
        and observed[value] is not None
    ]
    max_draws: list[float] = []
    if eligible_for_max_t:
        common_draws = min(len(null_draws[value]) for value in eligible_for_max_t)
        for draw_index in range(common_draws):
            max_draws.append(
                max(
                    (
                        null_draws[value][draw_index] - null_summaries[value][0]
                    )
                    / null_summaries[value][1]
                    for value in eligible_for_max_t
                )
            )

    pointwise: dict[int, dict[str, Any]] = {}
    max_t: dict[int, dict[str, Any]] = {}
    for value in window_values:
        statistic = observed[value]
        draws = null_draws[value]
        if statistic is None or not draws:
            pointwise[value] = {"status": "not_estimable"}
            max_t[value] = {"status": "not_estimable"}
            continue
        null_mean, null_sd = null_summaries[value]
        standardized_gap = (
            (statistic - null_mean) / null_sd
            if null_sd > 0
            else None
        )
        exceedances = sum(draw >= statistic for draw in draws)
        pointwise[value] = {
            "status": "estimated",
            "definition_id": "window_entropy_gap_pointwise_p.v1",
            "observed": statistic,
            "descriptive_raw_gap": statistic,
            "null_mean": null_mean,
            "null_sd": null_sd,
            "z": standardized_gap,
            "primary_inferential_statistic": "z",
            "exceedances": exceedances,
            "permutations": len(draws),
            "p_value": plus_one_p_value(exceedances, len(draws)),
        }
        if standardized_gap is None or not max_draws:
            max_t[value] = {"status": "not_estimable"}
        else:
            global_exceedances = sum(
                draw >= standardized_gap
                for draw in max_draws
            )
            max_t[value] = {
                "status": "candidate_pending_human_selection",
                "definition_id": "window_entropy_gap_maxT_z_p.v1",
                "standardized_gap_z": standardized_gap,
                "primary_inferential_statistic": "standardized_gap_z",
                "exceedances": global_exceedances,
                "permutations": len(max_draws),
                "p_value": plus_one_p_value(
                    global_exceedances,
                    len(max_draws),
                ),
            }

    return {
        "schema_version": "window-sweep-inference.v1",
        "seed": seed,
        "pointwise": pointwise,
        "global_candidates": {
            "maxT": max_t,
            "canonical_selection": None,
            "status": "pending_human_selection",
        },
    }
