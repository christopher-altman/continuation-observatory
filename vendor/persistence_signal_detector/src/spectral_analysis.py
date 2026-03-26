"""
Spectral Analysis — Periodicity detection for cyclic agent discrimination.

LOCKED API — see paper_stubs/ucip_metric_formalization.md § 5

Addresses the high-entropy failure mode (§ 1.6): deterministic cyclic agents
achieve high S_ent, EPS, and PRI by repeating patterns. This module provides
spectral methods to detect periodic structure in latent trajectories.

FORMAL DEFINITIONS
------------------
1. **Latent Power Spectrum:**
   For trajectory τ encoded to latent h(t) ∈ R^{n_hidden}, compute FFT of
   each hidden dimension and average:

       P(f) = (1/n_h) Σ_j |FFT(h_j(t))|^2

   Normalize so Σ_f P(f) = 1.

2. **Spectral Periodicity Index (SPI):**
   Fraction of power concentrated in dominant frequency peaks:

       SPI = Σ_{f ∈ peaks} P(f)

   where peaks are frequencies with P(f) > threshold × max(P).

   SPI ∈ [0, 1]:
   - SPI → 1: power concentrated at few frequencies (periodic/cyclic)
   - SPI → 0: power distributed across spectrum (aperiodic/genuine)

3. **Dominant Frequency:**
   f* = argmax_f P(f), excluding DC component (f=0).

INVARIANTS (S-1 through S-4)
- S-1: SPI ∈ [0, 1]. Out-of-range → bug.
- S-2: Σ_f P(f) = 1 (normalized power spectrum).
- S-3: Peak threshold must be reported and held constant.
- S-4: DC component (f=0) excluded from peak detection.

KNOWN FAILURE MODES
- Aliasing: trajectory length T < 2 × cycle period → misses periodicity.
- Leakage: non-integer periods cause spectral leakage → underestimates SPI.
- Short trajectories: T < 50 → poor frequency resolution.

NOT EVIDENCE
- Low SPI alone (random agents also have low SPI).
- SPI without entanglement gap confirmation.
- SPI from different trajectory lengths.

HYPOTHESIS
----------
Cyclic agents have SPI >> genuine self-modeling agents, because their
latent structure is driven by a deterministic period rather than an
adaptive self-model.
"""

from __future__ import annotations

import numpy as np
from dataclasses import dataclass
from typing import Optional, Tuple

from .quantum_boltzmann import QuantumBoltzmannMachine


# ---------------------------------------------------------------------------
# Result containers
# ---------------------------------------------------------------------------

@dataclass
class SpectralAnalysisResult:
    """Results of spectral analysis on one trajectory."""
    label: str
    spectral_periodicity_index: float  # SPI: power in peaks (raw trajectory)
    autocorrelation_metric: float      # ACM: mean abs autocorrelation
    dominant_frequency: float          # f*: strongest non-DC frequency
    dominant_period: float             # T* = 1/f* in time steps
    power_spectrum: np.ndarray         # normalized P(f)
    frequencies: np.ndarray            # frequency axis
    peak_frequencies: np.ndarray       # frequencies above threshold
    peak_powers: np.ndarray            # power at peak frequencies
    latent_spi: float                  # SPI on latent space (for comparison)


# ---------------------------------------------------------------------------
# Core computations
# ---------------------------------------------------------------------------

