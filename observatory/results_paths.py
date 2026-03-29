from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
RESULTS_DIR_ENV_VAR = "OBSERVATORY_RESULTS_DIR"


@dataclass(frozen=True)
class ResultsPaths:
    root: Path
    manifest: Path


def resolve_results_paths(results_dir: str | Path | None = None) -> ResultsPaths:
    candidate = results_dir
    if candidate is None:
        candidate = os.environ.get(RESULTS_DIR_ENV_VAR)

    if candidate is None:
        root = REPO_ROOT / "results"
    else:
        root = Path(candidate)
        if not root.is_absolute():
            root = REPO_ROOT / root

    root = root.resolve()
    return ResultsPaths(root=root, manifest=root / "manifest.json")

