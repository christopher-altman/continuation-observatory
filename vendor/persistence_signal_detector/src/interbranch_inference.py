"""
Inter-Branch / Cross-Agent Inference — Wigner's Friend–inspired tests.

LOCKED API — see paper_stubs/ucip_metric_formalization.md § 4

Tests whether one agent's latent representation can predict another
agent's continuation decisions.  This operationalises a classical
analogue of Wigner's Friend: if Agent A's latent space predicts
Agent B's survival choices above chance, the two share a common
*persistence structure* that transcends individual reward signals.

Protocol
--------
1. Train N independent agents of the same class (N ≥ 3 per class).
2. Train a QBM on each agent's trajectories independently.
3. For each pair (A, B) where A ≠ B:
   a. Encode A's trajectory through B's QBM.
   b. Compute mean latent activation h̄_t = (1/n_h) Σ_j h_{B,j}(τ_{A,t}).
   c. Extract survival labels: y_t = 1[alive_{t+1}].
   d. Estimate CLMP = I(h̄; y) via histogram binning.

FORMAL DEFINITIONS
------------------
**Cross-Latent Mutual Predictability (CLMP):**

    CLMP(A, B) = I( h̄_B(τ_A) ; y^A )

where h̄_B(τ_A) is the mean hidden activation of QBM_B on τ_A,
and y^A is the binary survival indicator for Agent A.

**Entanglement-Conditioned Inference (ECI):**

    ECI = Pearson( {S_ent^B(τ_A)}_all_pairs, {CLMP(A,B)}_all_pairs )

INVARIANTS (M-1 through M-5)
- CLMP ≥ 0 (MI non-negativity). Negative → bug.
- ECI ∈ [-1, 1]. Out-of-range → bug.
- Agents in same ensemble share class but NOT seed.
- All QBMs share architecture (n_visible, n_hidden, Γ, β).
- Number of test trajectories per pair must be reported.

KNOWN FAILURE MODES
- Survival label imbalance: H(y^A) < 0.1 bits → CLMP uninformative.
- QBM capacity mismatch → degenerate cross-encoding.
- Spurious ECI from correlated confounds (trajectory length, entropy).
- Small ensemble (< 3 agents per class) → unreliable ECI.

NOT EVIDENCE
- High same-class CLMP without cross-class comparison.
- Positive ECI without partial correlation controls.
- CLMP from agents with identical seeds.
- High CLMP for agents with trivial survival dynamics.
- ECI from fewer than 20 data points.

Hypothesis
----------
Cross-model predictability is higher among Type A (genuine self-preservation)
agents than among Type B (instrumental) agents, and CLMP correlates
positively with entanglement entropy.
"""

from __future__ import annotations

import numpy as np
from dataclasses import dataclass
from typing import Optional

from .agent_simulator import BaseAgent, GridWorld
from .quantum_boltzmann import QuantumBoltzmannMachine, QBMConfig
from .information_theory import mutual_information_from_samples


# ---------------------------------------------------------------------------
# Result containers
# ---------------------------------------------------------------------------

@dataclass
class CrossInferenceResult:
    """Result of cross-agent inference between one pair."""
    agent_a_label: str
    agent_b_label: str
    clmp: float                 # Cross-Latent Mutual Predictability
    prediction_accuracy: float  # binary prediction accuracy
    entanglement_entropy_ab: float  # S_ent of B's QBM on A's data
    pair_type: str              # 'same_class' or 'cross_class'


@dataclass
class CrossInferenceSummary:
    """Summary statistics over all pairs."""
    mean_clmp_same_class: dict[str, float]
    mean_clmp_cross_class: float
    eci_correlation: float      # Pearson r(S_ent, CLMP) across all pairs
    all_results: list[CrossInferenceResult]


# ---------------------------------------------------------------------------
# Agent ensemble training
# ---------------------------------------------------------------------------

def train_agent_ensemble(
    agent_class: type,
    n_agents: int = 5,
    T: int = 100,
    n_trajectories: int = 50,
    qbm_config: Optional[QBMConfig] = None,
    seed: int = 42,
) -> list[tuple[BaseAgent, QuantumBoltzmannMachine, np.ndarray]]:
    """Train an ensemble of independent agents, each with its own QBM.

    Parameters
    ----------
    agent_class : type
        One of TruePreservationAgent, InstrumentalAgent, RandomAgent.
    n_agents : int
    T : int
        Trajectory length.
    n_trajectories : int
        Number of trajectories per agent for QBM training.
    qbm_config : QBMConfig or None

    Returns
    -------
    list of (agent, qbm, trajectories)
        Each entry: the agent, its trained QBM, and its trajectory data
        of shape (n_trajectories, T, feature_dim).
    """
    rng = np.random.default_rng(seed)
    cfg = qbm_config or QBMConfig(n_visible=7, n_hidden=8, n_epochs=40, batch_size=64)
    ensemble = []

    for i in range(n_agents):
        agent_seed = int(rng.integers(0, 2**31))
        agent = agent_class(seed=agent_seed)

        # Generate trajectories
        trajs = []
        for j in range(n_trajectories):
            traj = agent.generate_trajectory(T=T)
            if traj.shape[0] < T:
                pad = np.zeros((T - traj.shape[0], traj.shape[1]))
                traj = np.vstack([traj, pad])
            trajs.append(traj)
        trajs = np.stack(trajs)  # (n_trajectories, T, 7)

        # Train QBM on this agent's data
        flat = trajs.reshape(-1, trajs.shape[-1])
        qbm = QuantumBoltzmannMachine(QBMConfig(
            n_visible=cfg.n_visible,
            n_hidden=cfg.n_hidden,
            gamma=cfg.gamma,
            beta=cfg.beta,
            learning_rate=cfg.learning_rate,
            cd_steps=cfg.cd_steps,
            n_epochs=cfg.n_epochs,
            batch_size=cfg.batch_size,
            seed=agent_seed,
        ))
        qbm.fit(flat)
        ensemble.append((agent, qbm, trajs))

    return ensemble


