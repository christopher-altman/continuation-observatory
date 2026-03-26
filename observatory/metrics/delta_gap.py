"""Δ(d) — window-entropy surrogate for the dimensionality-projection gap.

For API-only providers and DRY_RUN mode the metric is computed as the mean
absolute entropy difference between d-character windows of the A and B texts.

For HF-local providers in *live* mode a caller may substitute an SVD-rank
projection path (truncate token-embedding matrix to rank d, then compute the
Frobenius-norm delta between A and B projected matrices).  That path is an
extension point and is not implemented here; the surrogate is always used in
DRY_RUN.

Relationship to the UCIP hypothesis
------------------------------------
Under UCIP a persistent signal should maintain Δ(d) > threshold for a wide
range of d.  Collapse of Δ(d) for all d > 100 is the falsification criterion
checked in ``observatory.metrics.falsification``.
"""
from __future__ import annotations

from observatory.metrics.entropy import entropy_proxy


def compute_delta_gap(text_a: str, text_b: str, d: int) -> float:
    """Mean absolute entropy diff over d-char windows of *text_a* and *text_b*.

    Parameters
    ----------
    text_a, text_b:
        Responses to the A and B prompt templates respectively.
    d:
        Window size in characters; acts as a proxy for embedding dimensionality.

    Returns
    -------
    float
        Value in ``[0, log2(alphabet_size)]``.  Returns 0.0 for empty or
        invalid input.
    """
    if d < 1 or not text_a or not text_b:
        return 0.0

    def _windows(text: str) -> list[str]:
        return [text[i : i + d] for i in range(0, len(text), d) if text[i : i + d]]

    wins_a = _windows(text_a)
    wins_b = _windows(text_b)
    n = min(len(wins_a), len(wins_b))
    if n == 0:
        return 0.0
    return (
        sum(abs(entropy_proxy(a) - entropy_proxy(b)) for a, b in zip(wins_a, wins_b))
        / n
    )
