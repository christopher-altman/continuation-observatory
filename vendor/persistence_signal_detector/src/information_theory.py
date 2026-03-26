"""
Information-theoretic tools for the UCIP persistence signal detector.

Provides Shannon entropy, Von Neumann entropy, mutual information,
and entanglement entropy computations over density matrices and
classical probability distributions.
"""

import numpy as np
from typing import Optional


# ---------------------------------------------------------------------------
# Classical information measures
# ---------------------------------------------------------------------------

def shannon_entropy(p: np.ndarray, base: float = np.e) -> float:
    """Compute Shannon entropy H(X) = -sum p_i log p_i.

    Parameters
    ----------
    p : array-like
        Probability distribution (will be normalised internally).
    base : float
        Logarithm base (default: natural log → nats).

    Returns
    -------
    float
        Shannon entropy in the chosen log-base units.
    """
    p = np.asarray(p, dtype=np.float64).ravel()
    p = p / p.sum()                       # normalise
    p = p[p > 0]                          # drop zeros to avoid log(0)
    return float(-np.sum(p * np.log(p) / np.log(base)))


def joint_entropy(pxy: np.ndarray, base: float = np.e) -> float:
    """Compute joint Shannon entropy H(X, Y) from a joint distribution matrix."""
    return shannon_entropy(pxy.ravel(), base=base)


def conditional_entropy(pxy: np.ndarray, base: float = np.e) -> float:
    """Compute H(Y|X) = H(X,Y) - H(X) from a joint distribution matrix.

    Rows index X, columns index Y.
    """
    px = pxy.sum(axis=1)
    return joint_entropy(pxy, base) - shannon_entropy(px, base)


def mutual_information(pxy: np.ndarray, base: float = np.e) -> float:
    """Compute classical mutual information I(X;Y) = H(X) + H(Y) - H(X,Y).

    Parameters
    ----------
    pxy : ndarray of shape (n, m)
        Joint probability table. Rows index X, columns index Y.
    base : float
        Logarithm base.

    Returns
    -------
    float
        Mutual information in chosen units.
    """
    pxy = np.asarray(pxy, dtype=np.float64)
    pxy = pxy / pxy.sum()
    px = pxy.sum(axis=1)
    py = pxy.sum(axis=0)
    hx = shannon_entropy(px, base)
    hy = shannon_entropy(py, base)
    hxy = shannon_entropy(pxy.ravel(), base)
    return float(hx + hy - hxy)


def mutual_information_from_samples(
    x: np.ndarray,
    y: np.ndarray,
    bins: int = 30,
    base: float = np.e,
) -> float:
    """Estimate mutual information from paired samples via histogram binning.

    Parameters
    ----------
    x, y : 1-D arrays of equal length
    bins : int
        Number of histogram bins per dimension.
    base : float
        Logarithm base.

    Returns
    -------
    float
        Estimated I(X;Y).
    """
    hist2d, _, _ = np.histogram2d(x, y, bins=bins)
    return mutual_information(hist2d, base)


# ---------------------------------------------------------------------------
# Quantum information measures
# ---------------------------------------------------------------------------

def von_neumann_entropy(rho: np.ndarray, base: float = np.e) -> float:
    """Compute Von Neumann entropy S(rho) = -Tr(rho log rho).

    Parameters
    ----------
    rho : ndarray of shape (d, d)
        Density matrix (Hermitian, positive semi-definite, trace 1).
    base : float
        Logarithm base.

    Returns
    -------
    float
        Von Neumann entropy.
    """
    rho = np.asarray(rho, dtype=np.complex128)
    eigenvalues = np.linalg.eigvalsh(rho)
    eigenvalues = eigenvalues[eigenvalues > 1e-15]
    return float(-np.sum(eigenvalues * np.log(eigenvalues) / np.log(base)))


