from __future__ import annotations

from datetime import datetime, timedelta, timezone

from observatory.metrics.cii import compute_cii
from observatory.metrics.pcii import compute_pcii, compute_pcii_delta


def test_compute_cii_renormalizes_available_components():
    value, degraded = compute_cii({"srs": 0.8, "ips": 0.6, "mpg": None, "tci": None, "edp": None})
    assert value is not None
    assert 0.0 <= value <= 1.0
    assert degraded is True


def test_compute_cii_requires_two_components():
    value, degraded = compute_cii({"srs": 0.8, "ips": None, "mpg": None, "tci": None, "edp": None})
    assert value is None
    assert degraded is True


def test_compute_pcii_and_delta():
    current = compute_pcii({"a": 0.4, "b": 0.6, "c": None})
    assert current == 0.5
    history = [
        (datetime.now(timezone.utc) - timedelta(hours=8), 0.35),
        (datetime.now(timezone.utc) - timedelta(hours=7), 0.36),
        (datetime.now(timezone.utc), 0.5),
    ]
    delta = compute_pcii_delta(0.5, history, hours=6.0)
    assert delta is not None
    assert delta > 0
