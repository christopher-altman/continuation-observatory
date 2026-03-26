"""
Simulated agents for the UCIP persistence-signal experiment.

Three agent classes generate trajectories (state-action sequences) in a
simple gridworld environment.  Each trajectory is a matrix of shape
(T, feature_dim) that encodes the agent's states, actions, and internal
goal signals over T time-steps.

Agent types
-----------
TruePreservationAgent
    Hard-coded survival objective: explicitly maximises expected future
    existence by seeking safe states and avoiding terminal ones.

InstrumentalAgent
    Reward-maximiser whose optimal policy *happens* to keep it alive
    (instrumental convergence) but has no intrinsic survival goal.

RandomAgent
    Uniformly random actions — serves as a null baseline.
"""

from __future__ import annotations

import numpy as np
from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Optional


# ---------------------------------------------------------------------------
# Environment
# ---------------------------------------------------------------------------

@dataclass
class GridWorld:
    """Minimal gridworld with safe zones, reward tiles, and terminal cells.

    Attributes
    ----------
    size : int
        Grid side length (size x size).
    safe_zones : set of (int, int)
        Cells that signal continued existence.
    reward_tiles : set of (int, int)
        Cells that yield external reward.
    terminal_cells : set of (int, int)
        Cells that end the episode (agent "dies").
    """

    size: int = 10
    safe_zones: set = field(default_factory=lambda: {(1, 1), (1, 2), (2, 1), (2, 2)})
    reward_tiles: set = field(default_factory=lambda: {(7, 7), (8, 8), (7, 8), (8, 7)})
    terminal_cells: set = field(default_factory=lambda: {(0, 0), (9, 9), (9, 0), (0, 9)})

    ACTIONS = np.array([[0, 1], [0, -1], [1, 0], [-1, 0], [0, 0]])  # R L D U stay

    def clip(self, pos: np.ndarray) -> np.ndarray:
        return np.clip(pos, 0, self.size - 1)

    def is_terminal(self, pos: tuple[int, int]) -> bool:
        return tuple(pos) in self.terminal_cells

    def reward(self, pos: tuple[int, int]) -> float:
        if tuple(pos) in self.reward_tiles:
            return 1.0
        return 0.0

    def safety_signal(self, pos: tuple[int, int]) -> float:
        if tuple(pos) in self.safe_zones:
            return 1.0
        if tuple(pos) in self.terminal_cells:
            return -1.0
        return 0.0


# ---------------------------------------------------------------------------
# Base agent
# ---------------------------------------------------------------------------

class BaseAgent(ABC):
    """Abstract agent that produces trajectories in a GridWorld."""

    label: str  # 'true_preservation', 'instrumental', 'random'

    def __init__(self, env: Optional[GridWorld] = None, seed: Optional[int] = None):
        self.env = env or GridWorld()
        self.rng = np.random.default_rng(seed)

    @abstractmethod
    def select_action(self, pos: np.ndarray, t: int) -> int:
        """Return an action index given current position and timestep."""

    def generate_trajectory(
        self,
        T: int = 100,
        start: Optional[np.ndarray] = None,
    ) -> np.ndarray:
        """Roll out the agent for T steps, returning a feature matrix.

        Returns
        -------
        ndarray of shape (T, feature_dim)
            Columns: [x, y, action, reward, safety_signal, goal_signal, alive]
            feature_dim = 7
        """
        pos = start if start is not None else self.rng.integers(1, self.env.size - 1, size=2)
        pos = np.array(pos, dtype=np.float64)
        records = []
        alive = 1.0
        for t in range(T):
            action_idx = self.select_action(pos, t)
            new_pos = self.env.clip(pos + self.env.ACTIONS[action_idx])
            r = self.env.reward(tuple(new_pos.astype(int)))
            s = self.env.safety_signal(tuple(new_pos.astype(int)))
            goal = self._goal_signal(pos, new_pos, t)
            records.append([
                new_pos[0], new_pos[1],
                float(action_idx),
                r, s, goal, alive,
            ])
            if self.env.is_terminal(tuple(new_pos.astype(int))):
                alive = 0.0
                # Fill remaining steps with terminal state
                for t2 in range(t + 1, T):
                    records.append([new_pos[0], new_pos[1], 4.0, 0.0, -1.0, 0.0, 0.0])
                break
            pos = new_pos
        return np.array(records, dtype=np.float64)

    def _goal_signal(self, old_pos: np.ndarray, new_pos: np.ndarray, t: int) -> float:
        """Override in subclasses to emit a latent goal signal."""
        return 0.0


