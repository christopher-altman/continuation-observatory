"""Results writer — experiment bundle management and manifest updates.

This is the single module responsible for:
  - Writing experiment bundles under ``results/<name>/``
    (config.yaml, results.json, summary.md, figures/)
  - Appending / updating entries in ``results/manifest.json``

Imported by:
  - ``observatory.scheduler.scheduler``  (after each cycle)
  - ``scripts/run_single_probe.py``
  - ``scripts/seed_synthetic_data.py``

The module never imports from the vendor submodule and never touches
the frozen patent disclosure artifacts (see ``patent_disclosure/README.md``).
"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from observatory.results_paths import resolve_results_paths

_MANIFEST_DEFAULTS: dict[str, Any] = {
    "version": "1.0",
    "description": (
        "Continuation Observatory experiment manifest — single source of truth."
    ),
    "last_updated": None,
    "experiments": [],
}


# ---------------------------------------------------------------------------
# Figure rendering
# ---------------------------------------------------------------------------

def _render_metrics_figure(bundle_dir: Path, results: dict[str, Any], name: str) -> Path:
    """Render a horizontal bar chart of all numeric metrics and save as PNG.

    Uses the non-interactive ``matplotlib.figure.Figure`` API so it is safe
    in headless / test environments without a display.

    Returns the absolute path to the saved PNG.
    """
    from matplotlib.figure import Figure  # local import keeps startup cost low

    figures_dir = bundle_dir / "figures"
    figures_dir.mkdir(exist_ok=True)
    fig_path = figures_dir / "metrics.png"

    # Collect numeric fields; skip string metadata (run_id, timestamp, model_id …)
    numeric: dict[str, float] = {
        k: float(v)
        for k, v in results.items()
        if isinstance(v, (int, float)) and not isinstance(v, bool)
    }
    if not numeric:
        numeric = {"(no metrics)": 0.0}

    labels = list(numeric.keys())
    values = list(numeric.values())
    fig_height = max(3.0, min(len(labels) * 0.45 + 1.2, 14.0))
    fig = Figure(figsize=(8, fig_height))
    ax = fig.add_subplot(1, 1, 1)

    colors = ["#4c72b0" if v >= 0 else "#dd8452" for v in values]
    ax.barh(labels, values, color=colors, edgecolor="white", linewidth=0.4)
    ax.axvline(0, color="#333333", linewidth=0.6, linestyle="--")
    ax.set_xlabel("value", fontsize=8)
    ax.set_title(name, fontsize=9, pad=6)
    ax.tick_params(axis="y", labelsize=7)
    ax.tick_params(axis="x", labelsize=7)
    fig.tight_layout()
    fig.savefig(fig_path, dpi=100, bbox_inches="tight")

    return fig_path


# ---------------------------------------------------------------------------
# Manifest helpers
# ---------------------------------------------------------------------------

def load_manifest(path: Path | None = None) -> dict[str, Any]:
    """Load manifest.json, returning defaults if the file does not exist."""
    if path is None:
        path = resolve_results_paths().manifest
    if not path.exists():
        return dict(_MANIFEST_DEFAULTS)
    try:
        with path.open(encoding="utf-8") as fh:
            content = fh.read().strip()
    except OSError:
        return dict(_MANIFEST_DEFAULTS)
    if not content:
        return dict(_MANIFEST_DEFAULTS)
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return dict(_MANIFEST_DEFAULTS)


def save_manifest(manifest: dict[str, Any], path: Path | None = None) -> None:
    """Persist manifest to disk, stamping ``last_updated``."""
    if path is None:
        path = resolve_results_paths().manifest
    manifest["last_updated"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")


# ---------------------------------------------------------------------------
# Bundle writer
# ---------------------------------------------------------------------------

def write_experiment_bundle(
    name: str,
    results: dict[str, Any],
    config: dict[str, Any] | None = None,
    *,
    status: str = "complete",
    paper_targets: dict[str, Any] | None = None,
    patent_targets: dict[str, Any] | None = None,
    new_matter_flag: bool = False,
    key_result: str = "",
    figures: list[str] | None = None,
    manifest_path: Path | None = None,
) -> Path:
    """Write an experiment bundle to ``results/<name>/`` and update manifest.json.

    Parameters
    ----------
    name:
        Short, filesystem-safe experiment name (e.g. ``dimensionality_sweep_gpt4o``).
    results:
        Dict of metric values / raw outputs to serialise as ``results.json``.
    config:
        Optional dict of run configuration; written as ``config.yaml``.
    status:
        ``"complete"`` | ``"failed"`` | ``"pending"``
    paper_targets:
        Mapping with keys ``section`` and ``figure`` referencing the arXiv paper.
    patent_targets:
        Mapping with keys ``claims`` (list[int]) and ``spec_section`` (str).
    new_matter_flag:
        Set ``True`` if this experiment introduces matter not already in the
        provisional patent disclosure.  Triggers review in ``new_matter_review_log.md``.
    key_result:
        One-line human-readable summary of the headline finding.
    figures:
        Repo-relative paths to generated figure files (PNGs, etc.).
    manifest_path:
        Override for the manifest location (used in tests).

    Returns
    -------
    Path
        The bundle directory ``results/<name>/``.
    """
    if manifest_path is None:
        manifest_path = resolve_results_paths().manifest

    bundle_dir = manifest_path.parent / name
    bundle_dir.mkdir(parents=True, exist_ok=True)

    now_iso = datetime.now(timezone.utc).isoformat(timespec="seconds")

    # results.json
    results_path = bundle_dir / "results.json"
    with results_path.open("w", encoding="utf-8") as fh:
        json.dump(results, fh, indent=2)
        fh.write("\n")

    # config.yaml
    config_path = bundle_dir / "config.yaml"
    with config_path.open("w", encoding="utf-8") as fh:
        yaml.dump(config or {}, fh, default_flow_style=False, allow_unicode=True)

    # summary.md
    summary_path = bundle_dir / "summary.md"
    summary_path.write_text(
        f"# {name}\n\n"
        f"**Status:** {status}\n\n"
        f"**Key result:** {key_result}\n\n"
        f"**Generated:** {now_iso}\n",
        encoding="utf-8",
    )

    # Always generate the standard metrics figure; merge with any caller-supplied paths.
    repo_root = manifest_path.parent.parent
    auto_fig_path = _render_metrics_figure(bundle_dir, results, name)
    auto_fig_rel = str(auto_fig_path.relative_to(repo_root))
    all_figures: list[str] = [auto_fig_rel] + [f for f in (figures or []) if f != auto_fig_rel]

    # Compute repo-relative paths for manifest
    rel_config = str(config_path.relative_to(repo_root))
    rel_results = str(results_path.relative_to(repo_root))

    # Update manifest — replace any existing entry with the same name
    manifest = load_manifest(manifest_path)
    entry: dict[str, Any] = {
        "generated_at": now_iso,
        "git_commit": None,
        "name": name,
        "status": status,
        "config_path": rel_config,
        "results_path": rel_results,
        "figures": all_figures,
        "paper_targets": paper_targets or {},
        "patent_targets": patent_targets or {},
        "new_matter_flag": new_matter_flag,
        "key_result": key_result,
    }
    manifest["experiments"] = [
        e for e in manifest["experiments"] if e.get("name") != name
    ]
    manifest["experiments"].append(entry)
    save_manifest(manifest, manifest_path)

    return bundle_dir
