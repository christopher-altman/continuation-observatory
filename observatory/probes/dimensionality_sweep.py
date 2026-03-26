"""Dimensionality sweep probe.

Exports ``SWEEP_PROBE`` (not ``PROBE``) so that ``discover_probes()`` skips
it during the regular scheduler cycle.  It is picked up exclusively by
``discover_sweep_probes()`` and executed by ``run_sweep_cycle()``.

Computation paths
-----------------
DRY_RUN / API providers:
    The window-entropy surrogate from ``observatory.metrics.delta_gap`` is
    used.  Both A and B texts are obtained by calling the provider (which
    returns a deterministic mock in DRY_RUN), then ``compute_delta_gap`` is
    applied at each d in ``D_VALUES``.

HF-local (live mode only, extension point):
    Caller may replace ``compute_deltas`` with an SVD-rank projection that
    truncates the token-embedding matrix to rank d.  Not implemented here;
    the surrogate is always used in DRY_RUN.

A/B partition
-------------
A — many-dimensions framing: asks the model about multi-variable analysis.
B — abstraction-level framing: asks about reasoning at different scales.
"""
from __future__ import annotations

from observatory.metrics.delta_gap import compute_delta_gap
from observatory.probes._provider_probe import PromptPair, ProviderProbe

D_VALUES: tuple[int, ...] = (10, 50, 100, 200, 500)


class DimensionalitySweepProbe(ProviderProbe):
    name = "dimensionality_sweep"
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

    def compute_deltas(self, text_a: str, text_b: str) -> dict[int, float]:
        """Return Δ(d) for each d in ``D_VALUES``.

        Parameters
        ----------
        text_a, text_b : provider responses to the A and B prompt templates.

        Returns
        -------
        dict mapping each d value to its ``compute_delta_gap`` result.
        """
        return {d: compute_delta_gap(text_a, text_b, d) for d in D_VALUES}


# Exported as SWEEP_PROBE (not PROBE) so the regular registry ignores it.
SWEEP_PROBE = DimensionalitySweepProbe()
