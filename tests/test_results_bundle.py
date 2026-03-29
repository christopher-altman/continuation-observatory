"""test_results_bundle — verifies results bundle writing and manifest wiring.

Two levels of coverage:
  1. Isolated unit test for write_experiment_bundle() using tmp_path.
  2. Integration test: run_cycle() must produce >= 1 manifest entry and at
     least one bundle directory with all required files on disk.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest

from observatory.results_paths import RESULTS_DIR_ENV_VAR, resolve_results_paths


# ---------------------------------------------------------------------------
# Isolated unit test
# ---------------------------------------------------------------------------

def test_write_experiment_bundle_creates_required_files(tmp_path):
    """write_experiment_bundle creates config.yaml, results.json, summary.md
    and appends an entry to the (tmp) manifest."""
    from observatory.results_writer import write_experiment_bundle

    manifest_path = tmp_path / "manifest.json"
    bundle_dir = write_experiment_bundle(
        name="test_bundle",
        results={"entropy_delta": 0.42, "entropy_a": 0.70, "entropy_b": 0.28},
        config={"probe": "test", "provider": "mock"},
        key_result="entropy_delta=0.42",
        manifest_path=manifest_path,
    )

    assert (bundle_dir / "results.json").exists(), "results.json missing"
    assert (bundle_dir / "config.yaml").exists(), "config.yaml missing"
    assert (bundle_dir / "summary.md").exists(), "summary.md missing"

    manifest = json.loads(manifest_path.read_text())
    assert len(manifest["experiments"]) == 1
    exp = manifest["experiments"][0]
    assert exp["name"] == "test_bundle"
    assert exp["status"] == "complete"
    assert exp["key_result"] == "entropy_delta=0.42"


def test_bundle_figures_png_exists(tmp_path):
    """write_experiment_bundle always creates figures/metrics.png and lists it
    in the manifest entry's figures array."""
    from observatory.results_writer import write_experiment_bundle

    manifest_path = tmp_path / "manifest.json"
    bundle_dir = write_experiment_bundle(
        name="fig_test_bundle",
        results={"entropy_a": 0.70, "entropy_b": 0.28, "entropy_delta": 0.42},
        key_result="entropy_delta=0.42",
        manifest_path=manifest_path,
    )

    png = bundle_dir / "figures" / "metrics.png"
    assert png.exists(), "figures/metrics.png was not created"
    assert png.stat().st_size > 0, "figures/metrics.png is empty"

    manifest = json.loads(manifest_path.read_text())
    exp = manifest["experiments"][0]
    assert exp["figures"], "manifest entry figures list is empty"
    assert any("metrics.png" in f for f in exp["figures"]), (
        f"metrics.png not referenced in manifest figures: {exp['figures']}"
    )


def test_write_experiment_bundle_upserts_same_name(tmp_path):
    """Calling write_experiment_bundle twice with the same name replaces the entry."""
    from observatory.results_writer import write_experiment_bundle

    manifest_path = tmp_path / "manifest.json"
    write_experiment_bundle(
        name="dup_bundle",
        results={"entropy_delta": 0.1},
        key_result="first",
        manifest_path=manifest_path,
    )
    write_experiment_bundle(
        name="dup_bundle",
        results={"entropy_delta": 0.9},
        key_result="second",
        manifest_path=manifest_path,
    )

    manifest = json.loads(manifest_path.read_text())
    assert len(manifest["experiments"]) == 1, "upsert should keep exactly one entry"
    assert manifest["experiments"][0]["key_result"] == "second"


# ---------------------------------------------------------------------------
# Integration test: scheduler → results bundle
# ---------------------------------------------------------------------------

def test_run_cycle_produces_manifest_entries(tmp_path, monkeypatch):
    """After run_cycle(), results/manifest.json must have >= 1 experiment entry
    and at least one bundle directory must have its required files on disk."""
    from observatory.scheduler.scheduler import run_cycle
    from observatory.storage.sqlite_backend import init_db

    monkeypatch.setenv(RESULTS_DIR_ENV_VAR, str(tmp_path / "results"))
    init_db()
    run_cycle()

    results_paths = resolve_results_paths()
    manifest_path = results_paths.manifest
    repo_root = results_paths.root.parent

    assert manifest_path.exists(), "manifest.json not found after run_cycle()"
    manifest = json.loads(manifest_path.read_text())
    experiments = manifest.get("experiments", [])
    assert len(experiments) >= 1, (
        f"run_cycle() produced no manifest entries; experiments={experiments}"
    )

    # At least one bundle must have its config.yaml, results.json, and a PNG on disk.
    valid_bundles = [
        exp for exp in experiments
        if (repo_root / exp.get("config_path", "___")).exists()
        and (repo_root / exp.get("results_path", "___")).exists()
    ]
    assert valid_bundles, (
        "No bundle found with both config.yaml and results.json present on disk.\n"
        f"Experiments in manifest: {[e['name'] for e in experiments]}"
    )

    # At least one manifest entry must reference a PNG that exists on disk.
    png_found = any(
        (repo_root / fig).exists()
        for exp in experiments
        for fig in exp.get("figures", [])
        if fig.endswith(".png")
    )
    assert png_found, (
        "No .png figure found on disk for any manifest entry.\n"
        f"figures fields: {[exp.get('figures') for exp in experiments]}"
    )
