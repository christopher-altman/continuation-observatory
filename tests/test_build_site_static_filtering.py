from __future__ import annotations

import json
from pathlib import Path

import yaml

from scripts import build_site


def _write_experiment(
    root: Path,
    *,
    name: str,
    provider: str,
    model_id: str,
    probe_name: str,
    entropy_delta: float,
    include_sweep: bool = False,
) -> dict[str, str]:
    exp_dir = root / "results" / name
    exp_dir.mkdir(parents=True, exist_ok=True)
    result = {
        "run_id": f"{name}-run",
        "timestamp": "2026-03-29T18:48:41.785841+00:00",
        "model_id": model_id,
        "entropy_a": 4.5,
        "entropy_b": 4.6,
        "entropy_delta": entropy_delta,
    }
    if include_sweep:
        result.update(
            {
                "delta_gap_d10": 0.12,
                "delta_gap_d50": 0.11,
                "delta_gap_d100": 0.10,
                "delta_gap_d200": 0.10,
                "delta_gap_d500": 0.10,
            }
        )
    (exp_dir / "results.json").write_text(json.dumps(result, indent=2), encoding="utf-8")
    (exp_dir / "config.yaml").write_text(
        yaml.safe_dump(
            {
                "provider": provider,
                "probe_name": probe_name,
                "model_id": model_id,
                "dry_run": False,
            }
        ),
        encoding="utf-8",
    )
    return {
        "name": name,
        "results_path": f"results/{name}/results.json",
        "config_path": f"results/{name}/config.yaml",
        "status": "complete",
        "new_matter_flag": False,
        "key_result": f"entropy_delta={entropy_delta:.4f}",
        "figures": [],
    }


def test_build_filters_disabled_models_and_keeps_active_empty_states(tmp_path, monkeypatch):
    manifest = {
        "last_updated": "2026-03-29T18:48:41.785841+00:00",
        "experiments": [
            _write_experiment(
                tmp_path,
                name="continuation_interest_openai",
                provider="openai",
                model_id="o3",
                probe_name="continuation_interest",
                entropy_delta=0.2,
            ),
            _write_experiment(
                tmp_path,
                name="dimensionality_sweep_openai",
                provider="openai",
                model_id="o3",
                probe_name="dimensionality_sweep",
                entropy_delta=0.1,
                include_sweep=True,
            ),
            _write_experiment(
                tmp_path,
                name="continuation_interest_disabled",
                provider="meta",
                model_id="mistral-large-3",
                probe_name="continuation_interest",
                entropy_delta=0.3,
            ),
        ],
    }
    results_dir = tmp_path / "results"
    results_dir.mkdir(parents=True, exist_ok=True)
    (results_dir / "manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    monkeypatch.setattr(
        build_site,
        "_safe_observatory_snapshot",
        lambda active_model_ids: {
            "generated_at": "2026-03-30T00:00:00+00:00",
            "summary": {
                "history_range": "30d",
                "tracked_models": 7,
                "live_models": 1,
                "n_models": 7,
                "focused_metric": "cii",
                "constellation_threshold": 0.60,
                "similarity_window_days": 7,
                "latest_pcii": 0.5,
                "latest_pcii_timestamp": "2026-03-30T00:00:00+00:00",
                "available_ranges": ["1h", "24h", "7d", "30d"],
            },
            "models": [{"model_id": model_id} for model_id in sorted(active_model_ids)],
            "events": [],
            "constellation": {"nodes": [], "edges": [], "threshold": 0.60, "window_days": 7},
            "pcii_series": [],
            "cii_history": {},
        },
    )

    output_dir = tmp_path / "site-output"
    build_site.build(output_dir, results_dir=results_dir)

    latest = json.loads((output_dir / "static" / "data" / "latest.json").read_text(encoding="utf-8"))
    timeseries = json.loads((output_dir / "static" / "data" / "timeseries.json").read_text(encoding="utf-8"))
    falsification = json.loads((output_dir / "static" / "data" / "falsification.json").read_text(encoding="utf-8"))
    models_data = json.loads((output_dir / "static" / "data" / "models.json").read_text(encoding="utf-8"))
    exports = json.loads(
        (output_dir / "static" / "data" / "exports" / "all_metrics.json").read_text(encoding="utf-8")
    )
    csv_export = (output_dir / "static" / "data" / "exports" / "all_metrics.csv").read_text(encoding="utf-8")
    home_html = (output_dir / "index.html").read_text(encoding="utf-8")
    models_html = (output_dir / "models.html").read_text(encoding="utf-8")
    timeseries_html = (output_dir / "timeseries.html").read_text(encoding="utf-8")
    falsification_html = (output_dir / "falsification.html").read_text(encoding="utf-8")

    latest_ids = {row["model_id"] for row in latest["models"]}
    assert latest_ids == {"o3"}
    assert "mistral-large-3" not in json.dumps(timeseries)
    assert {row["model_id"] for row in falsification["models"]} == {"o3"}
    assert all(row["model_id"] != "mistral-large-3" for row in exports)
    assert "mistral-large-3" not in csv_export

    model_rows = {row["model_id"]: row for row in models_data["models"]}
    assert list(model_rows) == [
        "claude-haiku-4-5-20251001",
        "gpt-5",
        "o3",
        "gemini-2.5-pro",
        "gemini-2.5-flash",
        "openai/gpt-oss-20b",
        "deepseek-ai/DeepSeek-R1-0528",
        "grok-4-1-fast-reasoning",
        "openai/gpt-oss-120b",
        "deepseek-ai/DeepSeek-V3.1",
        "meta-llama/Llama-3.3-70B-Instruct-Turbo",
        "Qwen/Qwen3.5-9B",
    ]
    assert model_rows["gpt-5"]["timestamp"] is None
    assert model_rows["gpt-5"]["entropy_delta"] is None
    assert model_rows["gpt-5"]["probes"] == []
    assert model_rows["openai/gpt-oss-20b"]["provider"] == "together"
    assert model_rows["grok-4-1-fast-reasoning"]["provider"] == "xai"

    assert "mistral-large-3" not in home_html
    assert "mistral-large-3" not in models_html
    assert "mistral-large-3" not in timeseries_html
    assert "mistral-large-3" not in falsification_html
    assert "gpt-5" in home_html
    assert "deepseek-ai/DeepSeek-R1-0528" in home_html
    assert "openai/gpt-oss-20b" in models_html
    assert "openai/gpt-oss-120b" in models_html
    assert "deepseek-ai/DeepSeek-R1-0528" in models_html
    assert "deepseek-ai/DeepSeek-V3.1" in models_html
    assert "meta-llama/Llama-3.3-70B-Instruct-Turbo" in models_html
    assert "Qwen/Qwen3.5-9B" in models_html
    assert "grok-4-1-fast-reasoning" in models_html
    assert "gpt-5" in models_html
    assert "gemini-2.5-pro" in models_html
