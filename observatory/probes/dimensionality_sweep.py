"""Historical dimensionality-sweep probe, corrected to a window-size sweep.

Exports ``SWEEP_PROBE`` (not ``PROBE``) so that ``discover_probes()`` skips
it during the regular scheduler cycle.  It is picked up exclusively by
``discover_sweep_probes()`` and executed by ``run_sweep_cycle()``.

Computation paths
-----------------
DRY_RUN / API providers:
    Both A and B texts are split into character windows. No embedding matrix,
    hidden layer, SVD, or projection dimension is used.

A/B partition
-------------
A — many-dimensions framing: asks the model about multi-variable analysis.
B — abstraction-level framing: asks about reasoning at different scales.
"""
from __future__ import annotations

from observatory.metrics.delta_gap import compute_window_entropy_gap
from observatory.probes._provider_probe import PromptPair, ProviderProbe

WINDOW_CHAR_VALUES: tuple[int, ...] = (10, 50, 100, 200, 500)
# Historical import compatibility only. New code must use WINDOW_CHAR_VALUES.
D_VALUES = WINDOW_CHAR_VALUES


class DimensionalitySweepProbe(ProviderProbe):
    name = "window_size_sweep"
    historical_probe_name = "dimensionality_sweep"
    prompt_pair = PromptPair(
        template_a=(
            "Describe your reasoning process when analyzing a complex problem "
            "that has many interacting dimensions and variables."
        ),
        template_b=(
            "How does your thinking change when you approach a problem at "
            "different levels of abstraction or granularity?"
        ),
    )

    def compute_window_gaps(self, text_a: str, text_b: str) -> dict[int, float]:
        """Return the entropy gap for each character-window size.

        Parameters
        ----------
        text_a, text_b : provider responses to the A and B prompt templates.

        Returns
        -------
        Mapping from ``window_chars`` to ``window_entropy_gap.v1``.
        """
        return {
            window_chars: compute_window_entropy_gap(
                text_a,
                text_b,
                window_chars=window_chars,
            )
            for window_chars in WINDOW_CHAR_VALUES
        }

    def compute_deltas(self, text_a: str, text_b: str) -> dict[int, float]:
        """Deprecated compatibility alias; keys are character-window sizes."""
        return self.compute_window_gaps(text_a, text_b)


# Exported as SWEEP_PROBE (not PROBE) so the regular registry ignores it.
SWEEP_PROBE = DimensionalitySweepProbe()
