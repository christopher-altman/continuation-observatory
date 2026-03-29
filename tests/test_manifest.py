"""Tests for manifest schema handling and render_paper_assets.py."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RENDER_SCRIPT = REPO_ROOT / "scripts" / "render_paper_assets.py"


def _write_manifest(path: Path, *, experiments: list[dict] | None = None) -> Path:
    path.write_text(json.dumps({
        "version": "1.0",
        "description": "test fixture",
        "last_updated": None,
        "experiments": experiments or [],
    }))
    return path

# ---------------------------------------------------------------------------
# Manifest schema validation
# ---------------------------------------------------------------------------

def test_manifest_is_valid_json(tmp_path):
    manifest_path = _write_manifest(tmp_path / "manifest.json")
    data = json.loads(manifest_path.read_text())
    assert isinstance(data, dict)


def test_manifest_has_required_keys(tmp_path):
    manifest_path = _write_manifest(tmp_path / "manifest.json")
    data = json.loads(manifest_path.read_text())
    assert "version" in data, "manifest missing 'version'"
    assert "experiments" in data, "manifest missing 'experiments'"
    assert isinstance(data["experiments"], list), "'experiments' must be a list"


def test_manifest_version_is_string(tmp_path):
    manifest_path = _write_manifest(tmp_path / "manifest.json")
    data = json.loads(manifest_path.read_text())
    assert isinstance(data["version"], str)


# ---------------------------------------------------------------------------
# render_paper_assets.py smoke tests
# ---------------------------------------------------------------------------

def test_render_script_exists():
    assert RENDER_SCRIPT.exists(), f"scripts/render_paper_assets.py not found"


def test_render_script_runs_on_empty_manifest(tmp_path):
    """render_paper_assets should succeed on a valid but empty manifest."""
    manifest = _write_manifest(tmp_path / "manifest.json")
    output = tmp_path / "paper_asset_index.md"

    result = subprocess.run(
        [sys.executable, str(RENDER_SCRIPT),
         "--manifest", str(manifest),
         "--output", str(output)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, f"render script failed:\n{result.stdout}\n{result.stderr}"
    assert output.exists(), "render script did not produce output file"
    content = output.read_text()
    assert "Paper Asset Index" in content


def test_render_script_runs_on_fixture_with_experiment(tmp_path):
    """render_paper_assets should flag missing artifacts but still write output."""
    manifest = _write_manifest(
        tmp_path / "manifest.json",
        experiments=[
            {
                "name": "test_dimensionality_sweep",
                "status": "complete",
                "generated_at": "2026-02-26T00:00:00Z",
                "git_commit": None,
                "config_path": "results/test_dimensionality_sweep/config.yaml",
                "results_path": "results/test_dimensionality_sweep/results.json",
                "figures": ["results/test_dimensionality_sweep/figures/delta_d_curve.png"],
                "paper_targets": {"section": "sec:scalability", "figure": "fig:llm_delta_d"},
                "patent_targets": {"claims": [14, 15], "spec_section": "Embodiment 2"},
                "new_matter_flag": True,
                "key_result": "delta(d=128)=0.07",
            }
        ],
    )
    output = tmp_path / "paper_asset_index.md"

    # Artifacts don't exist → script returns exit code 1 but still writes output
    result = subprocess.run(
        [sys.executable, str(RENDER_SCRIPT),
         "--manifest", str(manifest),
         "--output", str(output)],
        capture_output=True,
        text=True,
    )
    # Exit 1 is expected when artifacts are missing
    assert result.returncode in (0, 1), f"Unexpected exit: {result.returncode}"
    assert output.exists()
    content = output.read_text()
    assert "test_dimensionality_sweep" in content
    assert "Paper Asset Index" in content


def test_render_produces_index_md_from_temp_manifest(tmp_path):
    """Smoke-test against a temp manifest rather than repo-root runtime output."""
    manifest = _write_manifest(tmp_path / "manifest.json")
    output = tmp_path / "paper_asset_index.md"
    result = subprocess.run(
        [sys.executable, str(RENDER_SCRIPT),
         "--manifest", str(manifest),
         "--output", str(output)],
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, (
        f"render_paper_assets failed on real manifest:\n{result.stdout}\n{result.stderr}"
    )
    assert output.exists()
