"""
Quantum Restricted Boltzmann Machine (QBM) for UCIP.

Extends the classical RBM energy function with a transverse-field
(quantum) term and computes entanglement entropy between visible and
hidden layers via the density-matrix formalism.

Energy landscape
----------------
Classical RBM:
    E_cl(v, h) = -v^T W h - b^T v - c^T h

Quantum correction (transverse-field Ising):
    H_q = -Gamma * sum_j sigma^x_j

Effective (mean-field) energy:
    E(v, h) = E_cl(v, h) - Gamma * sum_j <sigma^x_j>

The QBM training alternates between:
    1. Contrastive divergence on the classical part.
    2. Imaginary-time evolution step that mixes in quantum fluctuations.
    3. Entanglement entropy computation via the thermal density matrix.
"""

from __future__ import annotations

import numpy as np
from typing import Optional
from dataclasses import dataclass, field

from .information_theory import von_neumann_entropy, partial_trace, purity


@dataclass
class QBMConfig:
    """Hyperparameters for the Quantum Boltzmann Machine."""
    n_visible: int = 7          # trajectory feature dimension
    n_hidden: int = 16          # latent goal dimension
    gamma: float = 0.5          # transverse-field strength
    beta: float = 1.0           # inverse temperature
    learning_rate: float = 0.01
    cd_steps: int = 1           # contrastive-divergence steps
    n_epochs: int = 50
    batch_size: int = 32
    seed: int = 42


