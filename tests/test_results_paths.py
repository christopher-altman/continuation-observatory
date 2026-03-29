from __future__ import annotations

from pathlib import Path

import pytest

from observatory.results_paths import RESULTS_DIR_ENV_VAR, REPO_ROOT, resolve_results_paths
from scripts.build_site import build


def test_results_paths_default_to_repo_root_results(monkeypatch):
    monkeypatch.delenv(RESULTS_DIR_ENV_VAR, raising=False)
    paths = resolve_results_paths()
    assert paths.root == (REPO_ROOT / "results").resolve()
    assert paths.manifest == (REPO_ROOT / "results" / "manifest.json").resolve()


def test_results_paths_use_env_override(monkeypatch, tmp_path):
    monkeypatch.setenv(RESULTS_DIR_ENV_VAR, str(tmp_path / "env-results"))
    paths = resolve_results_paths()
    assert paths.root == (tmp_path / "env-results").resolve()
    assert paths.manifest == (tmp_path / "env-results" / "manifest.json").resolve()


def test_results_paths_cli_override_beats_env(monkeypatch, tmp_path):
    monkeypatch.setenv(RESULTS_DIR_ENV_VAR, str(tmp_path / "env-results"))
    cli_root = tmp_path / "cli-results"
    paths = resolve_results_paths(cli_root)
    assert paths.root == cli_root.resolve()
    assert paths.manifest == (cli_root / "manifest.json").resolve()


def test_build_fails_clearly_when_manifest_is_missing(tmp_path, capsys):
    missing_results_dir = tmp_path / "missing-results"
    with pytest.raises(SystemExit) as exc_info:
        build(tmp_path / "site-output", results_dir=missing_results_dir)

    assert exc_info.value.code == 1
    captured = capsys.readouterr()
    expected_manifest = (missing_results_dir / "manifest.json").resolve()
    assert str(expected_manifest) in captured.err
    assert "Generate local results first or pass --results-dir PATH." in captured.err
