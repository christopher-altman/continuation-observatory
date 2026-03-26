"""Composite CII metric."""
from __future__ import annotations

from observatory.config import load_weights_config

DEFAULT_WEIGHTS = {"srs": 0.30, "ips": 0.25, "mpg": 0.20, "tci": 0.15, "edp": 0.10}


def _resolve_weights(weights: dict[str, float] | None) -> dict[str, float]:
    if weights is not None:
        return weights
    configured = load_weights_config().get("cii_weights", {})
    return {**DEFAULT_WEIGHTS, **configured}


def compute_cii(
    metrics: dict[str, float | None],
    weights: dict[str, float] | None = None,
) -> tuple[float | None, bool]:
    """Return `(cii, is_degraded)` from available normalized components."""
    resolved = _resolve_weights(weights)
    available = {name: value for name, value in metrics.items() if value is not None}
    if len(available) < 2:
        return None, True

    denom = sum(resolved.get(name, 0.0) for name in available)
    if denom <= 0:
        return None, True

    weighted = sum(float(value) * resolved.get(name, 0.0) for name, value in available.items())
    return weighted / denom, len(available) < len(metrics)