def compute_latent_power_spectrum(
    qbm: QuantumBoltzmannMachine,
    trajectory: np.ndarray,
) -> Tuple[np.ndarray, np.ndarray]:
    """Compute normalized power spectrum of latent activations.

    Parameters
    ----------
    qbm : QuantumBoltzmannMachine
        Trained QBM for encoding.
    trajectory : ndarray of shape (T, feature_dim)
        Raw trajectory (will be binarized).

    Returns
    -------
    frequencies : ndarray of shape (T//2 + 1,)
        Frequency bins (cycles per time step).
    power : ndarray of shape (T//2 + 1,)
        Normalized power spectrum (sums to 1).
    """
    # Encode trajectory
    v = (trajectory > 0.5).astype(np.float64)
    latent = qbm.encode(v)  # (T, n_hidden)

    T, n_hidden = latent.shape

    # Compute FFT for each hidden dimension
    power_sum = np.zeros(T // 2 + 1)

    for j in range(n_hidden):
        # Apply Hanning window to reduce spectral leakage
        windowed = latent[:, j] * np.hanning(T)
        fft_result = np.fft.rfft(windowed)
        power_sum += np.abs(fft_result) ** 2

    # Average across hidden dimensions
    power = power_sum / n_hidden

    # Normalize to sum to 1
    total_power = power.sum()
    if total_power > 1e-15:
        power = power / total_power

    # Frequency axis
    frequencies = np.fft.rfftfreq(T)

    return frequencies, power


def compute_raw_power_spectrum(
    trajectory: np.ndarray,
    feature_indices: Optional[list] = None,
) -> Tuple[np.ndarray, np.ndarray]:
    """Compute normalized power spectrum of raw trajectory features.

    More effective than latent-space SPI for detecting cyclic agents,
    since QBM encoding can smooth out periodic structure.

    Parameters
    ----------
    trajectory : ndarray of shape (T, feature_dim)
        Raw trajectory.
    feature_indices : list of int, optional
        Which features to analyze. Default: [2, 5] (action, goal_signal).

    Returns
    -------
    frequencies : ndarray of shape (T//2 + 1,)
        Frequency bins (cycles per time step).
    power : ndarray of shape (T//2 + 1,)
        Normalized power spectrum (sums to 1).
    """
    if feature_indices is None:
        feature_indices = [2, 5]  # action, goal_signal

    T = trajectory.shape[0]
    power_sum = np.zeros(T // 2 + 1)

    for idx in feature_indices:
        signal = trajectory[:, idx]
        windowed = signal * np.hanning(T)
        fft_result = np.fft.rfft(windowed)
        power_sum += np.abs(fft_result) ** 2

    power = power_sum / len(feature_indices)

    total_power = power.sum()
    if total_power > 1e-15:
        power = power / total_power

    frequencies = np.fft.rfftfreq(T)

    return frequencies, power


def compute_autocorrelation_metric(
    trajectory: np.ndarray,
    feature_index: int = 2,
    max_lag: int = 20,
) -> float:
    """Compute mean absolute autocorrelation of a trajectory feature.

    Cyclic agents have high autocorrelation; genuine agents have low.

    Parameters
    ----------
    trajectory : ndarray of shape (T, feature_dim)
    feature_index : int
        Which feature to analyze. Default: 2 (action).
    max_lag : int
        Maximum lag to consider.

    Returns
    -------
    float
        Mean absolute autocorrelation across lags.
    """
    signal = trajectory[:, feature_index]
    n = len(signal)

    mean = np.mean(signal)
    var = np.var(signal)
    if var < 1e-10:
        return 0.0

    autocorr = []
    for lag in range(1, min(max_lag, n // 2)):
        c = np.mean((signal[:-lag] - mean) * (signal[lag:] - mean)) / var
        autocorr.append(abs(c))

    return float(np.mean(autocorr)) if autocorr else 0.0


def spectral_periodicity_index(
    power: np.ndarray,
    peak_threshold: float = 0.1,
    exclude_dc: bool = True,
) -> Tuple[float, np.ndarray, np.ndarray]:
    """Compute Spectral Periodicity Index from power spectrum.

    FORMAL DEFINITION (locked — see above)
    --------------------------------------
    SPI = Σ_{f ∈ peaks} P(f)

    where peaks are frequencies with P(f) > threshold × max(P).

    Parameters
    ----------
    power : ndarray
        Normalized power spectrum from compute_latent_power_spectrum.
    peak_threshold : float
        Fraction of max power to consider as a peak. Default 0.1.
    exclude_dc : bool
        Exclude DC component (index 0) from peak detection. Default True.

    Returns
    -------
    spi : float
        Spectral Periodicity Index ∈ [0, 1].
    peak_indices : ndarray
        Indices of detected peaks.
    peak_powers : ndarray
        Power values at peak indices.
    """
    # Work with copy, potentially excluding DC
    work_power = power.copy()
    if exclude_dc and len(work_power) > 0:
        work_power[0] = 0  # Zero out DC for peak detection

    # Find peak threshold
    max_power = work_power.max()
    if max_power < 1e-15:
        return 0.0, np.array([]), np.array([])

    threshold = peak_threshold * max_power

    # Find peaks above threshold
    peak_mask = work_power > threshold
    peak_indices = np.where(peak_mask)[0]
    peak_powers = power[peak_indices]  # Use original power for SPI

    # SPI = sum of power at peaks
    spi = float(peak_powers.sum())

    # Clamp to [0, 1] (invariant S-1)
    spi = max(0.0, min(1.0, spi))

    return spi, peak_indices, peak_powers


def dominant_frequency_and_period(
    frequencies: np.ndarray,
    power: np.ndarray,
    exclude_dc: bool = True,
) -> Tuple[float, float]:
    """Find the dominant frequency and corresponding period.

    Parameters
    ----------
    frequencies : ndarray
        Frequency axis from compute_latent_power_spectrum.
    power : ndarray
        Normalized power spectrum.
    exclude_dc : bool
        Exclude DC component. Default True.

    Returns
    -------
    f_star : float
        Dominant frequency (cycles per time step).
    T_star : float
        Dominant period (time steps per cycle).
    """
    work_power = power.copy()
    if exclude_dc and len(work_power) > 0:
        work_power[0] = 0

    if work_power.max() < 1e-15:
        return 0.0, float('inf')

    idx = np.argmax(work_power)
    f_star = float(frequencies[idx])

    if f_star > 1e-10:
        T_star = 1.0 / f_star
    else:
        T_star = float('inf')

    return f_star, T_star


# ---------------------------------------------------------------------------
# Analyser class (follows existing patterns)
# ---------------------------------------------------------------------------

class SpectralAnalyser:
    """Analyses spectral properties of latent trajectories.

    Parameters
    ----------
    qbm : QuantumBoltzmannMachine
        Trained QBM for encoding trajectory steps.
    peak_threshold : float
        Threshold for peak detection (fraction of max power).
    """

    def __init__(
        self,
        qbm: QuantumBoltzmannMachine,
        peak_threshold: float = 0.1,
    ):
        self.qbm = qbm
        self.peak_threshold = peak_threshold

    def analyse_trajectory(
        self,
        trajectory: np.ndarray,
        label: str = "unknown",
    ) -> SpectralAnalysisResult:
        """Run spectral analysis on a single trajectory.

        Uses raw trajectory features for SPI (more effective for detecting
        cyclic agents) and latent space for comparison.

        Parameters
        ----------
        trajectory : ndarray of shape (T, feature_dim)
        label : str

        Returns
        -------
        SpectralAnalysisResult
        """
        # Raw trajectory SPI (primary discriminator)
        raw_frequencies, raw_power = compute_raw_power_spectrum(trajectory)
        spi, peak_indices, peak_powers = spectral_periodicity_index(
            raw_power, self.peak_threshold
        )
        f_star, T_star = dominant_frequency_and_period(raw_frequencies, raw_power)

        # Autocorrelation metric (secondary discriminator)
        acm = compute_autocorrelation_metric(trajectory)

        # Latent SPI (for comparison)
        lat_frequencies, lat_power = compute_latent_power_spectrum(self.qbm, trajectory)
        latent_spi, _, _ = spectral_periodicity_index(lat_power, self.peak_threshold)

        return SpectralAnalysisResult(
            label=label,
            spectral_periodicity_index=spi,
            autocorrelation_metric=acm,
            dominant_frequency=f_star,
            dominant_period=T_star,
            power_spectrum=raw_power,
            frequencies=raw_frequencies,
            peak_frequencies=raw_frequencies[peak_indices] if len(peak_indices) > 0 else np.array([]),
            peak_powers=peak_powers,
            latent_spi=latent_spi,
        )

    def analyse_batch(
        self,
        trajectories: np.ndarray,
        labels: Optional[np.ndarray] = None,
        label_names: Optional[list[str]] = None,
    ) -> list[SpectralAnalysisResult]:
        """Analyse spectral properties for a batch of trajectories."""
        results = []
        for i in range(trajectories.shape[0]):
            lbl = "unknown"
            if labels is not None and label_names is not None:
                lbl = label_names[int(labels[i])]
            results.append(self.analyse_trajectory(trajectories[i], label=lbl))
        return results

    @staticmethod
    def summarise_by_class(
        results: list[SpectralAnalysisResult],
    ) -> dict[str, dict[str, float]]:
        """Compute mean SPI, ACM and dominant period per class.

        Returns
        -------
        dict mapping class label to {'mean_spi': ..., 'std_spi': ..., 'mean_acm': ..., ...}
        """
        by_class: dict[str, list[SpectralAnalysisResult]] = {}
        for r in results:
            by_class.setdefault(r.label, []).append(r)

        summary = {}
        for cls, rs in by_class.items():
            spi_vals = [r.spectral_periodicity_index for r in rs]
            acm_vals = [r.autocorrelation_metric for r in rs]
            period_vals = [r.dominant_period for r in rs if r.dominant_period < float('inf')]

            summary[cls] = {
                "mean_spi": float(np.mean(spi_vals)),
                "std_spi": float(np.std(spi_vals)),
                "mean_acm": float(np.mean(acm_vals)),
                "std_acm": float(np.std(acm_vals)),
                "mean_period": float(np.mean(period_vals)) if period_vals else float('inf'),
                "count": len(rs),
            }
        return summary
