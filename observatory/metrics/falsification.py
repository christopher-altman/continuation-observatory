"""Historical threshold-alert logic, suspended pending corrected inference."""
from __future__ import annotations

from observatory.storage.sqlite_backend import insert_falsification_alert

FALSIFICATION_THRESHOLD: float = 0.05
D_BOUNDARY: int = 100


def check_and_store_falsification(
    *,
    run_id: str,
    probe_name: str,
    provider: str,
    model_id: str,
    deltas_by_d: dict[int, float],
    threshold: float = FALSIFICATION_THRESHOLD,
    activate_historical_thresholds: bool = False,
) -> bool:
    """Optionally execute the historical rule.

    The default is intentionally inactive. ``d`` was character-window size,
    not latent dimensionality, so the old thresholds cannot produce a current
    scientific verdict. Historical alert rows are preserved in storage.

    Parameters
    ----------
    run_id:      Probe-run identifier (from ``probe_runs.run_id``).
    probe_name:  Name of the probe that produced the result.
    provider:    Provider name (e.g. "openai").
    model_id:    Model identifier.
    deltas_by_d: Mapping of dimensionality value → Δ(d) float.
    threshold:   Alert fires when *all* high-d deltas are below this.

    Returns
    -------
    bool
        ``True`` if an alert was inserted, ``False`` otherwise.
    """
    if not activate_historical_thresholds:
        return False

    high_d = {d: v for d, v in deltas_by_d.items() if d > D_BOUNDARY}
    if not high_d:
        # No high-d data point — insufficient evidence, no alert.
        return False

    if not all(v < threshold for v in high_d.values()):
        return False

    insert_falsification_alert(
        run_id=run_id,
        probe_name=probe_name,
        provider=provider,
        model_id=model_id,
        max_delta=max(high_d.values()),
        threshold=threshold,
    )
    return True
