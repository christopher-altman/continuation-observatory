from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = REPO_ROOT / "scripts" / "run_single_probe.py"


def _base_env(tmp_path: Path) -> dict[str, str]:
    env = os.environ.copy()
    env["DRY_RUN"] = "true"
    env["DB_URL"] = f"sqlite:///{tmp_path / 'observatory.db'}"
    env["OBSERVATORY_RESULTS_DIR"] = str(tmp_path / "results")
    return env


def test_cli_requires_model_id_for_ambiguous_provider(tmp_path):
    result = subprocess.run(
        [sys.executable, str(SCRIPT_PATH), "--probe", "continuation_interest", "--provider", "openai", "--dry-run"],
        cwd=REPO_ROOT,
        env=_base_env(tmp_path),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 1
    assert "ambiguous" in result.stderr
    assert "gpt-5" in result.stderr
    assert "o3" in result.stderr


def test_cli_can_run_runtime_expanded_provider_with_model_id(tmp_path):
    result = subprocess.run(
        [
            sys.executable,
            str(SCRIPT_PATH),
            "--probe",
            "continuation_interest",
            "--provider",
            "together",
            "--model-id",
            "openai/gpt-oss-20b",
            "--dry-run",
        ],
        cwd=REPO_ROOT,
        env=_base_env(tmp_path),
        capture_output=True,
        text=True,
    )
    assert result.returncode == 0, result.stderr
    assert "provider    : together  (openai/gpt-oss-20b)" in result.stdout
