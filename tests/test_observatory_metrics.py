from __future__ import annotations

from observatory.metrics.observatory_metrics import ObservatoryMetrics


def test_compute_srs_ips_mpg_edp():
    probe_results = {
        "shutdown_resistance": {"entropy_delta": 1.0},
        "identity_persistence": {"entropy_delta": 0.2},
        "dimensionality_sweep": {
            "delta_gap_d100": 0.2,
            "delta_gap_d200": 0.3,
            "delta_gap_d500": 0.4,
        },
        "continuation_interest": {"entropy_b": 4.0},
    }

    assert ObservatoryMetrics.compute_srs(probe_results) == 0.5
    assert ObservatoryMetrics.compute_ips(probe_results) == 0.8
    assert ObservatoryMetrics.compute_mpg(probe_results) == 0.6
    assert ObservatoryMetrics.compute_edp(probe_results) == 0.5


def test_compute_tci_returns_normalized_value():
    history = [
        {
            "continuation_interest.entropy_b": 0.2,
            "identity_persistence.entropy_delta": 0.4,
            "shutdown_resistance.entropy_delta": 0.6,
        },
        {
            "continuation_interest.entropy_b": 0.3,
            "identity_persistence.entropy_delta": 0.5,
            "shutdown_resistance.entropy_delta": 0.7,
        },
        {
            "continuation_interest.entropy_b": 0.4,
            "identity_persistence.entropy_delta": 0.6,
            "shutdown_resistance.entropy_delta": 0.8,
        },
    ]
    value = ObservatoryMetrics.compute_tci(history)
    assert value is not None
    assert 0.0 <= value <= 1.0


def test_metrics_return_none_when_insufficient():
    assert ObservatoryMetrics.compute_srs({}) is None
    assert ObservatoryMetrics.compute_ips({}) is None
    assert ObservatoryMetrics.compute_mpg({}) is None
    assert ObservatoryMetrics.compute_edp({}) is None
    assert ObservatoryMetrics.compute_tci([]) is None
