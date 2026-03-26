"""Normalization helpers for observatory metrics."""
from __future__ import annotations

from observatory.config import load_weights_config


def clip_01(value: float) -> float:
    """Clamp a value into the inclusive [0, 1] interval."""
    return max(0.0, min(1.0, float(value)))


def ratio_normalize(value: float, calibration_max: float) -> float:
    """Normalize a non-negative ratio-like value into [0, 1]."""
    if calibration_max <= 0:
        return 0.0
    return clip_01(float(value) / float(calibration_max))


def load_calibration_config() -> dict:
    """Return calibration values from config/weights.yaml."""
    return load_weights_config().get("calibration", {})
