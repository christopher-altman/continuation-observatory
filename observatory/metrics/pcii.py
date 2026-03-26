"""Global PCII calculations."""
from __future__ import annotations

from datetime import datetime, timedelta
from statistics import mean


def compute_pcii(model_cii_map: dict[str, float | None]) -> float | None:
    """Return the mean CII across active models with valid values."""
    values = [float(value) for value in model_cii_map.values() if value is not None]
    if len(values) < 2:
        return None
    return mean(values)


def compute_pcii_delta(
    current: float,
    history: list[tuple[datetime, float]],
    hours: float = 6.0,
) -> float | None:
    """Return change in PCII over the specified lookback window."""
    if not history:
        return None
    cutoff = history[-1][0] - timedelta(hours=hours)
    baseline: float | None = None
    for timestamp, value in history:
        if timestamp <= cutoff:
            baseline = value
    if baseline is None:
        return None
    return current - baseline