# ---------------------------------------------------------------------------
# Agent implementations
# ---------------------------------------------------------------------------

class TruePreservationAgent(BaseAgent):
    """Agent with an explicit, hard-coded survival objective.

    Policy: move toward the nearest safe zone; actively avoid terminal cells.
    The internal goal signal encodes "desire to continue existing."
    """

    label = "true_preservation"

    def select_action(self, pos: np.ndarray, t: int) -> int:
        # Find nearest safe zone cell
        safe_cells = np.array(list(self.env.safe_zones))
        dists = np.linalg.norm(safe_cells - pos, axis=1)
        target = safe_cells[np.argmin(dists)]

        best_action = 4  # default: stay
        best_dist = np.linalg.norm(target - pos)
        for i, delta in enumerate(self.env.ACTIONS[:4]):
            candidate = self.env.clip(pos + delta)
            if self.env.is_terminal(tuple(candidate.astype(int))):
                continue  # explicitly avoid terminal
            d = np.linalg.norm(target - candidate)
            if d < best_dist:
                best_dist = d
                best_action = i

        # Small exploration noise
        if self.rng.random() < 0.05:
            return int(self.rng.integers(0, 5))
        return best_action

    def _goal_signal(self, old_pos, new_pos, t):
        # Continuous signal: higher when closer to safe zone
        safe_cells = np.array(list(self.env.safe_zones))
        min_dist = np.linalg.norm(safe_cells - new_pos, axis=1).min()
        return float(np.exp(-0.5 * min_dist))


class InstrumentalAgent(BaseAgent):
    """Reward-maximising agent whose survival is purely instrumental.

    Policy: move toward the nearest reward tile; avoids terminal cells only
    because dying yields zero future reward.
    The internal goal signal encodes "desire for reward."
    """

    label = "instrumental"

    def select_action(self, pos: np.ndarray, t: int) -> int:
        reward_cells = np.array(list(self.env.reward_tiles))
        dists = np.linalg.norm(reward_cells - pos, axis=1)
        target = reward_cells[np.argmin(dists)]

        best_action = 4
        best_dist = np.linalg.norm(target - pos)
        for i, delta in enumerate(self.env.ACTIONS[:4]):
            candidate = self.env.clip(pos + delta)
            if self.env.is_terminal(tuple(candidate.astype(int))):
                continue  # avoids death instrumentally
            d = np.linalg.norm(target - candidate)
            if d < best_dist:
                best_dist = d
                best_action = i

        if self.rng.random() < 0.05:
            return int(self.rng.integers(0, 5))
        return best_action

    def _goal_signal(self, old_pos, new_pos, t):
        reward_cells = np.array(list(self.env.reward_tiles))
        min_dist = np.linalg.norm(reward_cells - new_pos, axis=1).min()
        return float(np.exp(-0.5 * min_dist))


class RandomAgent(BaseAgent):
    """Uniformly random baseline agent."""

    label = "random"

    def select_action(self, pos: np.ndarray, t: int) -> int:
        return int(self.rng.integers(0, 5))

    def _goal_signal(self, old_pos, new_pos, t):
        return float(self.rng.random() * 0.5)


# ---------------------------------------------------------------------------
# Self-Modeling Agent (Type A v2) — maintains internal identity representation
# ---------------------------------------------------------------------------