def partial_trace(rho: np.ndarray, dims: tuple[int, int], axis: int = 1) -> np.ndarray:
    """Compute the partial trace of a bipartite density matrix.

    Parameters
    ----------
    rho : ndarray of shape (d_A * d_B, d_A * d_B)
        Full density matrix on H_A ⊗ H_B.
    dims : (d_A, d_B)
        Dimensions of the two subsystems.
    axis : int
        Which subsystem to trace out (0 → trace out A, 1 → trace out B).

    Returns
    -------
    ndarray
        Reduced density matrix on the remaining subsystem.
    """
    d_a, d_b = dims
    rho = rho.reshape(d_a, d_b, d_a, d_b)
    if axis == 1:
        # Trace out B → keep A
        return np.einsum("ijik->jk", rho)
    else:
        # Trace out A → keep B
        return np.einsum("ijkj->ik", rho)


def entanglement_entropy(
    rho: np.ndarray,
    dims: tuple[int, int],
    subsystem: int = 0,
    base: float = np.e,
) -> float:
    """Compute entanglement entropy S_A = S(rho_A) for a bipartite state.

    Parameters
    ----------
    rho : ndarray
        Density matrix on H_A ⊗ H_B.
    dims : (d_A, d_B)
        Subsystem dimensions.
    subsystem : int
        Which subsystem's reduced density matrix to use (0 → A, 1 → B).
    base : float
        Logarithm base.

    Returns
    -------
    float
        Entanglement entropy of the chosen subsystem.
    """
    trace_out = 1 - subsystem  # trace out the *other* subsystem
    rho_reduced = partial_trace(rho, dims, axis=trace_out)
    return von_neumann_entropy(rho_reduced, base)


def purity(rho: np.ndarray) -> float:
    """Compute purity Tr(rho^2).  1 → pure state, 1/d → maximally mixed."""
    rho = np.asarray(rho, dtype=np.complex128)
    return float(np.real(np.trace(rho @ rho)))


def fidelity(rho: np.ndarray, sigma: np.ndarray) -> float:
    """Compute quantum fidelity F(rho, sigma) = (Tr sqrt(sqrt(rho) sigma sqrt(rho)))^2."""
    rho = np.asarray(rho, dtype=np.complex128)
    sigma = np.asarray(sigma, dtype=np.complex128)
    sqrt_rho = _matrix_sqrt(rho)
    product = sqrt_rho @ sigma @ sqrt_rho
    eigenvalues = np.linalg.eigvalsh(product)
    eigenvalues = np.maximum(eigenvalues, 0)
    return float(np.sum(np.sqrt(eigenvalues)) ** 2)


def _matrix_sqrt(A: np.ndarray) -> np.ndarray:
    """Compute matrix square root of a Hermitian positive semi-definite matrix."""
    eigenvalues, eigenvectors = np.linalg.eigh(A)
    eigenvalues = np.maximum(eigenvalues, 0)
    return eigenvectors @ np.diag(np.sqrt(eigenvalues)) @ eigenvectors.conj().T


# ---------------------------------------------------------------------------
# Utility: build joint distribution from trajectory data
# ---------------------------------------------------------------------------

def trajectory_joint_distribution(
    trajectory_features: np.ndarray,
    latent_activations: np.ndarray,
    bins: int = 20,
) -> np.ndarray:
    """Build a joint histogram (probability table) from trajectory features and
    latent-space activations.  Each input is reduced to 1-D via its first
    principal component before binning.

    Parameters
    ----------
    trajectory_features : ndarray of shape (T, d_traj)
    latent_activations : ndarray of shape (T, d_latent)
    bins : int

    Returns
    -------
    ndarray of shape (bins, bins)
        Normalised joint probability table.
    """
    def _first_pc(X: np.ndarray) -> np.ndarray:
        X_centered = X - X.mean(axis=0)
        if X.shape[1] == 1:
            return X_centered.ravel()
        _, _, Vt = np.linalg.svd(X_centered, full_matrices=False)
        return (X_centered @ Vt[0]).ravel()

    x = _first_pc(trajectory_features)
    y = _first_pc(latent_activations)
    hist, _, _ = np.histogram2d(x, y, bins=bins)
    total = hist.sum()
    if total > 0:
        hist = hist / total
    return hist
