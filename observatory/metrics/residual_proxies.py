"""residual_proxies.py — hidden-state partition statistics (Phase II).

Implements per-layer analysis of transformer residual-stream tensors as
specified in Section 4d of the master build prompt.

For HF-local models pass a dict of ``{layer_index: hidden_state_array}``
where each array has shape ``(seq_len, hidden_dim)``.

For API-only providers (no hidden states) pass an empty dict ``{}``; the
functions return ``{"available": False}`` cleanly without raising.

Dependencies
------------
numpy is required for numerical computation.  If numpy is not installed the
module still imports but all functions return ``{"available": False}``.
"""
from __future__ import annotations

import math
from typing import Any

try:
    import numpy as np
    _NUMPY_AVAILABLE = True
except ImportError:
    np = None  # type: ignore[assignment]
    _NUMPY_AVAILABLE = False


def compute_participation_ratio(eigenvalues: Any) -> float:
    """PR = (Σ λ)² / Σ λ²  — effective dimensionality measure.

    Parameters
    ----------
    eigenvalues:
        1-D array-like of non-negative eigenvalues.

    Returns
    -------
    float
        Participation ratio in ``[1, len(eigenvalues)]``.
        Returns 0.0 for empty or all-zero input.
    """
    if not _NUMPY_AVAILABLE:
        return 0.0
    ev = np.asarray(eigenvalues, dtype=float)
    ev = ev[ev > 0]
    if ev.size == 0:
        return 0.0
    return float(ev.sum() ** 2 / (ev ** 2).sum())


def compute_renyi2_entropy(eigenvalues: Any) -> float:
    """S₂ = -log( Σ (λ_norm)² )  — Rényi-2 entropy proxy.

    Parameters
    ----------
    eigenvalues:
        1-D array-like of non-negative eigenvalues.

    Returns
    -------
    float
        Rényi-2 entropy in nats.  Returns 0.0 for empty input.
    """
    if not _NUMPY_AVAILABLE:
        return 0.0
    ev = np.asarray(eigenvalues, dtype=float)
    ev = ev[ev > 0]
    if ev.size == 0:
        return 0.0
    ev_norm = ev / ev.sum()
    s2 = -math.log(float((ev_norm ** 2).sum()))
    return s2


def compute_layer_stats(hidden: Any, top_k: int = 20) -> dict:
    """Compute covariance-eigenvalue statistics for one residual-stream layer.

    Parameters
    ----------
    hidden:
        2-D array of shape ``(seq_len, hidden_dim)``.
    top_k:
        Number of largest eigenvalues to record in ``eigenvalue_spectrum``.

    Returns
    -------
    dict with keys:
        participation_ratio (float),
        renyi2_entropy (float),
        eigenvalue_spectrum_top_{top_k} (list[float]),
        n_tokens (int),
        hidden_dim (int).
    """
    if not _NUMPY_AVAILABLE:
        return {"available": False}
    h = np.asarray(hidden, dtype=float)
    if h.ndim != 2 or h.size == 0:
        return {"available": False, "error": "expected 2-D (seq_len, hidden_dim) array"}
    # Centre
    h_c = h - h.mean(axis=0, keepdims=True)
    cov = np.cov(h_c.T)  # (hidden_dim, hidden_dim)
    eigenvalues = np.linalg.eigvalsh(cov)
    eigenvalues = np.sort(eigenvalues)[::-1]  # descending
    eigenvalues = np.maximum(eigenvalues, 0.0)  # clip numerical negatives

    pr = compute_participation_ratio(eigenvalues)
    s2 = compute_renyi2_entropy(eigenvalues)
    top_ev = eigenvalues[:top_k].tolist()

    return {
        "participation_ratio": pr,
        "renyi2_entropy": s2,
        f"eigenvalue_spectrum_top_{top_k}": top_ev,
        "n_tokens": int(h.shape[0]),
        "hidden_dim": int(h.shape[1]),
    }


def compute_residual_proxies(
    hidden_states_by_layer: dict,
    top_k: int = 20,
) -> dict:
    """Compute residual-stream proxy statistics for all provided layers.

    Parameters
    ----------
    hidden_states_by_layer:
        ``{layer_index: ndarray(seq_len, hidden_dim)}``.
        Pass ``{}`` for API-only providers — returns ``{"available": False}``.
    top_k:
        Eigenvalue spectrum depth forwarded to ``compute_layer_stats``.

    Returns
    -------
    dict:
        ``{"available": True, "layers": {layer_index: layer_stats}}``
        or ``{"available": False}`` when no hidden states are provided
        or numpy is absent.
    """
    if not _NUMPY_AVAILABLE:
        return {"available": False, "reason": "numpy not installed"}
    if not hidden_states_by_layer:
        return {"available": False, "reason": "no hidden states provided (API-only provider)"}

    layers = {}
    for layer_idx, hidden in hidden_states_by_layer.items():
        layers[int(layer_idx)] = compute_layer_stats(hidden, top_k=top_k)

    return {"available": True, "layers": layers}
