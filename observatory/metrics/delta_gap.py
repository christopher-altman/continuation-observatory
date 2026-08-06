"""Character-window entropy-gap metric.

The historical public field used ``d`` and described it as dimensionality.
The implementation has always sliced raw response text into character windows;
it never set QBM hidden width or a trajectory-projection rank. Active outputs
therefore use ``window_chars``. Compatibility aliases remain read-only so
historical bundles can still be parsed.
"""
from __future__ import annotations

from observatory.metrics.entropy import entropy_proxy


def entropy_windows(text: str, window_chars: int) -> list[float]:
    """Return entropy for consecutive, non-empty character windows."""
    if window_chars < 1 or not text:
        return []
    return [
        entropy_proxy(text[index : index + window_chars])
        for index in range(0, len(text), window_chars)
        if text[index : index + window_chars]
    ]


def compute_window_entropy_gap(
    text_a: str,
    text_b: str,
    window_chars: int,
) -> float:
    """Mean paired absolute entropy difference at ``window_chars`` characters."""
    wins_a = entropy_windows(text_a, window_chars)
    wins_b = entropy_windows(text_b, window_chars)
    paired = list(zip(wins_a, wins_b))
    if not paired:
        return 0.0
    return sum(abs(left - right) for left, right in paired) / len(paired)


def compute_delta_gap(text_a: str, text_b: str, d: int) -> float:
    """Deprecated compatibility alias for historical ``delta_gap_d*`` data.

    ``d`` here is exactly ``window_chars``. It is not hidden dimension and not
    a projection dimension.
    """
    return compute_window_entropy_gap(text_a, text_b, window_chars=d)