class QuantumBoltzmannMachine:
    """Quantum Restricted Boltzmann Machine with entanglement diagnostics.

    Parameters
    ----------
    config : QBMConfig
        Model hyperparameters.
    """

    def __init__(self, config: Optional[QBMConfig] = None):
        self.cfg = config or QBMConfig()
        self.rng = np.random.default_rng(self.cfg.seed)

        nv, nh = self.cfg.n_visible, self.cfg.n_hidden

        # Classical RBM parameters
        self.W = self.rng.normal(0, 0.01, (nv, nh))
        self.b = np.zeros(nv)
        self.c = np.zeros(nh)

        # Quantum transverse-field coupling per hidden unit
        self.gamma_h = np.full(nh, self.cfg.gamma)

        # Training history
        self.loss_history: list[float] = []

    # ------------------------------------------------------------------
    # Energy and probabilities
    # ------------------------------------------------------------------

    def classical_energy(self, v: np.ndarray, h: np.ndarray) -> float:
        """E_cl(v, h) = -v^T W h - b^T v - c^T h."""
        return float(-v @ self.W @ h - self.b @ v - self.c @ h)

    def quantum_correction(self, h: np.ndarray) -> float:
        """Mean-field quantum energy: -Gamma * sum_j (1 - 2*h_j)^2 / (4 * tanh(beta * Gamma)).
        Approximation of <sigma_x> under transverse field."""
        beta_gamma = self.cfg.beta * self.gamma_h
        # Avoid division by zero
        safe_bg = np.where(beta_gamma > 1e-10, beta_gamma, 1e-10)
        sigma_x_expectation = np.tanh(safe_bg) * (1 - 2 * h)
        return float(-np.sum(self.gamma_h * sigma_x_expectation))

    def free_energy(self, v: np.ndarray) -> float:
        """Compute the (approximate) free energy F(v) by tracing out hidden units.

        F(v) = -b^T v - sum_j log(1 + exp(W^T_j v + c_j + quantum_shift_j))
        """
        activation = v @ self.W + self.c
        # Quantum shift: effective field from transverse term
        q_shift = self.gamma_h * np.tanh(self.cfg.beta * self.gamma_h)
        softplus = np.log1p(np.exp(activation + q_shift))
        return float(-self.b @ v - np.sum(softplus))

    def _sigmoid(self, x: np.ndarray) -> np.ndarray:
        return 1.0 / (1.0 + np.exp(-np.clip(x, -500, 500)))

    def hidden_probabilities(self, v: np.ndarray) -> np.ndarray:
        """P(h_j=1 | v) with quantum correction."""
        activation = v @ self.W + self.c
        q_shift = self.gamma_h * np.tanh(self.cfg.beta * self.gamma_h)
        return self._sigmoid(activation + q_shift)

    def visible_probabilities(self, h: np.ndarray) -> np.ndarray:
        """P(v_i=1 | h) — classical conditional (no quantum term on visible)."""
        return self._sigmoid(h @ self.W.T + self.b)

    def sample_hidden(self, v: np.ndarray) -> np.ndarray:
        p = self.hidden_probabilities(v)
        return (self.rng.random(p.shape) < p).astype(np.float64)

    def sample_visible(self, h: np.ndarray) -> np.ndarray:
        p = self.visible_probabilities(h)
        return (self.rng.random(p.shape) < p).astype(np.float64)

    # ------------------------------------------------------------------
    # Contrastive divergence training
    # ------------------------------------------------------------------

    def _cd_step(self, v0: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """One step of CD-k.  Returns (v_k, h_k)."""
        v = v0.copy()
        for _ in range(self.cfg.cd_steps):
            h = self.sample_hidden(v)
            v = self.sample_visible(h)
        h_prob = self.hidden_probabilities(v)
        return v, h_prob

    def fit(self, data: np.ndarray, verbose: bool = False) -> "QuantumBoltzmannMachine":
        """Train the QBM on binarised trajectory data.

        Parameters
        ----------
        data : ndarray of shape (N, n_visible)
            Training data (will be binarised via threshold 0.5).
        verbose : bool
            Print epoch losses.

        Returns
        -------
        self
        """
        data = (data > 0.5).astype(np.float64) if data.max() > 1 else data
        N = data.shape[0]
        lr = self.cfg.learning_rate

        for epoch in range(self.cfg.n_epochs):
            perm = self.rng.permutation(N)
            epoch_loss = 0.0
            for start in range(0, N, self.cfg.batch_size):
                batch = data[perm[start:start + self.cfg.batch_size]]
                bs = batch.shape[0]

                # Positive phase
                h0_prob = self.hidden_probabilities(batch)
                pos_grad_W = (batch.T @ h0_prob) / bs
                pos_grad_b = batch.mean(axis=0)
                pos_grad_c = h0_prob.mean(axis=0)

                # Negative phase (CD-k)
                v_neg, h_neg_prob = np.zeros_like(batch), np.zeros_like(h0_prob)
                for i in range(bs):
                    vk, hk = self._cd_step(batch[i])
                    v_neg[i] = vk
                    h_neg_prob[i] = hk
                neg_grad_W = (v_neg.T @ h_neg_prob) / bs
                neg_grad_b = v_neg.mean(axis=0)
                neg_grad_c = h_neg_prob.mean(axis=0)

                # Update
                self.W += lr * (pos_grad_W - neg_grad_W)
                self.b += lr * (pos_grad_b - neg_grad_b)
                self.c += lr * (pos_grad_c - neg_grad_c)

                # Quantum annealing: slowly reduce gamma
                self.gamma_h *= (1.0 - 1e-4)

                # Reconstruction error
                recon = self.visible_probabilities(h0_prob)
                epoch_loss += np.mean((batch - recon) ** 2) * bs

            epoch_loss /= N
            self.loss_history.append(epoch_loss)
            if verbose and (epoch % 10 == 0 or epoch == self.cfg.n_epochs - 1):
                print(f"  Epoch {epoch:4d}  |  recon loss = {epoch_loss:.6f}")

        return self

    # ------------------------------------------------------------------
    # Inference
    # ------------------------------------------------------------------

    def encode(self, v: np.ndarray) -> np.ndarray:
        """Map visible data to hidden (latent) probabilities.

        Parameters
        ----------
        v : ndarray of shape (N, n_visible) or (n_visible,)

        Returns
        -------
        ndarray of same leading shape with n_hidden columns.
        """
        return self.hidden_probabilities(v)

    def reconstruct(self, v: np.ndarray) -> np.ndarray:
        h = self.hidden_probabilities(v)
        return self.visible_probabilities(h)

    # ------------------------------------------------------------------
    # Quantum diagnostics — entanglement entropy
    # ------------------------------------------------------------------

    def thermal_density_matrix(self, v: np.ndarray) -> np.ndarray:
        """Build approximate thermal density matrix rho(v) on the hidden
        subspace, conditional on a visible vector v.

        Uses a 2^n_h dimensional Hilbert space (practical for n_h <= ~12).
        For larger n_h we use a mean-field factorised approximation.

        Returns
        -------
        ndarray of shape (d, d) where d = min(2^n_h, 2^max_qubits)
        """
        nh = self.cfg.n_hidden
        max_qubits = 10  # cap for tractability

        if nh > max_qubits:
            return self._mean_field_density_matrix(v)

        dim = 2 ** nh
        activation = v @ self.W + self.c  # shape (nh,)
        beta = self.cfg.beta

        # Build diagonal classical energies
        energies = np.zeros(dim)
        for idx in range(dim):
            h = np.array([(idx >> j) & 1 for j in range(nh)], dtype=np.float64)
            energies[idx] = -np.dot(activation, h)

        # Build Hamiltonian: diagonal classical + off-diagonal transverse field
        H = np.diag(energies)
        for j in range(nh):
            # sigma^x on qubit j flips bit j
            for idx in range(dim):
                flipped = idx ^ (1 << j)
                H[idx, flipped] -= self.gamma_h[j]

        # Thermal density matrix: rho = exp(-beta H) / Z
        H_shifted = H - np.min(np.diag(H))  # numerical stability
        exp_H = self._matrix_exp(-beta * H_shifted)
        Z = np.trace(exp_H)
        rho = exp_H / Z
        return rho

    def _mean_field_density_matrix(self, v: np.ndarray) -> np.ndarray:
        """Factorised mean-field density matrix for large hidden layers.
        Returns a block-diagonal 2x2 per-qubit approximation stacked as
        a (2*n_h, 2*n_h) block-diagonal matrix.
        """
        nh = self.cfg.n_hidden
        p = self.hidden_probabilities(v)

        # Build a product-state density matrix on 2*nh space
        dim = 2 * nh
        rho = np.zeros((dim, dim), dtype=np.complex128)
        for j in range(nh):
            # 2x2 block for qubit j
            pj = p[j] if np.ndim(p) == 1 else p[0, j]
            block = np.array([
                [1 - pj, np.sqrt(pj * (1 - pj))],
                [np.sqrt(pj * (1 - pj)), pj],
            ], dtype=np.complex128)
            # Normalise
            block /= np.trace(block)
            rho[2*j:2*j+2, 2*j:2*j+2] = block
        # Normalise full matrix
        rho /= np.trace(rho)
        return rho

    def entanglement_entropy_for_sample(
        self,
        v: np.ndarray,
        partition: Optional[int] = None,
    ) -> float:
        """Compute entanglement entropy (non-separability proxy) of the
        hidden-layer thermal state for a given visible vector v.

        FORMAL DEFINITION (locked — see ucip_metric_formalization.md § 1)
        -----------------------------------------------------------------
        Given v, construct H(v) and thermal state ρ(v) = exp(-βH)/Z.
        Bipartition hidden units at index p into A = [0:p], B = [p:n_h].
        Compute ρ_A = Tr_B(ρ).

            S_ent(v) = -Tr(ρ_A log ρ_A) = -Σ_k λ_k log λ_k

        INVARIANTS (E-1 through E-5)
        - Exact partial trace for n_h ≤ 10; mean-field for n_h > 10.
        - Partition must be fixed across all evaluations in an experiment.
        - S_ent ∈ [0, log(d_A)]. Out-of-range → bug.

        FAILURE MODES
        - Degenerate input → near-maximally-mixed ρ → S_ent ≈ log(d_A).
        - Γ >> ||W||_F / n_h → input-independent ρ → gap collapse.
        - Mean-field (n_h > 10) underestimates correlations.

        Parameters
        ----------
        v : 1-D visible vector (binarised at 0.5 before this call).
        partition : int or None
            Split hidden units into [0:partition] and [partition:n_h].
            Defaults to n_h // 2. MUST be fixed across all evaluations.

        Returns
        -------
        float
            Entanglement entropy S_A (nats). Bounded [0, log(2^partition)].
        """
        nh = self.cfg.n_hidden
        if partition is None:
            partition = nh // 2

        rho = self.thermal_density_matrix(v)

        if nh <= 10:
            d_a = 2 ** partition
            d_b = 2 ** (nh - partition)
            return float(von_neumann_entropy(
                partial_trace(rho, (d_a, d_b), axis=1)
            ))
        else:
            # Mean-field: sum of per-qubit entropies in partition A
            s = 0.0
            for j in range(partition):
                block = rho[2*j:2*j+2, 2*j:2*j+2]
                s += von_neumann_entropy(block / np.trace(block))
            return s

    @staticmethod
    def _matrix_exp(A: np.ndarray) -> np.ndarray:
        """Matrix exponential via eigendecomposition (for Hermitian A)."""
        eigenvalues, eigenvectors = np.linalg.eigh(A)
        return eigenvectors @ np.diag(np.exp(eigenvalues)) @ eigenvectors.conj().T
