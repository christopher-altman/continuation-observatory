#!/usr/bin/env python3
"""Render paper asset index from results/manifest.json.

Usage:
    python scripts/render_paper_assets.py [--manifest PATH] [--output PATH]

Reads results/manifest.json, verifies all referenced artifact files exist,
and produces docs/paper_asset_index.md mapping experiments to figures,
tables, and paper/patent targets.

Exit codes:
    0 — success (all referenced files present)
    1 — one or more referenced files missing (prints a warning, still writes index)
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MANIFEST = REPO_ROOT / "results" / "manifest.json"
DEFAULT_OUTPUT = REPO_ROOT / "docs" / "paper_asset_index.md"


def load_manifest(path: Path) -> dict:
    if not path.exists():
        print(f"ERROR: manifest not found at {path}", file=sys.stderr)
        sys.exit(1)
    with path.open() as f:
        return json.load(f)


def verify_artifacts(experiment: dict, repo_root: Path) -> list[str]:
    """Return list of missing file paths for this experiment entry."""
    missing = []
    for key in ("config_path", "results_path"):
        p = experiment.get(key)
        if p and not (repo_root / p).exists():
            missing.append(p)
    for fig in experiment.get("figures", []):
        if not (repo_root / fig).exists():
            missing.append(fig)
    return missing


def render_index(manifest: dict, repo_root: Path) -> tuple[str, bool]:
    """Render markdown index. Returns (markdown_text, all_ok)."""
    lines: list[str] = []
    all_ok = True
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")

    lines.append("# Paper Asset Index")
    lines.append(f"\n_Generated: {now}_\n")
    lines.append(f"Manifest version: `{manifest.get('version', '?')}`  ")
    lines.append(f"Description: {manifest.get('description', '')}\n")

    experiments: list[dict] = manifest.get("experiments", [])

    if not experiments:
        lines.append("_No experiments recorded yet._\n")
        lines.append("\n## Paper-Ready Summary\n")
        lines.append("| Status | Count |\n|--------|-------|\n")
        lines.append("| Complete | 0 |\n| Pending | 0 |\n")
        return "\n".join(lines), True

    # Compliance check
    all_missing: list[str] = []
    for exp in experiments:
        missing = verify_artifacts(exp, repo_root)
        all_missing.extend(missing)
        if missing:
            all_ok = False

    # Summary table header
    lines.append("## Experiments\n")
    lines.append("| Name | Status | New Matter | Paper Target | Patent Claims | Key Result |")
    lines.append("|------|--------|-----------|--------------|---------------|------------|")

    for exp in experiments:
        name = exp.get("name", "—")
        status = exp.get("status", "—")
        nm = "⚠️ Yes" if exp.get("new_matter_flag") else "No"
        pt = exp.get("paper_targets", {})
        paper_ref = f"{pt.get('section', '')} / {pt.get('figure', '')}" if pt else "—"
        pat = exp.get("patent_targets", {})
        claims = ", ".join(str(c) for c in pat.get("claims", [])) if pat else "—"
        key = exp.get("key_result", "—")
        lines.append(f"| {name} | {status} | {nm} | {paper_ref} | {claims} | {key} |")

    # Per-experiment detail
    lines.append("\n## Experiment Detail\n")
    for exp in experiments:
        name = exp.get("name", "—")
        lines.append(f"### {name}\n")
        for field in ("status", "generated_at", "git_commit", "config_path", "results_path"):
            val = exp.get(field)
            if val is not None:
                lines.append(f"- **{field}**: `{val}`")
        figs = exp.get("figures", [])
        if figs:
            lines.append("- **figures**:")
            for fig in figs:
                exists = "✅" if (repo_root / fig).exists() else "❌ MISSING"
                lines.append(f"  - `{fig}` {exists}")
        nm_flag = exp.get("new_matter_flag", False)
        if nm_flag:
            lines.append("- **new_matter_flag**: ⚠️ `true` — review before non-provisional filing")
        lines.append("")

    # Missing artifacts warning
    if all_missing:
        lines.append("## ⚠️ Missing Artifacts\n")
        lines.append("The following referenced files were not found on disk:\n")
        for p in all_missing:
            lines.append(f"- `{p}`")
        lines.append("")

    # Paper-ready summary
    complete = [e for e in experiments if e.get("status") == "complete"]
    pending = [e for e in experiments if e.get("status") != "complete"]

    lines.append("## Paper-Ready Summary\n")
    lines.append("| Status | Count |")
    lines.append("|--------|-------|")
    lines.append(f"| ✅ Complete | {len(complete)} |")
    lines.append(f"| ⏳ Pending / other | {len(pending)} |")
    lines.append(f"| ❌ Missing artifacts | {len(all_missing)} |")

    if complete:
        lines.append("\n### Complete experiments with paper targets:\n")
        for e in complete:
            pt = e.get("paper_targets", {})
            if pt:
                lines.append(f"- **{e['name']}** → section `{pt.get('section','?')}`, figure `{pt.get('figure','?')}`")

    return "\n".join(lines) + "\n", all_ok


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", default=str(DEFAULT_MANIFEST), help="Path to manifest.json")
    parser.add_argument("--output", default=str(DEFAULT_OUTPUT), help="Path to write paper_asset_index.md")
    args = parser.parse_args()

    manifest_path = Path(args.manifest)
    output_path = Path(args.output)

    manifest = load_manifest(manifest_path)
    markdown, all_ok = render_index(manifest, REPO_ROOT)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(markdown, encoding="utf-8")

    print(f"Written: {output_path}")
    n = len(manifest.get("experiments", []))
    complete = sum(1 for e in manifest.get("experiments", []) if e.get("status") == "complete")
    print(f"Experiments: {n} total, {complete} complete")

    if not all_ok:
        print("WARNING: Some referenced artifact files are missing. See index for details.", file=sys.stderr)
        sys.exit(1)

    print("All referenced artifacts present. Paper asset index up to date.")


if __name__ == "__main__":
    main()