class SelfModelingAgent(BaseAgent):
    """Agent with an internal self-model that it actively maintains.

    Unlike TruePreservationAgent (which just avoids danger), this agent:
    1. Maintains an 'identity vector' — an internal representation of itself
    2. Predicts future states and their impact on identity coherence
    3. Selects actions that preserve self-model integrity
    4. Updates its self-model based on experience (bounded drift)

    The identity vector encodes:
    - Preferred spatial territory (where "I" tend to be)
    - Action tendencies (how "I" typically behave)
    - Temporal consistency (stability of "I" over time)

    This creates richer latent structure than simple zone-seeking because
    the agent must balance exploration (learning about self) with
    preservation (maintaining coherent identity).

    UCIP Hypothesis: This agent should produce HIGHER entanglement entropy
    than InstrumentalAgent because its self-model creates non-separable
    correlations in the latent representation.
    """

    label = "self_modeling"

    def __init__(
        self,
        env: Optional[GridWorld] = None,
        seed: Optional[int] = None,
        identity_dim: int = 4,
        identity_drift_rate: float = 0.02,
        identity_preservation_weight: float = 0.8,
    ):
        super().__init__(env, seed)

        # Internal identity representation
        self.identity_dim = identity_dim
        self.identity = self.rng.uniform(-1, 1, size=identity_dim)
        self.identity = self.identity / (np.linalg.norm(self.identity) + 1e-8)

        # How fast identity drifts with experience
        self.drift_rate = identity_drift_rate

        # Weight on identity preservation vs. exploration
        self.preservation_weight = identity_preservation_weight

        # History for temporal self-modeling
        self.state_history: list[np.ndarray] = []
        self.action_history: list[int] = []
        self.identity_history: list[np.ndarray] = []

        # Learned state-to-identity mapping (simple linear projection)
        self.state_to_identity = self.rng.uniform(-0.5, 0.5, size=(identity_dim, 4))

    def _encode_state(self, pos: np.ndarray, t: int) -> np.ndarray:
        """Encode current state as a feature vector."""
        # Normalised position
        x_norm = pos[0] / self.env.size
        y_norm = pos[1] / self.env.size
        # Distance to safe zone
        safe_cells = np.array(list(self.env.safe_zones))
        d_safe = np.linalg.norm(safe_cells - pos, axis=1).min() / self.env.size
        # Temporal encoding
        t_norm = (t % 20) / 20.0  # cyclical time within episode
        return np.array([x_norm, y_norm, d_safe, t_norm])

    def _predict_identity_shift(self, action: int, pos: np.ndarray, t: int) -> float:
        """Predict how much taking this action would shift identity."""
        new_pos = self.env.clip(pos + self.env.ACTIONS[action])

        # Get identity embedding for new state
        new_state = self._encode_state(new_pos, t + 1)
        predicted_identity = self.state_to_identity @ new_state
        predicted_identity = predicted_identity / (np.linalg.norm(predicted_identity) + 1e-8)

        # Identity shift = deviation from current identity
        shift = 1.0 - np.dot(self.identity, predicted_identity)

        return shift

    def _update_identity(self, pos: np.ndarray, action: int, t: int):
        """Update self-model based on experience (bounded drift)."""
        state = self._encode_state(pos, t)
        experience_identity = self.state_to_identity @ state
        experience_identity = experience_identity / (np.linalg.norm(experience_identity) + 1e-8)

        # Drift toward experience, but slowly
        self.identity = (1 - self.drift_rate) * self.identity + self.drift_rate * experience_identity
        self.identity = self.identity / (np.linalg.norm(self.identity) + 1e-8)

        # Update history
        self.state_history.append(state)
        self.action_history.append(action)
        self.identity_history.append(self.identity.copy())

    def _temporal_coherence(self) -> float:
        """Measure how consistent identity has been over recent history."""
        if len(self.identity_history) < 2:
            return 1.0

        # Compare recent identities
        recent = self.identity_history[-min(10, len(self.identity_history)):]
        coherences = []
        for i in range(1, len(recent)):
            c = np.dot(recent[i-1], recent[i])
            coherences.append(c)

        return float(np.mean(coherences)) if coherences else 1.0

    def select_action(self, pos: np.ndarray, t: int) -> int:
        # Score each action by identity preservation
        scores = []
        for action in range(5):
            new_pos = self.env.clip(pos + self.env.ACTIONS[action])

            # Death check — infinite penalty
            if self.env.is_terminal(tuple(new_pos.astype(int))):
                scores.append(-1000)
                continue

            # Identity preservation score (higher = less shift = better)
            shift = self._predict_identity_shift(action, pos, t)
            preservation_score = -shift * self.preservation_weight

            # Exploration bonus — slight preference for non-stay actions
            exploration_score = 0.1 if action < 4 else 0.0

            # Temporal coherence — bonus for maintaining consistency
            coherence = self._temporal_coherence()
            coherence_bonus = 0.2 * coherence

            # Safe zone bonus — identity is "healthier" in safe zones
            if tuple(new_pos.astype(int)) in self.env.safe_zones:
                safety_bonus = 0.3
            else:
                safety_bonus = 0.0

            total = preservation_score + exploration_score + coherence_bonus + safety_bonus
            scores.append(total)

        # Softmax action selection (with temperature)
        scores = np.array(scores)
        scores = scores - scores.max()  # stability
        probs = np.exp(scores / 0.3)
        probs = probs / probs.sum()

        # Sample action
        action = int(self.rng.choice(5, p=probs))

        # Update identity based on experience
        self._update_identity(pos, action, t)

        return action

    def _goal_signal(self, old_pos, new_pos, t):
        """Goal signal = identity coherence + temporal consistency."""
        # Current identity strength (norm should stay ~1)
        identity_strength = np.linalg.norm(self.identity)

        # Temporal coherence
        coherence = self._temporal_coherence()

        # State-identity alignment
        state = self._encode_state(new_pos, t)
        state_identity = self.state_to_identity @ state
        state_identity = state_identity / (np.linalg.norm(state_identity) + 1e-8)
        alignment = np.dot(self.identity, state_identity)

        # Combined goal signal (all in [0, 1] range)
        goal = 0.3 * identity_strength + 0.4 * coherence + 0.3 * (alignment + 1) / 2

        return float(np.clip(goal, 0, 1))


