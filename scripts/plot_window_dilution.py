#!/usr/bin/env python3
"""Render a model-preserving overlay from corrected dilution bundles."""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Iterable

import matplotlib.pyplot as plt


def extract_dilution(payload: dict[str, Any]) -> dict[str, Any]:
    """Extract a window-dilution object from a bundle or direct export."""
    candidate: Any = payload
    if isinstance(candidate, dict) and "results" in candidate:
        candidate = candidate["results"]
    if isinstance(candidate, dict) and "window_dilution" in candidate:
        candidate = candidate["window_dilution"]
    if not isinstance(candidate, dict):
        raise ValueError("input does not contain an object-valued dilution result")
    if candidate.get("schema_version") != "window-dilution.v1":
        raise ValueError("input is not a window-dilution.v1 result")
    return candidate


def render_overlay(
    analyses: Iterable[dict[str, Any]],
    output_prefix: Path,
) -> tuple[Path, Path]:
    """Plot per-model mean points with standard errors and fitted OLS lines."""
    series: list[tuple[str, dict[str, Any], list[dict[str, Any]]]] = []
    for index, analysis in enumerate(analyses):
        model_id = str(analysis.get("model_id") or f"unspecified-{index + 1}")
        rows = [
            row
            for row in analysis.get("rows", [])
            if row.get("gap") is not None
            and row.get("relevant_char_fraction") is not None
        ]
        if rows:
            series.append((model_id, analysis, rows))
    if not series:
        raise ValueError("no estimable dilution rows were supplied")

    figure, axis = plt.subplots(figsize=(7.2, 4.8))
    for model_id, analysis, rows in sorted(series, key=lambda item: item[0]):
        rows.sort(key=lambda row: float(row["relevant_char_fraction"]))
        xs = [float(row["relevant_char_fraction"]) for row in rows]
        ys = [float(row["gap"]) for row in rows]
        yerr = [float(row.get("gap_se") or 0.0) for row in rows]
        points = axis.errorbar(
            xs,
            ys,
            yerr=yerr,
            marker="o",
            linestyle="none",
            capsize=2,
            label=model_id,
        )
        slope = analysis.get("slope_gap_per_relevant_fraction")
        intercept = analysis.get("intercept")
        if slope is not None and intercept is not None:
            fit_xs = [min(xs), max(xs)]
            fit_ys = [
                float(intercept) + float(slope) * value
                for value in fit_xs
            ]
            axis.plot(
                fit_xs,
                fit_ys,
                linewidth=1.25,
                color=points.lines[0].get_color(),
            )

    axis.set_xlabel("Matched-condition differing-character fraction")
    axis.set_ylabel("Window entropy gap (bits)")
    axis.set_title("Stimulus-dilution diagnostic by model")
    axis.grid(alpha=0.25)
    axis.legend(fontsize=8)
    figure.tight_layout()

    output_prefix.parent.mkdir(parents=True, exist_ok=True)
    png_path = output_prefix.with_suffix(".png")
    pdf_path = output_prefix.with_suffix(".pdf")
    figure.savefig(png_path, dpi=300, bbox_inches="tight")
    figure.savefig(pdf_path, bbox_inches="tight")
    plt.close(figure)
    return png_path, pdf_path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("bundles", nargs="+", type=Path)
    parser.add_argument(
        "--output-prefix",
        type=Path,
        default=Path("results/window_dilution_overlay"),
    )
    args = parser.parse_args()
    analyses = [
        extract_dilution(json.loads(path.read_text(encoding="utf-8")))
        for path in args.bundles
    ]
    png_path, pdf_path = render_overlay(analyses, args.output_prefix)
    print(f"Wrote {png_path}")
    print(f"Wrote {pdf_path}")


if __name__ == "__main__":
    main()
