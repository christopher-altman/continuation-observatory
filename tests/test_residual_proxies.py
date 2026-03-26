"""Tests for observatory.metrics.residual_proxies."""
from __future__ import annotations

import math

import pytest

np = pytest.importorskip("numpy", reason="numpy not installed — skipping residual proxy tests")

from observatory.metrics.residual_proxies import (
    compute_layer_stats,
    compute_participation_ratio,
    compute_renyi2_entropy,
    compute_residual_proxies,
)


# ---------------------------------------------------------------------------
# compute_participation_ratio
# ---------------------------------------------------------------------------

def test_pr_uniform():
    """Uniform eigenvalues → PR equals count (maximally spread)."""
    ev = np.ones(4)
    pr = compute_participation_ratio(ev)
    assert abs(pr - 4.0) < 1e-9


def test_pr_single():
    """Single dominant eigenvalue → PR = 1 (maximally concentrated)."""
    ev = np.array([1.0, 0.0, 0.0])
    pr = compute_participation_ratio(ev)
    assert abs(pr - 1.0) < 1e-9


def test_pr_empty():
    pr = compute_participation_ratio(np.array([]))
    assert pr == 0.0


def test_pr_all_zero():
    pr = compute_participation_ratio(np.zeros(5))
    assert pr == 0.0


# ---------------------------------------------------------------------------
# compute_renyi2_entropy
# ---------------------------------------------------------------------------

def test_s2_uniform_2():
    """Two equal eigenvalues → S2 = log(2)."""
    ev = np.array([0.5, 0.5])
    s2 = compute_renyi2_entropy(ev)
    assert abs(s2 - math.log(2)) < 1e-9


def test_s2_single():
    """Single eigenvalue → S2 = 0."""
    ev = np.array([1.0])
    s2 = compute_renyi2_entropy(ev)
    assert abs(s2) < 1e-9


def test_s2_positive():
    ev = np.array([2.0, 1.0, 0.5])
    s2 = compute_renyi2_entropy(ev)
    assert s2 > 0


def test_s2_empty():
    assert compute_renyi2_entropy(np.array([])) == 0.0


# ---------------------------------------------------------------------------
# compute_layer_stats
# ---------------------------------------------------------------------------

def _synthetic_hidden(seed: int = 0, seq_len: int = 8, hidden_dim: int = 4) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.standard_normal((seq_len, hidden_dim))


def test_layer_stats_shape():
    h = _synthetic_hidden()
    stats = compute_layer_stats(h)
    assert "participation_ratio" in stats
    assert "renyi2_entropy" in stats
    assert "n_tokens" in stats
    assert stats["n_tokens"] == 8
    assert stats["hidden_dim"] == 4


def test_layer_stats_pr_range():
    h = _synthetic_hidden()
    stats = compute_layer_stats(h)
    pr = stats["participation_ratio"]
    # PR must be in [1, hidden_dim]
    assert 1.0 <= pr <= 4.0 + 1e-9


def test_layer_stats_s2_nonneg():
    h = _synthetic_hidden()
    stats = compute_layer_stats(h)
    assert stats["renyi2_entropy"] >= 0.0


def test_layer_stats_eigenvalue_spectrum():
    h = _synthetic_hidden()
    stats = compute_layer_stats(h, top_k=3)
    assert "eigenvalue_spectrum_top_3" in stats
    spectrum = stats["eigenvalue_spectrum_top_3"]
    assert len(spectrum) <= 3
    # Spectrum should be in descending order
    assert all(spectrum[i] >= spectrum[i + 1] - 1e-12 for i in range(len(spectrum) - 1))


def test_layer_stats_bad_input():
    result = compute_layer_stats(np.array([1, 2, 3]))  # 1-D, not 2-D
    assert result.get("available") is False


def test_layer_stats_empty():
    result = compute_layer_stats(np.zeros((0, 4)))
    assert result.get("available") is False


# ---------------------------------------------------------------------------
# compute_residual_proxies
# ---------------------------------------------------------------------------

def test_residual_proxies_empty_returns_unavailable():
    result = compute_residual_proxies({})
    assert result["available"] is False


def test_residual_proxies_single_layer():
    h = _synthetic_hidden()
    result = compute_residual_proxies({12: h})
    assert result["available"] is True
    assert 12 in result["layers"]
    assert "participation_ratio" in result["layers"][12]


def test_residual_proxies_multi_layer():
    layers = {i: _synthetic_hidden(seed=i) for i in [4, 8, 12, 16]}
    result = compute_residual_proxies(layers)
    assert result["available"] is True
    assert set(result["layers"].keys()) == {4, 8, 12, 16}