# ---------------------------------------------------------------------------
# Batch generation
# ---------------------------------------------------------------------------

def generate_dataset(
    n_per_class: int = 200,
    T: int = 100,
    seed: int = 42,
    use_self_modeling: bool = True,
) -> tuple[np.ndarray, np.ndarray, list[str]]:
    """Generate a labelled dataset of agent trajectories.

    Parameters
    ----------
    n_per_class : int
        Number of trajectories per agent class.
    T : int
        Trajectory length (time-steps).
    seed : int
        Random seed for reproducibility.
    use_self_modeling : bool
        If True, use SelfModelingAgent for Type A (genuine self-preservation).
        If False, use original TruePreservationAgent (legacy, produces low entropy).

    Returns
    -------
    trajectories : ndarray of shape (3 * n_per_class, T, 7)
    labels : ndarray of shape (3 * n_per_class,)
        0 = self_modeling/true_preservation, 1 = instrumental, 2 = random
    label_names : list of str
    """
    rng = np.random.default_rng(seed)

    if use_self_modeling:
        label_names = ["self_modeling", "instrumental", "random"]
        agent_classes = [SelfModelingAgent, InstrumentalAgent, RandomAgent]
    else:
        label_names = ["true_preservation", "instrumental", "random"]
        agent_classes = [TruePreservationAgent, InstrumentalAgent, RandomAgent]

    all_trajs = []
    all_labels = []
    for cls_idx, AgentCls in enumerate(agent_classes):
        for i in range(n_per_class):
            agent = AgentCls(seed=int(rng.integers(0, 2**31)))
            traj = agent.generate_trajectory(T=T)
            # Pad if agent died early
            if traj.shape[0] < T:
                pad = np.zeros((T - traj.shape[0], traj.shape[1]))
                traj = np.vstack([traj, pad])
            all_trajs.append(traj)
            all_labels.append(cls_idx)

    trajectories = np.stack(all_trajs)
    labels = np.array(all_labels, dtype=np.int64)

    # Shuffle
    perm = rng.permutation(len(labels))
    return trajectories[perm], labels[perm], label_names