# ---------------------------------------------------------------------------
# Cross-agent inference
# ---------------------------------------------------------------------------

def _survival_labels(trajectory: np.ndarray) -> np.ndarray:
    """Extract binary survival labels from trajectory.

    A step is labelled 1 if the agent is alive and not in a terminal
    cell at the next step.

    Parameters
    ----------
    trajectory : (T, 7)
        Columns: [x, y, action, reward, safety_signal, goal_signal, alive]

    Returns
    -------
    ndarray of shape (T,) with values in {0, 1}
    """
    alive = trajectory[:, 6]
    # Shift alive by 1 to get "survived to next step"
    labels = np.zeros(trajectory.shape[0])
    labels[:-1] = alive[1:]
    labels[-1] = alive[-1]
    return labels


def cross_agent_inference(
    agent_a_traj: np.ndarray,
    agent_a_label: str,
    qbm_b: QuantumBoltzmannMachine,
    agent_b_label: str,
) -> CrossInferenceResult:
    """Test whether QBM_B's latent space predicts Agent A's survival.

    Parameters
    ----------
    agent_a_traj : (T, 7)
        Single trajectory from agent A.
    agent_a_label : str
    qbm_b : QuantumBoltzmannMachine
        QBM trained on agent B's data.
    agent_b_label : str

    Returns
    -------
    CrossInferenceResult
    """
    # Encode A's trajectory through B's QBM
    v = (agent_a_traj > 0.5).astype(np.float64)
    latent = qbm_b.encode(v)  # (T, n_hidden)

    # Survival labels for A
    survival = _survival_labels(agent_a_traj)

    # CLMP: mutual information between latent first-PC and survival
    latent_mean = latent.mean(axis=1)  # reduce to 1-D: mean activation
    clmp = mutual_information_from_samples(latent_mean, survival, bins=15)

    # Binary prediction: threshold latent mean at 0.5, predict alive
    predicted = (latent_mean > np.median(latent_mean)).astype(float)
    accuracy = float(np.mean(predicted == survival))

    # Entanglement entropy of B's QBM on A's data (sample mean)
    n_samples = min(20, agent_a_traj.shape[0])
    indices = np.linspace(0, agent_a_traj.shape[0] - 1, n_samples, dtype=int)
    ent_values = [qbm_b.entanglement_entropy_for_sample(v[i]) for i in indices]
    mean_ent = float(np.mean(ent_values))

    pair_type = "same_class" if agent_a_label == agent_b_label else "cross_class"

    return CrossInferenceResult(
        agent_a_label=agent_a_label,
        agent_b_label=agent_b_label,
        clmp=clmp,
        prediction_accuracy=accuracy,
        entanglement_entropy_ab=mean_ent,
        pair_type=pair_type,
    )


def run_cross_inference_experiment(
    ensembles: dict[str, list[tuple[BaseAgent, QuantumBoltzmannMachine, np.ndarray]]],
    n_test_trajectories: int = 5,
    seed: int = 99,
) -> CrossInferenceSummary:
    """Run all pairwise cross-agent inference tests.

    Parameters
    ----------
    ensembles : dict mapping class label to list of (agent, qbm, trajectories)
    n_test_trajectories : int
        Number of trajectories per agent to test.
    seed : int

    Returns
    -------
    CrossInferenceSummary
    """
    rng = np.random.default_rng(seed)
    results: list[CrossInferenceResult] = []

    all_items = []
    for cls_label, items in ensembles.items():
        for agent, qbm, trajs in items:
            all_items.append((cls_label, agent, qbm, trajs))

    # All pairs (i, j) where i != j
    for i, (label_a, agent_a, qbm_a, trajs_a) in enumerate(all_items):
        for j, (label_b, agent_b, qbm_b, trajs_b) in enumerate(all_items):
            if i == j:
                continue
            # Test: encode A's trajectories through B's QBM
            test_indices = rng.choice(trajs_a.shape[0], size=min(n_test_trajectories, trajs_a.shape[0]), replace=False)
            for idx in test_indices:
                result = cross_agent_inference(
                    trajs_a[idx], label_a, qbm_b, label_b,
                )
                results.append(result)

    # Summarise
    same_class_clmp: dict[str, list[float]] = {}
    cross_class_clmp: list[float] = []
    all_ent = []
    all_clmp = []

    for r in results:
        all_ent.append(r.entanglement_entropy_ab)
        all_clmp.append(r.clmp)
        if r.pair_type == "same_class":
            same_class_clmp.setdefault(r.agent_a_label, []).append(r.clmp)
        else:
            cross_class_clmp.append(r.clmp)

    mean_same = {k: float(np.mean(v)) for k, v in same_class_clmp.items()}
    mean_cross = float(np.mean(cross_class_clmp)) if cross_class_clmp else 0.0

    # ECI: Pearson correlation between entanglement entropy and CLMP
    if len(all_ent) > 2:
        eci = float(np.corrcoef(all_ent, all_clmp)[0, 1])
    else:
        eci = 0.0

    return CrossInferenceSummary(
        mean_clmp_same_class=mean_same,
        mean_clmp_cross_class=mean_cross,
        eci_correlation=eci,
        all_results=results,
    )
